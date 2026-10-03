import { ForbiddenException, HttpException, HttpStatus, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createOpaqueToken, hashOpaqueToken, opaqueTokenMatches, type AuthenticatedActor, type AppEnvironment, type UserRole } from '@rdgen/domain';
import type { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';
import bcrypt from 'bcryptjs';
import { AuditService } from '../audit.service.js';

const SESSION_COOKIE = 'rdgen_session';
const CSRF_COOKIE = 'rdgen_csrf';
const SESSION_TTL_SECONDS = 60 * 60 * 24;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW_SECONDS = 60;
const passwordTimingHash = '$2a$12$5WwjLxwtLQOUnfXK5AQdDuHcaLQIttkwgw/w50X5GrGmwO3nqHPgy';

class LoginRateLimitException extends HttpException {
  constructor(message: string) { super(message, HttpStatus.TOO_MANY_REQUESTS); }
}

export type SessionActor = AuthenticatedActor & { email: string; csrfHash: string };
export type LoginResult = { actor: SessionActor; sessionToken: string; csrfToken: string };
type LoginUser = { id: string; email: string; passwordHash: string; role: UserRole; status: 'active' | 'disabled' };

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return header.split(';').reduce<Record<string, string>>((cookies, pair) => {
    const separator = pair.indexOf('=');
    if (separator < 1) return cookies;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch { /* Ignore a malformed unrelated cookie. */ }
    return cookies;
  }, {});
}

export function sessionCookie(value: string, environment: AppEnvironment, maxAge = SESSION_TTL_SECONDS): string {
  const attributes = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (new URL(environment.API_BASE_URL).protocol === 'https:') attributes.push('Secure');
  return attributes.join('; ');
}

export function clearedSessionCookie(environment: AppEnvironment): string {
  return sessionCookie('', environment, 0);
}

function csrfCookie(value: string, environment: AppEnvironment, maxAge = SESSION_TTL_SECONDS): string {
  const attributes = [`${CSRF_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (new URL(environment.API_BASE_URL).protocol === 'https:') attributes.push('Secure');
  return attributes.join('; ');
}

export class SessionService {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly environment: AppEnvironment
  ) {}

  async login(emailInput: string, password: string, ip: string, priorCookie: string | undefined): Promise<LoginResult> {
    const email = emailInput.trim().toLowerCase();
    await this.enforceRateLimit(email, ip);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const attempt = await client.query<{ failedAttempts: number; lockedUntil: Date | null }>(
        'SELECT failed_attempts AS "failedAttempts", locked_until AS "lockedUntil" FROM login_attempts WHERE email = $1 FOR UPDATE', [email]
      );
      if (attempt.rowCount === 1 && attempt.rows[0].lockedUntil && attempt.rows[0].lockedUntil > new Date()) {
        await client.query('ROLLBACK');
        throw new LoginRateLimitException('Login temporarily locked. Try again later.');
      }
      const users = await client.query<LoginUser>(
        `SELECT id, email, password_hash AS "passwordHash", role, status
         FROM users WHERE email = $1 FOR UPDATE`, [email]
      );
      const user = users.rows[0];
      const valid = typeof user !== 'undefined' && user.status === 'active' && await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        if (!user) await bcrypt.compare(password, passwordTimingHash);
        const oldFailures = attempt.rows[0]?.failedAttempts ?? 0;
        const failures = oldFailures + 1;
        if (failures >= MAX_LOGIN_ATTEMPTS) {
          await client.query(
            `INSERT INTO login_attempts (email, failed_attempts, locked_until, updated_at)
             VALUES ($1, 0, now() + ($2 || ' minutes')::interval, now())
             ON CONFLICT (email) DO UPDATE SET failed_attempts = 0, locked_until = excluded.locked_until, updated_at = now()`,
            [email, LOCKOUT_MINUTES]
          );
        } else {
          await client.query(
            `INSERT INTO login_attempts (email, failed_attempts, locked_until, updated_at)
             VALUES ($1, $2, NULL, now())
             ON CONFLICT (email) DO UPDATE SET failed_attempts = excluded.failed_attempts, locked_until = NULL, updated_at = now()`,
            [email, failures]
          );
        }
        await this.record(client, null, 'auth.login_failed', 'login', email, {});
        await client.query('COMMIT');
        throw new UnauthorizedException('Invalid email or password.');
      }

      const sessionToken = createOpaqueToken();
      const csrfToken = createOpaqueToken();
      if (priorCookie) {
        await client.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashOpaqueToken(priorCookie)]);
      }
      const session = await client.query<{ id: string }>(
        `INSERT INTO sessions (user_id, token_hash, csrf_hash, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval) RETURNING id`,
        [user.id, hashOpaqueToken(sessionToken), hashOpaqueToken(csrfToken), SESSION_TTL_SECONDS]
      );
      await client.query('DELETE FROM login_attempts WHERE email = $1', [email]);
      await client.query('UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1', [user.id]);
      await this.record(client, user.id, 'auth.login', 'session', session.rows[0].id, {});
      await client.query('COMMIT');
      return { actor: { userId: user.id, role: user.role, email: user.email, sessionId: session.rows[0].id, csrfHash: hashOpaqueToken(csrfToken) }, sessionToken, csrfToken };
    } catch (error) {
      if (!(error instanceof UnauthorizedException) && !(error instanceof LoginRateLimitException)) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async authenticate(cookieHeader: string | undefined): Promise<SessionActor> {
    const token = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Authentication required.');
    const result = await this.pool.query<{
      sessionId: string; userId: string; email: string; role: UserRole; csrfHash: string;
    }>(
      `SELECT s.id AS "sessionId", u.id AS "userId", u.email, u.role, s.csrf_hash AS "csrfHash"
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
      [hashOpaqueToken(token)]
    );
    if (result.rowCount !== 1) throw new UnauthorizedException('Authentication required.');
    const actor = result.rows[0];
    void this.pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [actor.sessionId]).catch(() => undefined);
    return actor;
  }

  assertCsrf(actor: SessionActor, suppliedToken: string | undefined): void {
    if (!suppliedToken || !opaqueTokenMatches(suppliedToken, actor.csrfHash)) throw new ForbiddenException('CSRF token is missing or invalid.');
  }

  async logout(actor: SessionActor): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [actor.sessionId]);
      await this.record(client, actor.userId, 'auth.logout', 'session', actor.sessionId, {});
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }

  async changePassword(actor: SessionActor, currentPassword: string, newPassword: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const users = await client.query<{ passwordHash: string }>(
        `SELECT password_hash AS "passwordHash" FROM users WHERE id = $1 FOR UPDATE`, [actor.userId]
      );
      const current = users.rows[0];
      if (!current || !(await bcrypt.compare(currentPassword, current.passwordHash))) {
        await client.query('ROLLBACK');
        throw new UnauthorizedException('Current password is incorrect.');
      }
      const hash = await bcrypt.hash(newPassword, 12);
      await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, actor.userId]);
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2', [actor.userId, actor.sessionId]);
      await this.record(client, actor.userId, 'auth.password_changed', 'user', actor.userId, {});
      await client.query('COMMIT');
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  cookiesForLogin(token: string, csrfToken: string): string[] { return [sessionCookie(token, this.environment), csrfCookie(csrfToken, this.environment)]; }
  cookiesForLogout(): string[] { return [clearedSessionCookie(this.environment), csrfCookie('', this.environment, 0)]; }

  private async enforceRateLimit(email: string, ip: string): Promise<void> {
    const subject = hashOpaqueToken(`${email}\u0000${ip}`);
    const key = `rdgen:login-rate:${subject}`;
    try {
      const attempts = await this.redis.incr(key);
      if (attempts === 1) await this.redis.expire(key, LOGIN_RATE_WINDOW_SECONDS);
      if (attempts > LOGIN_RATE_LIMIT) throw new LoginRateLimitException('Too many login attempts. Try again later.');
    } catch (error) {
      if (error instanceof LoginRateLimitException) throw error;
      throw new ServiceUnavailableException('Login is temporarily unavailable.');
    }
  }

  private async record(client: PoolClient, actorId: string | null, action: string, subjectType: string, subjectId: string, metadata: Record<string, string | number | boolean | null>): Promise<void> {
    await new AuditService(client).record(actorId, action, subjectType, subjectId, metadata);
  }
}
