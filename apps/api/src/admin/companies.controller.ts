import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { companyAdminInputSchema } from '@rdgen/domain';
import type { Pool } from 'pg';
import type { SessionService } from '../auth/session.service.js';
import { AuditService } from '../audit.service.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };
function cookie(request: RequestLike): string | undefined { const value = request.headers.cookie; return Array.isArray(value) ? value[0] : value; }

@Controller('admin/companies')
export class CompaniesController {
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    @Inject('SESSION_SERVICE') private readonly sessions: SessionService,
    @Inject('AUDIT_SERVICE') private readonly audit: AuditService
  ) {}

  @Get()
  async list(@Req() request: RequestLike) {
    await this.administrator(request);
    const companies = await this.pool.query(
      `SELECT c.id, c.name, c.server_id AS "serverId", c.branding_id AS "brandingId", c.preset_full_id AS "presetFullId", c.preset_qs_id AS "presetQsId",
              c.is_public AS "isPublic", c.public_request_id AS "publicRequestId", c.default_display_name AS "defaultDisplayName", c.default_technical_name AS "defaultTechnicalName", c.created_at AS "createdAt", c.updated_at AS "updatedAt"
       FROM companies c ORDER BY c.name ASC`
    );
    return { companies: companies.rows };
  }

  @Get(':id')
  async detail(@Param('id') id: string, @Req() request: RequestLike) {
    await this.administrator(request);
    const company = await this.pool.query<{ id: string; name: string }>('SELECT id, name FROM companies WHERE id = $1', [id]);
    if (!company.rowCount) throw new NotFoundException('Company not found.');
    const requests = await this.pool.query<{ id: string; displayName: string; technicalName: string; createdAt: Date }>(
      `SELECT id, display_name AS "displayName", technical_name AS "technicalName", created_at AS "createdAt" FROM build_requests WHERE company_id = $1 ORDER BY created_at DESC`, [id]);
    const result: Array<{ id: string; displayName: string; technicalName: string; createdAt: Date; executions: Array<{ profile: string; platform: string; jobId: string; status: string; artifacts: Array<{ id: string; filename: string | null; bytes: string; sha256: string; contentType: string }> }> }> = [];
    for (const req of requests.rows) {
      const latest = await this.pool.query<{ id: string; profile: string; platform: string; status: string }>(
        `SELECT DISTINCT ON (profile, platform) id, profile, platform, status
         FROM build_jobs
         WHERE request_id = $1 AND status IN ('concluído', 'concluído_parcial')
         ORDER BY profile, platform, (SELECT MAX(ended_at) FROM build_attempts a WHERE a.job_id = build_jobs.id AND a.status IN ('concluído', 'concluído_parcial')) DESC NULLS LAST, id DESC`, [req.id]);
      const executions: Array<{ profile: string; platform: string; jobId: string; status: string; artifacts: Array<{ id: string; filename: string | null; bytes: string; sha256: string; contentType: string }> }> = [];
      for (const job of latest.rows) {
        const artifacts = await this.pool.query<{ id: string; filename: string | null; bytes: string; sha256: string; contentType: string }>(
          `SELECT a.id, a.filename, a.bytes, a.sha256, a.content_type AS "contentType"
           FROM artifacts a WHERE a.job_id = $1 AND a.tombstoned_at IS NULL AND (a.retention_expires_at IS NULL OR a.retention_expires_at > now())
           ORDER BY a.filename ASC NULLS LAST`, [job.id]);
        executions.push({ profile: job.profile, platform: job.platform, jobId: job.id, status: job.status, artifacts: artifacts.rows });
      }
      result.push({ id: req.id, displayName: req.displayName, technicalName: req.technicalName, createdAt: req.createdAt, executions });
    }
    return { company: company.rows[0], requests: result };
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    const parsed = companyAdminInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A name, server and valid typed company configuration are required.');
    const input = parsed.data;
    try {
      const created = await this.pool.query<{ id: string }>(
        `INSERT INTO companies (name, server_id, branding_id, preset_full_id, preset_qs_id, is_public, public_request_id, default_display_name, default_technical_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [input.name, input.serverId, input.brandingId ?? null, input.presetFullId ?? null, input.presetQsId ?? null, input.isPublic, input.publicRequestId ?? null, input.defaultDisplayName ?? null, input.defaultTechnicalName ?? null]
      );
      await this.audit.record(actor.userId, 'admin.company_created', 'company', created.rows[0].id, {});
      return { company: { id: created.rows[0].id, ...input } };
    } catch (error) { if (typeof error === 'object' && error && 'code' in error && error.code === '23505') throw new BadRequestException('A company with that name already exists.'); throw error; }
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    const parsed = companyAdminInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A name, server and valid typed company configuration are required.');
    const input = parsed.data;
    if (input.publicRequestId) {
      const owned = await this.pool.query('SELECT 1 FROM build_requests WHERE id = $1 AND company_id = $2', [input.publicRequestId, id]);
      if (!owned.rowCount) throw new BadRequestException('The public request must belong to this company.');
    }
    const updated = await this.pool.query<{ id: string }>(
      `UPDATE companies SET name = $1, server_id = $2, branding_id = $3, preset_full_id = $4, preset_qs_id = $5, is_public = $6, public_request_id = $7, default_display_name = $8, default_technical_name = $9, updated_at = now()
       WHERE id = $10 RETURNING id`,
      [input.name, input.serverId, input.brandingId ?? null, input.presetFullId ?? null, input.presetQsId ?? null, input.isPublic, input.publicRequestId ?? null, input.defaultDisplayName ?? null, input.defaultTechnicalName ?? null, id]
    );
    if (!updated.rowCount) throw new NotFoundException('Company not found.');
    await this.audit.record(actor.userId, 'admin.company_updated', 'company', id, {});
    return { company: { id, ...input } };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    const deleted = await this.pool.query(`DELETE FROM companies WHERE id = $1 RETURNING id`, [id]);
    if (!deleted.rowCount) throw new NotFoundException('Company not found.');
    await this.audit.record(actor.userId, 'admin.company_deleted', 'company', id, {});
    return { deleted: true };
  }

  private async administrator(request: RequestLike) {
    const actor = await this.sessions.authenticate(cookie(request));
    if (actor.role !== 'administrator') throw new ForbiddenException('Administrator access required.');
    return actor;
  }
}
