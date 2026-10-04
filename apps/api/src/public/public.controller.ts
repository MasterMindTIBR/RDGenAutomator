import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import type { Pool } from 'pg';
import type { AppEnvironment } from '@rdgen/domain';
import { AuditService } from '../audit.service.js';

type ResponseLike = { setHeader(name: string, value: string): void; end(value?: Buffer): void; once(event: 'close' | 'finish', listener: () => void): void };

type CompanyRow = { id: string; name: string; publicRequestId: string | null; brandingId: string | null };
type ArtifactRow = { id: string; storageKey: string; filename: string | null; contentType: string; bytes: string; sha256: string; profile: string; platform: string };

@Controller('public')
export class PublicController {
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    @Inject('AUDIT_SERVICE') private readonly audit: AuditService,
    @Inject('APP_ENVIRONMENT') private readonly environment: AppEnvironment
  ) {}

  @Get('companies')
  async list() {
    const companies = await this.pool.query<{ id: string; name: string; brandingId: string | null }>(
      `SELECT id, name, branding_id AS "brandingId" FROM companies WHERE is_public AND public_request_id IS NOT NULL ORDER BY name ASC`
    );
    return { companies: companies.rows };
  }

  @Get('companies/:id')
  async detail(@Param('id') id: string) {
    const company = await this.company(id);
    const artifacts = await this.pool.query<ArtifactRow>(
      `SELECT a.id, a.storage_key AS "storageKey", a.filename, a.content_type AS "contentType", a.bytes, a.sha256, j.profile, j.platform
       FROM artifacts a JOIN build_jobs j ON j.id = a.job_id
       WHERE j.request_id = $1 AND j.status IN ('concluído', 'concluído_parcial') AND a.tombstoned_at IS NULL
       ORDER BY j.profile, j.platform`, [company.publicRequestId]
    );
    return {
      company: { id: company.id, name: company.name, hasLogo: Boolean(company.brandingId) },
      downloads: artifacts.rows.map((row) => ({ id: row.id, profile: row.profile, platform: row.platform, filename: row.filename, bytes: Number(row.bytes), sha256: row.sha256 }))
    };
  }

  @Get('companies/:id/logo')
  async logo(@Param('id') id: string, @Res() response: ResponseLike): Promise<void> {
    const company = await this.company(id);
    if (!company.brandingId) throw new NotFoundException('Logo not found.');
    const result = await this.pool.query<{ storageKey: string | null; contentType: string | null; bytes: string | null }>(
      `SELECT logo_storage_key AS "storageKey", logo_content_type AS "contentType", logo_bytes AS bytes FROM brandings WHERE id = $1`, [company.brandingId]
    );
    const image = result.rows[0];
    if (!image?.storageKey || !image.contentType || image.bytes === null) throw new NotFoundException('Logo not found.');
    const root = resolve(this.environment.APP_STORAGE_PATH); const path = resolve(root, image.storageKey);
    const fileRelative = relative(root, path);
    if (!fileRelative || fileRelative.startsWith('..') || !fileRelative.startsWith('brandings/')) throw new NotFoundException('Logo not found.');
    try { await access(path); } catch { throw new NotFoundException('Logo not found.'); }
    response.setHeader('Content-Type', image.contentType); response.setHeader('Content-Length', image.bytes); response.setHeader('Cache-Control', 'public, max-age=3600'); response.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(path).once('error', () => response.end()).pipe(response as never);
  }

  @Get('companies/:id/download/:artifactId')
  async download(@Param('id') id: string, @Param('artifactId') artifactId: string, @Res() response: ResponseLike): Promise<void> {
    const company = await this.company(id);
    const result = await this.pool.query<ArtifactRow>(
      `SELECT a.id, a.storage_key AS "storageKey", a.filename, a.content_type AS "contentType", a.bytes, a.sha256, j.profile, j.platform
       FROM artifacts a JOIN build_jobs j ON j.id = a.job_id
       WHERE a.id = $1 AND j.request_id = $2 AND a.tombstoned_at IS NULL`, [artifactId, company.publicRequestId]
    );
    const artifact = result.rows[0];
    if (!artifact) throw new NotFoundException('Artifact not found.');
    const leaseOwner = `public-download-${randomUUID()}`;
    const lease = await this.pool.query(`UPDATE artifacts SET download_lease_owner = $2, download_lease_expires_at = now() + interval '15 minutes' WHERE id = $1 AND tombstoned_at IS NULL AND (download_lease_expires_at IS NULL OR download_lease_expires_at < now()) RETURNING id`, [artifact.id, leaseOwner]);
    if (!lease.rowCount) throw new NotFoundException('Artifact not found.');
    const release = async () => { await this.pool.query(`UPDATE artifacts SET download_lease_owner = NULL, download_lease_expires_at = NULL WHERE id = $1 AND download_lease_owner = $2`, [artifact.id, leaseOwner]).catch(() => undefined); };
    const root = resolve(this.environment.APP_STORAGE_PATH); const file = resolve(root, artifact.storageKey);
    const fileRelative = relative(root, file);
    if (!fileRelative || fileRelative.startsWith('..') || fileRelative.includes('..\\') || !fileRelative.startsWith('generated/artifacts/')) { await release(); throw new NotFoundException('Artifact not found.'); }
    try { await access(file); } catch { await release(); throw new NotFoundException('Artifact not found.'); }
    await this.audit.record(null, 'artifact.public_downloaded', 'artifact', artifact.id, { companyId: company.id, bytes: Number(artifact.bytes) });
    response.setHeader('Content-Type', artifact.contentType);
    response.setHeader('Content-Length', String(artifact.bytes));
    response.setHeader('Content-Disposition', `attachment; filename="${(artifact.filename ?? `artifact-${artifact.id}`).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let finished = false;
    const finish = () => { if (!finished) { finished = true; void release(); } };
    const renewal = setInterval(() => { void this.pool.query(`UPDATE artifacts SET download_lease_expires_at = now() + interval '15 minutes' WHERE id = $1 AND download_lease_owner = $2`, [artifact.id, leaseOwner]); }, 60_000);
    response.once('close', () => { clearInterval(renewal); finish(); });
    response.once('finish', () => { clearInterval(renewal); finish(); });
    const stream = createReadStream(file);
    stream.once('error', () => { clearInterval(renewal); finish(); response.end(); });
    stream.pipe(response as never);
  }

  private async company(id: string): Promise<CompanyRow> {
    const result = await this.pool.query<CompanyRow>(`SELECT id, name, public_request_id AS "publicRequestId", branding_id AS "brandingId" FROM companies WHERE id = $1 AND is_public`, [id]);
    const company = result.rows[0];
    if (!company || !company.publicRequestId) throw new NotFoundException('Company not found.');
    return company;
  }
}
