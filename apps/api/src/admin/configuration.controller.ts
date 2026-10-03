import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, Post, Put, Req, Res } from '@nestjs/common';
import { brandingAdminInputSchema, presetConfigurationSchema, profileSchema, rustDeskServerConfigurationSchema, validatePngBase64, type AppEnvironment, type BrandingAdminInput, type EncryptionService, type RustDeskServerConfiguration } from '@rdgen/domain';
import { createReadStream } from 'node:fs';
import { access, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import type { Pool } from 'pg';
import type { SessionService } from '../auth/session.service.js';
import { AuditService } from '../audit.service.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };
type ResponseLike = { setHeader(name: string, value: string): void; end(): void };
function cookie(request: RequestLike): string | undefined { const value = request.headers.cookie; return Array.isArray(value) ? value[0] : value; }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function name(value: unknown): string | undefined { return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 120 ? value.trim() : undefined; }
function days(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : undefined; }

@Controller('admin')
export class AdminConfigurationController {
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    @Inject('SESSION_SERVICE') private readonly sessions: SessionService,
    @Inject('AUDIT_SERVICE') private readonly audit: AuditService,
    @Inject('ENCRYPTION_SERVICE') private readonly encryption: EncryptionService,
    @Inject('APP_ENVIRONMENT') private readonly environment: AppEnvironment
  ) {}

  @Get('rustdesk-servers')
  async listServers(@Req() request: RequestLike) {
    await this.administrator(request);
    const servers = await this.pool.query<{ id: string; name: string; ciphertext: string; integrity: string; keyId: string; createdAt: Date; updatedAt: Date }>(
      `SELECT s.id, s.name, p.ciphertext, p.integrity, p.key_id AS "keyId", s.created_at AS "createdAt", s.updated_at AS "updatedAt"
       FROM rustdesk_servers s JOIN protected_records p ON p.id = s.configuration_protected_id ORDER BY s.name`
    );
    return {
      servers: servers.rows.map((row) => {
        let configuration: RustDeskServerConfiguration | null;
        try { const parsed = rustDeskServerConfigurationSchema.safeParse(JSON.parse(this.encryption.decrypt(row).toString('utf8'))); configuration = parsed.success ? parsed.data : null; }
        catch { configuration = null; }
        return { id: row.id, name: row.name, configuration, createdAt: row.createdAt, updatedAt: row.updatedAt };
      })
    };
  }

  @Post('rustdesk-servers')
  async createServer(@Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    const parsed = object(body); const serverName = name(parsed?.name); const configuration = rustDeskServerConfigurationSchema.safeParse(parsed?.configuration);
    if (!serverName || !configuration.success) throw new BadRequestException('A server name and valid typed server configuration are required.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const protectedValue = this.encryption.encrypt(JSON.stringify(configuration.data));
      const protectedRecord = await client.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('rustdesk-server-configuration', $1, $2, $3) RETURNING id`, [protectedValue.ciphertext, protectedValue.integrity, protectedValue.keyId]);
      const created = await client.query<{ id: string; name: string }>(`INSERT INTO rustdesk_servers (name, configuration_protected_id) VALUES ($1, $2) RETURNING id, name`, [serverName, protectedRecord.rows[0].id]);
      await new AuditService(client).record(actor.userId, 'admin.rustdesk_server_created', 'rustdesk_server', created.rows[0].id, {});
      await client.query('COMMIT');
      return { server: { ...created.rows[0], configuration: configuration.data } };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); if (typeof error === 'object' && error && 'code' in error && error.code === '23505') throw new BadRequestException('A server with that name already exists.'); throw error; } finally { client.release(); }
  }

  @Put('rustdesk-servers/:id')
  async updateServer(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    const parsed = object(body); const serverName = name(parsed?.name); const configuration = rustDeskServerConfigurationSchema.safeParse(parsed?.configuration);
    if (!serverName || !configuration.success) throw new BadRequestException('A server name and valid typed server configuration are required.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const protectedValue = this.encryption.encrypt(JSON.stringify(configuration.data));
      const protectedRecord = await client.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('rustdesk-server-configuration', $1, $2, $3) RETURNING id`, [protectedValue.ciphertext, protectedValue.integrity, protectedValue.keyId]);
      const updated = await client.query<{ id: string; name: string }>(`UPDATE rustdesk_servers SET name = $1, configuration_protected_id = $2, updated_at = now() WHERE id = $3 RETURNING id, name`, [serverName, protectedRecord.rows[0].id, id]);
      if (!updated.rowCount) throw new NotFoundException('RustDesk server not found.');
      await new AuditService(client).record(actor.userId, 'admin.rustdesk_server_updated', 'rustdesk_server', id, {});
      await client.query('COMMIT'); return { server: { ...updated.rows[0], configuration: configuration.data } };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }

  @Delete('rustdesk-servers/:id')
  async deleteServer(@Param('id') id: string, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    try {
      const deleted = await this.pool.query(`DELETE FROM rustdesk_servers WHERE id = $1 RETURNING id`, [id]);
      if (!deleted.rowCount) throw new NotFoundException('RustDesk server not found.');
      await this.audit.record(actor.userId, 'admin.rustdesk_server_deleted', 'rustdesk_server', id, {}); return { deleted: true };
    } catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === '23503') throw new BadRequestException('RustDesk server is referenced by a request and cannot be deleted.'); throw error; }
  }

  @Get('presets')
  async listPresets(@Req() request: RequestLike) {
    await this.administrator(request);
    const presets = await this.pool.query(`SELECT id, name, profile, version, configuration, created_at AS "createdAt", updated_at AS "updatedAt" FROM presets ORDER BY profile, name, version`);
    return { presets: presets.rows };
  }

  @Post('presets')
  async createPreset(@Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    const parsed = object(body); const presetName = name(parsed?.name); const profile = profileSchema.safeParse(parsed?.profile); const configuration = presetConfigurationSchema.safeParse(parsed?.configuration); const version = typeof parsed?.version === 'number' && Number.isInteger(parsed.version) && parsed.version > 0 ? parsed.version : 1;
    if (!presetName || !profile.success || !configuration.success) throw new BadRequestException('A name, profile and valid typed preset configuration are required.');
    try {
      const created = await this.pool.query(`INSERT INTO presets (name, profile, version, configuration) VALUES ($1, $2, $3, $4::jsonb) RETURNING id, name, profile, version, configuration`, [presetName, profile.data, version, JSON.stringify(configuration.data)]);
      await this.audit.record(actor.userId, 'admin.preset_created', 'preset', created.rows[0].id, { profile: profile.data, version }); return { preset: created.rows[0] };
    } catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === '23505') throw new BadRequestException('That preset name, profile and version already exists.'); throw error; }
  }

  @Put('presets/:id')
  async updatePreset(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    const parsed = object(body); const presetName = name(parsed?.name); const profile = profileSchema.safeParse(parsed?.profile); const configuration = presetConfigurationSchema.safeParse(parsed?.configuration); const version = typeof parsed?.version === 'number' && Number.isInteger(parsed.version) && parsed.version > 0 ? parsed.version : undefined;
    if (!presetName || !profile.success || !configuration.success || !version) throw new BadRequestException('A name, profile, version and valid typed preset configuration are required.');
    const updated = await this.pool.query(`UPDATE presets SET name = $1, profile = $2, version = $3, configuration = $4::jsonb, updated_at = now() WHERE id = $5 RETURNING id, name, profile, version, configuration`, [presetName, profile.data, version, JSON.stringify(configuration.data), id]);
    if (!updated.rowCount) throw new NotFoundException('Preset not found.');
    await this.audit.record(actor.userId, 'admin.preset_updated', 'preset', id, { profile: profile.data, version }); return { preset: updated.rows[0] };
  }

  @Delete('presets/:id')
  async deletePreset(@Param('id') id: string, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    try { const deleted = await this.pool.query(`DELETE FROM presets WHERE id = $1 RETURNING id`, [id]); if (!deleted.rowCount) throw new NotFoundException('Preset not found.'); await this.audit.record(actor.userId, 'admin.preset_deleted', 'preset', id, {}); return { deleted: true }; }
    catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === '23503') throw new BadRequestException('Preset is referenced by a job and cannot be deleted.'); throw error; }
  }

  @Get('brandings')
  async listBrandings(@Req() request: RequestLike) {
    await this.administrator(request);
    const brandings = await this.pool.query(`SELECT id, name, company_name AS "companyName", android_application_id AS "androidApplicationId", theme, theme_scope AS "themeScope", created_at AS "createdAt", updated_at AS "updatedAt" FROM brandings ORDER BY name`);
    return { brandings: brandings.rows };
  }

  @Post('brandings')
  async createBranding(@Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf); const parsed = brandingAdminInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A valid branding configuration is required.');
    const images = this.brandingImages(parsed.data); const client = await this.pool.connect(); const written: string[] = [];
    try {
      await client.query('BEGIN'); const stored = this.brandingStorage(images);
      const created = await client.query<{ id: string; name: string; companyName: string; theme: string }>(
        `INSERT INTO brandings (name, company_name, android_application_id, theme, theme_scope,
          icon_storage_key, icon_content_type, icon_bytes, icon_width, icon_height,
          logo_storage_key, logo_content_type, logo_bytes, logo_width, logo_height,
          privacy_storage_key, privacy_content_type, privacy_bytes, privacy_width, privacy_height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING id, name, company_name AS "companyName", theme`,
        [parsed.data.name, parsed.data.companyName, parsed.data.androidApplicationId ?? null, parsed.data.theme, parsed.data.themeScope,
          stored.icon?.storageKey ?? null, stored.icon ? 'image/png' : null, stored.icon?.bytes.byteLength ?? null, stored.icon?.width ?? null, stored.icon?.height ?? null,
          stored.logo?.storageKey ?? null, stored.logo ? 'image/png' : null, stored.logo?.bytes.byteLength ?? null, stored.logo?.width ?? null, stored.logo?.height ?? null,
          stored.privacyScreen?.storageKey ?? null, stored.privacyScreen ? 'image/png' : null, stored.privacyScreen?.bytes.byteLength ?? null, stored.privacyScreen?.width ?? null, stored.privacyScreen?.height ?? null]
      );
      await this.writeBrandingImages(stored, written); await new AuditService(client).record(actor.userId, 'admin.branding_created', 'branding', created.rows[0].id, {}); await client.query('COMMIT'); return { branding: created.rows[0] };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); await Promise.all(written.map((path) => unlink(path).catch(() => undefined))); if (typeof error === 'object' && error && 'code' in error && error.code === '23505') throw new BadRequestException('A branding with that name already exists.'); throw error; } finally { client.release(); }
  }

  @Put('brandings/:id')
  async updateBranding(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf); const parsed = brandingAdminInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A valid branding configuration is required.');
    const images = this.brandingImages(parsed.data); const client = await this.pool.connect(); const written: string[] = []; let obsolete: string[] = [];
    try {
      await client.query('BEGIN'); const before = await client.query<{ iconStorageKey: string | null; logoStorageKey: string | null; privacyStorageKey: string | null }>(`SELECT icon_storage_key AS "iconStorageKey", logo_storage_key AS "logoStorageKey", privacy_storage_key AS "privacyStorageKey" FROM brandings WHERE id = $1 FOR UPDATE`, [id]);
      if (!before.rowCount) throw new NotFoundException('Branding not found.'); const stored = this.brandingStorage(images); await this.writeBrandingImages(stored, written);
      const updated = await client.query<{ id: string; name: string; companyName: string; theme: string }>(
        `UPDATE brandings SET name=$1, company_name=$2, android_application_id=$3, theme=$4, theme_scope=$5,
          icon_storage_key=COALESCE($6, icon_storage_key), icon_content_type=COALESCE($7, icon_content_type), icon_bytes=COALESCE($8, icon_bytes), icon_width=COALESCE($9, icon_width), icon_height=COALESCE($10, icon_height),
          logo_storage_key=COALESCE($11, logo_storage_key), logo_content_type=COALESCE($12, logo_content_type), logo_bytes=COALESCE($13, logo_bytes), logo_width=COALESCE($14, logo_width), logo_height=COALESCE($15, logo_height),
          privacy_storage_key=COALESCE($16, privacy_storage_key), privacy_content_type=COALESCE($17, privacy_content_type), privacy_bytes=COALESCE($18, privacy_bytes), privacy_width=COALESCE($19, privacy_width), privacy_height=COALESCE($20, privacy_height), updated_at=now()
         WHERE id=$21 RETURNING id, name, company_name AS "companyName", theme`,
        [parsed.data.name, parsed.data.companyName, parsed.data.androidApplicationId ?? null, parsed.data.theme, parsed.data.themeScope,
          stored.icon?.storageKey ?? null, stored.icon ? 'image/png' : null, stored.icon?.bytes.byteLength ?? null, stored.icon?.width ?? null, stored.icon?.height ?? null,
          stored.logo?.storageKey ?? null, stored.logo ? 'image/png' : null, stored.logo?.bytes.byteLength ?? null, stored.logo?.width ?? null, stored.logo?.height ?? null,
          stored.privacyScreen?.storageKey ?? null, stored.privacyScreen ? 'image/png' : null, stored.privacyScreen?.bytes.byteLength ?? null, stored.privacyScreen?.width ?? null, stored.privacyScreen?.height ?? null, id]
      );
      obsolete = (['icon', 'logo', 'privacyScreen'] as const).flatMap((slot) => {
        const key = slot === 'privacyScreen' ? before.rows[0].privacyStorageKey : before.rows[0][`${slot}StorageKey`];
        return stored[slot] && key ? [key] : [];
      });
      await new AuditService(client).record(actor.userId, 'admin.branding_updated', 'branding', id, {}); await client.query('COMMIT'); await Promise.all(obsolete.map((key) => this.removeBrandingFile(key))); return { branding: updated.rows[0] };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); await Promise.all(written.map((path) => unlink(path).catch(() => undefined))); if (typeof error === 'object' && error && 'code' in error && error.code === '23505') throw new BadRequestException('A branding with that name already exists.'); throw error; } finally { client.release(); }
  }

  @Delete('brandings/:id')
  async deleteBranding(@Param('id') id: string, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    try {
      const deleted = await this.pool.query<{ iconStorageKey: string | null; logoStorageKey: string | null; privacyStorageKey: string | null }>(`DELETE FROM brandings WHERE id = $1 RETURNING icon_storage_key AS "iconStorageKey", logo_storage_key AS "logoStorageKey", privacy_storage_key AS "privacyStorageKey"`, [id]);
      if (!deleted.rowCount) throw new NotFoundException('Branding not found.'); await Promise.all(Object.values(deleted.rows[0]).filter((key): key is string => Boolean(key)).map((key) => this.removeBrandingFile(key))); await this.audit.record(actor.userId, 'admin.branding_deleted', 'branding', id, {}); return { deleted: true };
    } catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === '23503') throw new BadRequestException('Branding is referenced by a request and cannot be deleted.'); throw error; }
  }

  @Get('brandings/:id/images/:slot')
  async brandingImage(@Param('id') id: string, @Param('slot') slot: string, @Req() request: RequestLike, @Res() response: ResponseLike): Promise<void> {
    await this.administrator(request); if (!['icon', 'logo', 'privacy'].includes(slot)) throw new NotFoundException('Branding image not found.');
    const column = slot === 'privacy' ? 'privacy' : slot; const result = await this.pool.query<{ storageKey: string | null; contentType: string | null; bytes: string | null }>(`SELECT ${column}_storage_key AS "storageKey", ${column}_content_type AS "contentType", ${column}_bytes AS bytes FROM brandings WHERE id = $1`, [id]); const image = result.rows[0];
    if (!image?.storageKey || !image.contentType || image.bytes === null) throw new NotFoundException('Branding image not found.'); const path = this.brandingPath(image.storageKey); try { await access(path); } catch { throw new NotFoundException('Branding image not found.'); }
    response.setHeader('Content-Type', image.contentType); response.setHeader('Content-Length', image.bytes); response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); createReadStream(path).once('error', () => response.end()).pipe(response as never);
  }

  @Get('settings')
  async settings(@Req() request: RequestLike) { await this.administrator(request); const result = await this.pool.query(`SELECT artifact_retention_days AS "artifactRetentionDays", logo_retention_days AS "logoRetentionDays", updated_at AS "updatedAt" FROM system_settings WHERE id = true`); return { settings: result.rows[0] }; }

  @Put('settings')
  async updateSettings(@Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf); const parsed = object(body); const artifactRetentionDays = days(parsed?.artifactRetentionDays); const logoRetentionDays = days(parsed?.logoRetentionDays);
    if (!artifactRetentionDays || !logoRetentionDays) throw new BadRequestException('Retention days must be whole numbers between 1 and 3650.');
    const updated = await this.pool.query(`UPDATE system_settings SET artifact_retention_days = $1, logo_retention_days = $2, updated_at = now() WHERE id = true RETURNING artifact_retention_days AS "artifactRetentionDays", logo_retention_days AS "logoRetentionDays", updated_at AS "updatedAt"`, [artifactRetentionDays, logoRetentionDays]);
    await this.audit.record(actor.userId, 'admin.retention_updated', 'system_settings', 'default', { artifactRetentionDays, logoRetentionDays }); return { settings: updated.rows[0] };
  }

  private brandingImages(input: BrandingAdminInput) {
    const result: Partial<Record<'icon' | 'logo' | 'privacyScreen', { bytes: Buffer; width: number; height: number }>> = {};
    for (const slot of ['icon', 'logo', 'privacyScreen'] as const) if (input[slot]) {
      try { result[slot] = validatePngBase64(input[slot].dataBase64); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : `Invalid PNG ${slot}.`); }
    }
    return result;
  }
  private brandingStorage(images: Partial<Record<'icon' | 'logo' | 'privacyScreen', { bytes: Buffer; width: number; height: number }>>) {
    const result: Partial<Record<'icon' | 'logo' | 'privacyScreen', { bytes: Buffer; width: number; height: number; storageKey: string }>> = {};
    for (const slot of ['icon', 'logo', 'privacyScreen'] as const) if (images[slot]) result[slot] = { ...images[slot], storageKey: `brandings/${slot}/${randomUUID()}.png` };
    return result;
  }
  private async writeBrandingImages(images: Partial<Record<'icon' | 'logo' | 'privacyScreen', { bytes: Buffer; storageKey: string }>>, written: string[]) {
    for (const image of Object.values(images)) if (image) { const path = this.brandingPath(image.storageKey); await mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); await writeFile(path, image.bytes, { mode: 0o600, flag: 'wx' }); written.push(path); }
  }
  private brandingPath(key: string): string {
    const root = resolve(this.environment.APP_STORAGE_PATH); const path = resolve(root, key); const inside = relative(root, path);
    if (!inside || inside.startsWith('..') || inside.includes('..\\') || !inside.startsWith('brandings/')) throw new Error('Refusing branding storage outside protected storage');
    return path;
  }
  private async removeBrandingFile(key: string) { await rm(this.brandingPath(key), { force: true }); }
  private async administrator(request: RequestLike) { const actor = await this.sessions.authenticate(cookie(request)); if (actor.role !== 'administrator') throw new ForbiddenException('Administrator access required.'); return actor; }
}
