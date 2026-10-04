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
              c.is_public AS "isPublic", c.public_request_id AS "publicRequestId", c.created_at AS "createdAt", c.updated_at AS "updatedAt"
       FROM companies c ORDER BY c.name ASC`
    );
    return { companies: companies.rows };
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.administrator(request); this.sessions.assertCsrf(actor, csrf);
    const parsed = companyAdminInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A name, server and valid typed company configuration are required.');
    const input = parsed.data;
    try {
      const created = await this.pool.query<{ id: string }>(
        `INSERT INTO companies (name, server_id, branding_id, preset_full_id, preset_qs_id, is_public, public_request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [input.name, input.serverId, input.brandingId ?? null, input.presetFullId ?? null, input.presetQsId ?? null, input.isPublic, input.publicRequestId ?? null]
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
      `UPDATE companies SET name = $1, server_id = $2, branding_id = $3, preset_full_id = $4, preset_qs_id = $5, is_public = $6, public_request_id = $7, updated_at = now()
       WHERE id = $8 RETURNING id`,
      [input.name, input.serverId, input.brandingId ?? null, input.presetFullId ?? null, input.presetQsId ?? null, input.isPublic, input.publicRequestId ?? null, id]
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
