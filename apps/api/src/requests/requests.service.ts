import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { buildRequestInputSchema, brandingConfigurationSchema, composeResolvedJobConfiguration, presetConfigurationSchema, rustDeskServerConfigurationSchema, validatePngBase64, type AppEnvironment, type BuildRequestInput, type EncryptionService, type Platform, type Profile, type ProtectedValue } from '@rdgen/domain';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit.service.js';

type ServerRow = ProtectedValue & { id: string; name: string; keyId: string };
type PresetRow = { id: string; profile: Profile; configuration: unknown };
type BrandingRow = { id: string; name: string; companyName: string; androidApplicationId: string | null; theme: 'light' | 'dark' | 'system'; themeScope: 'default' | 'override'; iconStorageKey: string | null; logoStorageKey: string | null; privacyStorageKey: string | null };
type StoredImage = { bytes: Buffer; width: number; height: number; storageKey: string };
type PublicRequest = { id: string; visibility: 'private' | 'published'; displayName: string; technicalName: string; createdAt: Date; updatedAt: Date };

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
    const request = await client.query<PublicRequest>(`SELECT id, visibility, display_name AS "displayName", technical_name AS "technicalName", created_at AS "createdAt", updated_at AS "updatedAt" FROM build_requests WHERE id = $1`, [id]);
    const jobs = await client.query(`SELECT id, profile, platform, version, status, created_at AS "createdAt", updated_at AS "updatedAt" FROM build_jobs WHERE request_id = $1 ORDER BY created_at, profile`, [id]); return { request: request.rows[0], jobs: jobs.rows };
  }
}
