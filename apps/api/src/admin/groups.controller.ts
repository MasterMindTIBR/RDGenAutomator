import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import type { Pool } from 'pg';
import type { SessionService } from '../auth/session.service.js';
import { AuditService } from '../audit.service.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };
function cookie(request: RequestLike): string | undefined { const value = request.headers.cookie; return Array.isArray(value) ? value[0] : value; }

@Controller('admin/groups')
export class GroupsController {
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    @Inject('SESSION_SERVICE') private readonly sessions: SessionService,
    @Inject('AUDIT_SERVICE') private readonly audit: AuditService
  ) {}

  @Get()
  async list(@Req() request: RequestLike) {
    const actor = await this.administrator(request);
    const groups = await this.pool.query(
      `SELECT g.id, g.name, g.created_at AS "createdAt", g.updated_at AS "updatedAt", COUNT(m.user_id)::int AS "memberCount"
       FROM groups g LEFT JOIN group_members m ON m.group_id = g.id GROUP BY g.id ORDER BY g.name ASC`
    );
    const members = await this.pool.query<{ groupId: string; userId: string }>(`SELECT group_id AS "groupId", user_id AS "userId" FROM group_members`);
    return { groups: groups.rows, members: members.rows };
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrfToken: string | undefined) {
    const actor = await this.administrator(request);
    this.sessions.assertCsrf(actor, csrfToken);
    if (!body || typeof body !== 'object') throw new BadRequestException('Name is required.');
    const { name } = body as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) throw new BadRequestException('Name is required.');
    const trimmed = name.trim().slice(0, 120);
    try {
      const created = await this.pool.query<{ id: string; name: string }>(`INSERT INTO groups (name) VALUES ($1) RETURNING id, name`, [trimmed]);
      await this.audit.record(actor.userId, 'admin.group_created', 'group', created.rows[0].id, {});
      return { group: created.rows[0] };
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === '23505') throw new BadRequestException('A group with that name already exists.');
      throw error;
    }
  }

  @Post(':id/members')
  async setMembers(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrfToken: string | undefined) {
    const actor = await this.administrator(request);
    this.sessions.assertCsrf(actor, csrfToken);
    if (!body || typeof body !== 'object') throw new BadRequestException('User ids are required.');
    const { userIds } = body as Record<string, unknown>;
    if (!Array.isArray(userIds) || userIds.some((u) => typeof u !== 'string')) throw new BadRequestException('User ids must be an array of strings.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const group = await client.query(`SELECT id FROM groups WHERE id = $1 FOR UPDATE`, [id]);
      if (group.rowCount !== 1) { await client.query('ROLLBACK'); throw new BadRequestException('Group not found.'); }
      await client.query(`DELETE FROM group_members WHERE group_id = $1`, [id]);
      for (const userId of userIds as string[]) {
        await client.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, userId]);
      }
      await new AuditService(client).record(actor.userId, 'admin.group_members_updated', 'group', id, { count: userIds.length });
      await client.query('COMMIT');
      return { ok: true };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() request: RequestLike, @Headers('x-csrf-token') csrfToken: string | undefined) {
    const actor = await this.administrator(request);
    this.sessions.assertCsrf(actor, csrfToken);
    await this.pool.query(`DELETE FROM groups WHERE id = $1`, [id]);
    await this.audit.record(actor.userId, 'admin.group_deleted', 'group', id, {});
    return { ok: true };
  }

  private async administrator(request: RequestLike) {
    const actor = await this.sessions.authenticate(cookie(request));
    if (actor.role !== 'administrator') throw new ForbiddenException('Administrator access required.');
    return actor;
  }
}
