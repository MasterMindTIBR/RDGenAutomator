import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { buildRequestInputSchema, brandingConfigurationSchema, composeResolvedJobConfiguration, presetConfigurationSchema, rustDeskServerConfigurationSchema, validatePngBase64, type AppEnvironment, type BuildRequestInput, type EncryptionService, type Platform, type Profile, type ProtectedValue } from '@rdgen/domain';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit.service.js';

type ServerRow = ProtectedValue & { id: string; name: string; keyId: string };
type PresetRow = { id: string; profile: Profile; configuration: unknown };
type BrandingRow = { id: string; name: string; companyName: string; androidApplicationId: string | null; theme: 'light' | 'dark' | 'system'; themeScope: 'default' | 'override'; iconStorageKey: string | null; logoStorageKey: string | null; privacyStorageKey: string | null };
type StoredImage = { bytes: Buffer; width: number; height: number; storageKey: string };
export type PublicRequest = { id: string; visibility: 'private' | 'published'; displayName: string; technicalName: string; createdAt: Date; updatedAt: Date };
type Actor = { userId: string; role: string };
type DraftImage = Omit<StoredImage, 'storageKey'>;
type DraftImages = Partial<Record<'icon' | 'logo' | 'privacyScreen', DraftImage>>;
type CloneDraftRow = { token: string; actorId: string; sourceRequestId: string; serverId: string; brandingId: string | null; companyId: string | null; presets: Record<Profile, string | undefined>; profiles: Profile[]; platforms: Platform[]; version: string; displayName: string; technicalName: string; iconKey: string | null; logoKey: string | null; privacyKey: string | null; iconMissing: boolean; logoMissing: boolean; privacyMissing: boolean; consumedAt: Date | null; expiresAt: Date };
export type CloneDraft = { token: string; sourceRequestId: string; serverId: string; brandingId: string | null; companyId: string | null; presets: Record<Profile, string | undefined>; profiles: Profile[]; platforms: Platform[]; version: string; displayName: string; technicalName: string; images: Partial<Record<'icon' | 'logo' | 'privacy', string>>; missing: { icon: boolean; logo: boolean; privacy: boolean } };

@Injectable()
export class RequestsService {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool, @Inject('APP_ENVIRONMENT') private readonly environment: AppEnvironment, @Inject('ENCRYPTION_SERVICE') private readonly encryption: EncryptionService) {}

  async create(actorId: string, idempotencyKey: string, body: unknown): Promise<{ request: PublicRequest; jobs: Array<Record<string, unknown>> }> {
    const parsed = buildRequestInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Build request contains invalid typed configuration.');
    const input = parsed.data; const uploaded = this.images(input); const client = await this.pool.connect(); const written: string[] = [];
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('rdgen-build-request:' || $1 || ':' || $2))", [actorId, idempotencyKey]);
      const existing = await client.query<{ id: string }>('SELECT id FROM build_requests WHERE creator_id = $1 AND idempotency_key = $2', [actorId, idempotencyKey]);
      if (existing.rowCount) { const result = await this.present(client, existing.rows[0].id); await client.query('COMMIT'); return result; }
      if (input.cloneToken) { const cloneImages = await this.consumeCloneDraft(client, actorId, input.cloneToken, uploaded); for (const slot of Object.keys(cloneImages) as Array<keyof DraftImages>) { const image = cloneImages[slot]; if (image) uploaded[slot] = image; } }

      const server = await this.server(client, input.serverId); const presets = await this.presets(client, input); const branding = await this.branding(client, input.brandingId);
      const retention = await client.query<{ days: number }>('SELECT logo_retention_days AS days FROM system_settings WHERE id = true'); const retentionDays = retention.rows[0]?.days ?? 30;
      const requestImages = this.storageImages(uploaded); const requestId = (await client.query<{ id: string }>(
        `INSERT INTO build_requests (creator_id, display_name, technical_name, idempotency_key, server_id, branding_id, company_id,
          icon_storage_key, icon_content_type, icon_bytes, icon_width, icon_height, icon_retention_expires_at,
          logo_storage_key, logo_content_type, logo_bytes, logo_width, logo_height, logo_retention_expires_at,
          privacy_storage_key, privacy_content_type, privacy_bytes, privacy_width, privacy_height, privacy_retention_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $8::text IS NULL THEN NULL ELSE now() + ($13 * interval '1 day') END,
          $14, $15, $16, $17, $18, CASE WHEN $14::text IS NULL THEN NULL ELSE now() + ($13 * interval '1 day') END,
          $19, $20, $21, $22, $23, CASE WHEN $19::text IS NULL THEN NULL ELSE now() + ($13 * interval '1 day') END) RETURNING id`,
        [actorId, input.displayName, input.technicalName, idempotencyKey, server.id, branding?.id ?? null, input.companyId ?? null,
          requestImages.icon?.storageKey ?? null, requestImages.icon ? 'image/png' : null, requestImages.icon?.bytes.byteLength ?? null, requestImages.icon?.width ?? null, requestImages.icon?.height ?? null, retentionDays,
          requestImages.logo?.storageKey ?? null, requestImages.logo ? 'image/png' : null, requestImages.logo?.bytes.byteLength ?? null, requestImages.logo?.width ?? null, requestImages.logo?.height ?? null,
          requestImages.privacyScreen?.storageKey ?? null, requestImages.privacyScreen ? 'image/png' : null, requestImages.privacyScreen?.bytes.byteLength ?? null, requestImages.privacyScreen?.width ?? null, requestImages.privacyScreen?.height ?? null]
      )).rows[0].id;
      await this.writeImages(requestImages, written);
      const effective = { icon: requestImages.icon?.storageKey ?? branding?.iconStorageKey ?? undefined, logo: requestImages.logo?.storageKey ?? branding?.logoStorageKey ?? undefined, privacyScreen: requestImages.privacyScreen?.storageKey ?? branding?.privacyStorageKey ?? undefined };
      for (const profile of input.profiles) for (const platform of input.platforms) {
        const password = input.profilePasswords?.[profile] ?? input.permanentPassword ?? '';
        const composed = composeResolvedJobConfiguration({ request: input, platform, version: input.version, password, server: server.configuration, preset: presets.get(profile)!.configuration, ...(branding ? { branding: brandingConfigurationSchema.parse({ name: branding.name, companyName: branding.companyName, ...(branding.androidApplicationId ? { androidApplicationId: branding.androidApplicationId } : {}), theme: branding.theme, themeScope: branding.themeScope }) } : {}), iconStorageKey: effective.icon, logoStorageKey: effective.logo, privacyStorageKey: effective.privacyScreen });
        const protectedValue = this.encryption.encrypt(JSON.stringify(composed.resolved));
        const protectedRecord = await client.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('resolved-build-job-configuration', $1, $2, $3) RETURNING id`, [protectedValue.ciphertext, protectedValue.integrity, protectedValue.keyId]);
        const job = await client.query<{ id: string }>(`INSERT INTO build_jobs (request_id, profile, platform, version, preset_id, status, resolved_configuration_protected_id, configuration_redacted) VALUES ($1, $2, $3, $4, $5, 'enfileirado', $6, $7::jsonb) RETURNING id`, [requestId, profile, platform, input.version, presets.get(profile)!.id, protectedRecord.rows[0].id, JSON.stringify(composed.redacted)]);
        await client.query(`INSERT INTO job_outbox (job_id, kind, idempotency_key) VALUES ($1, 'dispatch', $2) ON CONFLICT (idempotency_key) DO NOTHING`, [job.rows[0].id, `request:${requestId}:job:${job.rows[0].id}:dispatch`]);
      }
      await new AuditService(client).record(actorId, 'build_request.created', 'build_request', requestId, { profiles: input.profiles.length, platforms: input.platforms.length, jobs: input.profiles.length * input.platforms.length });
      const result = await this.present(client, requestId); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); await Promise.all(written.map((path) => unlink(path).catch(() => undefined))); throw error; }
    finally { client.release(); }
  }

  /** Creates an actor-bound, one-time clone draft that copies the source's effective image bytes. */
  async createCloneDraft(actor: Actor, sourceId: string): Promise<{ token: string }> {
    const client = await this.pool.connect(); const written: string[] = [];
    try {
      await client.query('BEGIN');
      const source = await client.query<{ id: string; creatorId: string; visibility: 'private' | 'published'; displayName: string; technicalName: string; serverId: string; brandingId: string | null; companyId: string | null; iconKey: string | null; logoKey: string | null; privacyKey: string | null }>(
        `SELECT id, creator_id AS "creatorId", visibility, display_name AS "displayName", technical_name AS "technicalName", server_id AS "serverId", branding_id AS "brandingId", company_id AS "companyId", icon_storage_key AS "iconKey", logo_storage_key AS "logoKey", privacy_storage_key AS "privacyKey" FROM build_requests WHERE id = $1 FOR UPDATE`, [sourceId]);
      if (!source.rowCount) throw new NotFoundException('Build request not found.');
      await this.assertCloneAudience(client, actor, source.rows[0]);
      const jobs = await client.query<{ profile: Profile; platform: Platform; version: string; presetId: string }>(`SELECT profile, platform, version, preset_id AS "presetId" FROM build_jobs WHERE request_id = $1`, [sourceId]);
      if (!jobs.rowCount) throw new BadRequestException('Esta solicitação não possui jobs para clonar.');
      const branding = await this.branding(client, source.rows[0].brandingId ?? undefined);
      const profileOrder: Profile[] = ['full', 'qs'];
      const platformOrder: Platform[] = ['windows', 'windows-x86', 'linux', 'android', 'macos'];
      const profiles = profileOrder.filter((profile) => jobs.rows.some((job) => job.profile === profile));
      const platforms = platformOrder.filter((os) => jobs.rows.some((job) => job.platform === os));
      const presets: Record<string, string> = {};
      for (const job of jobs.rows) presets[job.profile] = job.presetId;
      const sourceKeys = {
        icon: source.rows[0].iconKey ?? branding?.iconStorageKey ?? null,
        logo: source.rows[0].logoKey ?? branding?.logoStorageKey ?? null,
        privacyScreen: source.rows[0].privacyKey ?? branding?.privacyStorageKey ?? null
      };
      const slots = ['icon', 'logo', 'privacyScreen'] as const;
      const draftKeys: Record<string, string | null> = {}; const missing: Record<string, boolean> = {};
      for (const slot of slots) {
        const key = sourceKeys[slot];
        if (!key) { draftKeys[slot] = null; missing[slot] = false; continue; }
        const draftKey = `request-images/clone/${randomUUID()}.png`;
        const destination = join(this.environment.APP_STORAGE_PATH, draftKey);
        try { await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 }); await writeFile(destination, await readFile(join(this.environment.APP_STORAGE_PATH, key)), { mode: 0o600, flag: 'wx' }); draftKeys[slot] = draftKey; missing[slot] = false; written.push(destination); }
        catch { draftKeys[slot] = null; missing[slot] = true; }
      }
      const token = randomUUID();
      await client.query(
        `INSERT INTO clone_drafts (token, actor_id, source_request_id, server_id, branding_id, company_id, presets, profiles, platforms, version, display_name, technical_name, icon_storage_key, logo_storage_key, privacy_storage_key, icon_missing, logo_missing, privacy_missing, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now() + interval '15 minutes')`,
        [token, actor.userId, sourceId, source.rows[0].serverId, source.rows[0].brandingId, source.rows[0].companyId, JSON.stringify(presets), profiles, platforms, jobs.rows[0].version, source.rows[0].displayName, source.rows[0].technicalName, draftKeys.icon, draftKeys.logo, draftKeys.privacyScreen, missing.icon, missing.logo, missing.privacyScreen]);
      await new AuditService(client).record(actor.userId, 'build_request.clone_draft', 'build_request', sourceId, { token });
      await client.query('COMMIT');
      return { token };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); await Promise.all(written.map((path) => unlink(path).catch(() => undefined))); throw error; }
    finally { client.release(); }
  }

  async getCloneDraft(userId: string, token: string): Promise<CloneDraft> {
    const client = await this.pool.connect();
    try {
      const row = await client.query<CloneDraftRow>(
        `SELECT token, actor_id AS "actorId", source_request_id AS "sourceRequestId", server_id AS "serverId", branding_id AS "brandingId", company_id AS "companyId", presets, profiles, platforms, version, display_name AS "displayName", technical_name AS "technicalName", icon_storage_key AS "iconKey", logo_storage_key AS "logoKey", privacy_storage_key AS "privacyKey", icon_missing AS "iconMissing", logo_missing AS "logoMissing", privacy_missing AS "privacyMissing", consumed_at AS "consumedAt", expires_at AS "expiresAt"
         FROM clone_drafts WHERE token = $1 AND actor_id = $2 AND consumed_at IS NULL AND expires_at > now()`, [token, userId]);
      if (!row.rowCount) throw new NotFoundException('Clone draft not found or expired.');
      const draft = row.rows[0];
      const keys = { icon: draft.iconKey, logo: draft.logoKey, privacy: draft.privacyKey };
      const images: Partial<Record<'icon' | 'logo' | 'privacy', string>> = {};
      for (const slot of ['icon', 'logo', 'privacy'] as const) {
        if (keys[slot]) {
          try { images[slot] = `data:image/png;base64,${(await readFile(join(this.environment.APP_STORAGE_PATH, keys[slot]!))).toString('base64')}`; } catch { /* unreadable copy is reported through `missing` */ }
        }
      }
      return {
        token: draft.token, sourceRequestId: draft.sourceRequestId, serverId: draft.serverId, brandingId: draft.brandingId, companyId: draft.companyId, presets: draft.presets, profiles: draft.profiles, platforms: draft.platforms, version: draft.version, displayName: draft.displayName, technicalName: draft.technicalName, images,
        missing: { icon: draft.iconMissing || (keys.icon !== null && !images.icon), logo: draft.logoMissing || (keys.logo !== null && !images.logo), privacy: draft.privacyMissing || (keys.privacy !== null && !images.privacy) }
      };
    } finally { client.release(); }
  }

  /** Consumes a one-time clone token, copying the draft's copied bytes into the new request's upload set. */
  private async consumeCloneDraft(client: PoolClient, actorId: string, token: string, uploaded: DraftImages): Promise<DraftImages> {
    const draft = await client.query<{ iconKey: string | null; logoKey: string | null; privacyKey: string | null; iconMissing: boolean; logoMissing: boolean; privacyMissing: boolean }>(
      `SELECT icon_storage_key AS "iconKey", logo_storage_key AS "logoKey", privacy_storage_key AS "privacyKey", icon_missing AS "iconMissing", logo_missing AS "logoMissing", privacy_missing AS "privacyMissing"
       FROM clone_drafts WHERE token = $1 AND actor_id = $2 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`, [token, actorId]);
    if (!draft.rowCount) throw new BadRequestException('O token de clonagem é inválido, já foi usado ou expirou.');
    const row = draft.rows[0];
    const keys = { icon: row.iconKey, logo: row.logoKey, privacyScreen: row.privacyKey };
    const missing = { icon: row.iconMissing, logo: row.logoMissing, privacyScreen: row.privacyMissing };
    const result: DraftImages = {};
    for (const slot of ['icon', 'logo', 'privacyScreen'] as const) {
      if (uploaded[slot]) { result[slot] = uploaded[slot]; continue; }
      const key = keys[slot];
      if (!key || missing[slot]) continue;
      try { result[slot] = validatePngBase64((await readFile(join(this.environment.APP_STORAGE_PATH, key))).toString('base64')); }
      catch { throw new BadRequestException('A imagem do clone expirou ou está indisponível. Refaça a clonagem.'); }
    }
    await client.query(`UPDATE clone_drafts SET consumed_at = now(), updated_at = now() WHERE token = $1`, [token]);
    return result;
  }

  private async assertCloneAudience(client: PoolClient, actor: Actor, resource: { id: string; creatorId: string; visibility: 'private' | 'published' }): Promise<void> {
    if (actor.role === 'administrator' || resource.creatorId === actor.userId) return;
    if (resource.visibility !== 'published') throw new NotFoundException('Resource not found.');
    const audience = await client.query<{ hasAudience: boolean; inAudience: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM request_audiences ra WHERE ra.request_id = $1) AS "hasAudience",
              EXISTS(SELECT 1 FROM request_audiences ra WHERE ra.request_id = $1 AND (ra.user_id = $2 OR ra.group_id IN (SELECT group_id FROM group_members gm WHERE gm.user_id = $2))) AS "inAudience"`,
      [resource.id, actor.userId]
    );
    if (audience.rows[0]?.hasAudience && !audience.rows[0]?.inAudience) throw new NotFoundException('Resource not found.');
  }

  private images(input: BuildRequestInput): Partial<Record<'icon' | 'logo' | 'privacyScreen', Omit<StoredImage, 'storageKey'>>> {
    const result: Partial<Record<'icon' | 'logo' | 'privacyScreen', Omit<StoredImage, 'storageKey'>>> = {};
    for (const slot of ['icon', 'logo', 'privacyScreen'] as const) if (input.images?.[slot]) {
      try { result[slot] = validatePngBase64(input.images[slot].dataBase64); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : `Invalid PNG ${slot}.`); }
    }
    return result;
  }
  private storageImages(images: Partial<Record<'icon' | 'logo' | 'privacyScreen', Omit<StoredImage, 'storageKey'>>>): Partial<Record<'icon' | 'logo' | 'privacyScreen', StoredImage>> {
    const result: Partial<Record<'icon' | 'logo' | 'privacyScreen', StoredImage>> = {};
    for (const slot of ['icon', 'logo', 'privacyScreen'] as const) if (images[slot]) result[slot] = { ...images[slot], storageKey: `request-images/${slot}/${randomUUID()}.png` };
    return result;
  }
  private async writeImages(images: Partial<Record<'icon' | 'logo' | 'privacyScreen', StoredImage>>, written: string[]) {
    for (const image of Object.values(images)) if (image) { const path = join(this.environment.APP_STORAGE_PATH, image.storageKey); await mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); await writeFile(path, image.bytes, { mode: 0o600, flag: 'wx' }); written.push(path); }
  }
  private async branding(client: PoolClient, id: string | undefined): Promise<BrandingRow | undefined> {
    if (!id) return undefined;
    const result = await client.query<BrandingRow>(`SELECT id, name, company_name AS "companyName", android_application_id AS "androidApplicationId", theme, theme_scope AS "themeScope", icon_storage_key AS "iconStorageKey", logo_storage_key AS "logoStorageKey", privacy_storage_key AS "privacyStorageKey" FROM brandings WHERE id = $1`, [id]);
    if (!result.rowCount) throw new BadRequestException('Selected branding is unavailable.'); return result.rows[0];
  }
  private async server(client: PoolClient, id: string) {
    const result = await client.query<ServerRow>(`SELECT s.id, s.name, p.ciphertext, p.integrity, p.key_id AS "keyId" FROM rustdesk_servers s JOIN protected_records p ON p.id = s.configuration_protected_id WHERE s.id = $1`, [id]);
    if (!result.rowCount) throw new BadRequestException('Selected RustDesk server is unavailable.'); let raw: unknown;
    try { raw = JSON.parse(this.encryption.decrypt(result.rows[0]).toString('utf8')); } catch { throw new BadRequestException('Selected RustDesk server configuration is unavailable.'); }
    const configuration = rustDeskServerConfigurationSchema.safeParse(raw); if (!configuration.success) throw new BadRequestException('Selected RustDesk server configuration is invalid.'); return { id: result.rows[0].id, configuration: configuration.data };
  }
  private async presets(client: PoolClient, input: BuildRequestInput) {
    const selected = input.profiles.map((profile) => input.presets[profile]!); const result = await client.query<PresetRow>('SELECT id, profile, configuration FROM presets WHERE id = ANY($1::uuid[])', [selected]);
    if (result.rowCount !== selected.length) throw new BadRequestException('Selected preset is unavailable.'); const byProfile = new Map<Profile, { id: string; configuration: ReturnType<typeof presetConfigurationSchema.parse> }>();
    for (const row of result.rows) { if (input.presets[row.profile] !== row.id || byProfile.has(row.profile)) throw new BadRequestException('Each selected preset must match its profile.'); const configuration = presetConfigurationSchema.safeParse(row.configuration); if (!configuration.success) throw new BadRequestException('Selected preset configuration is invalid.'); byProfile.set(row.profile, { id: row.id, configuration: configuration.data }); }
    return byProfile;
  }
  private async present(client: PoolClient, id: string): Promise<{ request: PublicRequest; jobs: Array<Record<string, unknown>> }> {
    return presentRequestWithJobs(client, id);
  }
}
/** Safe projection shared by the service and integration tests: telemetry only, capability URLs stay in JobsService.externalLinks. */
export async function presentRequestWithJobs(client: PoolClient, id: string): Promise<{ request: PublicRequest; jobs: Array<Record<string, unknown>> }> {
  const request = await client.query<PublicRequest>(`SELECT id, visibility, display_name AS "displayName", technical_name AS "technicalName", created_at AS "createdAt", updated_at AS "updatedAt" FROM build_requests WHERE id = $1`, [id]);
  const jobs = await client.query(
    `SELECT j.id, j.profile, j.platform, j.version, j.status, j.created_at AS "createdAt", j.updated_at AS "updatedAt", telemetry.action_telemetry AS "actionTelemetry"
     FROM build_jobs j
     LEFT JOIN LATERAL (SELECT a.action_telemetry FROM build_attempts a WHERE a.job_id = j.id ORDER BY a.active DESC, a.attempt_number DESC LIMIT 1) telemetry ON true
     WHERE j.request_id = $1 ORDER BY j.created_at, j.profile`, [id]);
  return { request: request.rows[0], jobs: jobs.rows };
}
