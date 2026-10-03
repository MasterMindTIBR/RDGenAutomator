import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { isStrongPassword } from '@rdgen/domain';
import type { SessionService } from '../auth/session.service.js';
import { AuditService } from '../audit.service.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };
function cookie(request: RequestLike): string | undefined { const value = request.headers.cookie; return Array.isArray(value) ? value[0] : value; }

@Controller('admin/users')
export class AdminUsersController {
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    @Inject('SESSION_SERVICE') private readonly sessions: SessionService,
    @Inject('AUDIT_SERVICE') private readonly audit: AuditService
  ) {}

  @Get()
  async list(@Req() request: RequestLike) {
    const actor = await this.administrator(request);
    const users = await this.pool.query(
      `SELECT id, email, role, status, last_login_at AS "lastLoginAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM users ORDER BY created_at ASC`
    );
    await this.audit.record(actor.userId, 'admin.users_listed', 'user', 'collection', {});
    return { users: users.rows };
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrfToken: string | undefined) {
    const actor = await this.administrator(request);
    this.sessions.assertCsrf(actor, csrfToken);
    if (!body || typeof body !== 'object') throw new BadRequestException('Email and password are required.');
    const { email, password, role = 'user' } = body as Record<string, unknown>;
    if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || !isStrongPassword(password)) {
      throw new BadRequestException('A valid email and a strong password are required.');
    }
    if (role !== 'user' && role !== 'administrator') throw new BadRequestException('Role must be user or administrator.');
    const hash = await bcrypt.hash(password, 12);
    try {
      const created = await this.pool.query<{ id: string; email: string; role: string; status: string }>(
        `INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, $3, 'active')
         RETURNING id, email, role, status`, [email.trim().toLowerCase(), hash, role]
      );
      await this.audit.record(actor.userId, 'admin.user_created', 'user', created.rows[0].id, { role: created.rows[0].role });
      return { user: created.rows[0] };
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === '23505') throw new BadRequestException('A user with that email already exists.');
      throw error;
    }
  }

  @Post(':id/disable')
  async disable(@Param('id') id: string, @Req() request: RequestLike, @Headers('x-csrf-token') csrfToken: string | undefined) {
    const actor = await this.administrator(request);
    this.sessions.assertCsrf(actor, csrfToken);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<{ id: string }>(
        `UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1 AND status <> 'disabled' RETURNING id`, [id]
      );
      if (updated.rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new NotFoundException('Active user not found.');
      }
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await new AuditService(client).record(actor.userId, 'admin.user_disabled', 'user', id, {});
      await client.query('COMMIT');
      return { user: { id, status: 'disabled' } };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }

  private async administrator(request: RequestLike) {
    const actor = await this.sessions.authenticate(cookie(request));
    if (actor.role !== 'administrator') throw new ForbiddenException('Administrator access required.');
    return actor;
  }
}
