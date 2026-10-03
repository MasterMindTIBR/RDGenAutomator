import { Body, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Req, Res, BadRequestException } from '@nestjs/common';
import { RDGEN_RELEASES } from '@rdgen/domain';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import type { Pool } from 'pg';
import type { AppEnvironment } from '@rdgen/domain';
import type { SessionService } from '../auth/session.service.js';
import { AuditService } from '../audit.service.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };
type ResponseLike = { setHeader(name: string, value: string): void; end(value?: Buffer): void; once(event: 'close' | 'finish', listener: () => void): void };
function cookie(request: RequestLike): string | undefined { const value = request.headers.cookie; return Array.isArray(value) ? value[0] : value; }

type RequestRow = { id: string; creatorId: string; visibility: 'private' | 'published'; displayName: string; technicalName: string; createdAt: Date; updatedAt: Date };
type ArtifactRow = { id: string; requestId: string; creatorId: string; visibility: 'private' | 'published'; storageKey: string; filename: string | null; contentType: string; bytes: string; sha256: string };

@Controller()
export class ResourcesController {
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    @Inject('SESSION_SERVICE') private readonly sessions: SessionService,
    @Inject('AUDIT_SERVICE') private readonly audit: AuditService,
    @Inject('APP_ENVIRONMENT') private readonly environment: AppEnvironment
  ) {}

  private async assertAudience(actor: { userId: string; role: string }, requestId: string, creatorId: string, visibility: 'private' | 'published'): Promise<void> {
    if (actor.role === 'administrator' || creatorId === actor.userId) return;
    if (visibility !== 'published') throw new NotFoundException('Resource not found.');
    const audience = await this.pool.query<{ hasAudience: boolean; inAudience: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM request_audiences ra WHERE ra.request_id = $1) AS "hasAudience",
              EXISTS(SELECT 1 FROM request_audiences ra WHERE ra.request_id = $1 AND (ra.user_id = $2 OR ra.group_id IN (SELECT group_id FROM group_members gm WHERE gm.user_id = $2))) AS "inAudience"`,
      [requestId, actor.userId]
    );
    const row = audience.rows[0];
    if (row?.hasAudience && !row?.inAudience) throw new NotFoundException('Resource not found.');
  }

  /** A deliberately small dashboard projection: no configuration, attempts or remote links. */
  @Get('build-requests')
  async listRequests(@Req() request: RequestLike) {
    const actor = await this.sessions.authenticate(cookie(request));
    const result = await this.pool.query(
      `SELECT id, visibility, display_name AS "displayName", technical_name AS "technicalName", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM build_requests
       WHERE $1 = 'administrator' OR creator_id = $2 OR (
         visibility = 'published' AND (
           NOT EXISTS (SELECT 1 FROM request_audiences ra WHERE ra.request_id = build_requests.id)
           OR EXISTS (SELECT 1 FROM request_audiences ra WHERE ra.request_id = build_requests.id AND (ra.user_id = $2 OR ra.group_id IN (SELECT group_id FROM group_members gm WHERE gm.user_id = $2)))
         )
       )
       ORDER BY updated_at DESC LIMIT 200`, [actor.role, actor.userId]
    );
    return { requests: result.rows };
  }

  /** Non-secret choices needed by the typed request form. Server connection material is never returned. */
  @Get('build-requests/options')
  async requestOptions(@Req() request: RequestLike) {
    await this.sessions.authenticate(cookie(request));
    const [servers, presets, brandings] = await Promise.all([
      this.pool.query(`SELECT id, name FROM rustdesk_servers ORDER BY name`),
      this.pool.query(`SELECT id, name, profile, version FROM presets ORDER BY profile, name, version`),
      this.pool.query(`SELECT id, name, company_name AS "companyName", theme FROM brandings ORDER BY name`)
    ]);
    return { servers: servers.rows, presets: presets.rows, brandings: brandings.rows, releases: RDGEN_RELEASES };
  }

  @Post('build-requests/releases/refresh')
  async refreshReleases(@Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.sessions.authenticate(cookie(request)); this.sessions.assertCsrf(actor, csrf);
    return { releases: RDGEN_RELEASES, checkedAt: new Date().toISOString() };
  }

  @Get('build-requests/:id')
  async requestById(@Param('id') id: string, @Req() request: RequestLike) {
    const actor = await this.sessions.authenticate(cookie(request));
    const result = await this.pool.query<RequestRow>(
      `SELECT id, creator_id AS "creatorId", visibility, display_name AS "displayName", technical_name AS "technicalName", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM build_requests WHERE id = $1`, [id]
    );
    const resource = result.rows[0];
    if (!resource) throw new NotFoundException('Build request not found.');
    await this.assertAudience(actor, resource.id, resource.creatorId, resource.visibility);
    const [jobs, artifacts] = await Promise.all([
      this.pool.query(`SELECT j.id, j.profile, j.platform, j.version, j.status, j.manual_retry_after AS "manualRetryAfter", j.last_error_code AS "lastErrorCode", j.cancellation_remote_may_continue AS "cancellationRemoteMayContinue", j.created_at AS "createdAt", j.updated_at AS "updatedAt",
        COALESCE((SELECT json_agg(json_build_object('id', a.id, 'number', a.attempt_number, 'status', a.status, 'stage', a.remote_stage, 'errorCode', a.error_code, 'riskConfirmedAt', a.risk_confirmed_at, 'createdAt', a.created_at, 'updatedAt', a.updated_at) ORDER BY a.attempt_number DESC)
                  FROM build_attempts a WHERE a.job_id = j.id), '[]'::json) AS attempts
        FROM build_jobs j WHERE j.request_id = $1 ORDER BY j.created_at`, [id]),
      this.pool.query(`SELECT a.id, a.sha256, a.bytes, a.content_type AS "contentType", a.created_at AS "createdAt" FROM artifacts a JOIN build_jobs j ON j.id = a.job_id WHERE j.request_id = $1 ORDER BY a.created_at`, [id])
    ]);
    return { request: { id: resource.id, visibility: resource.visibility, displayName: resource.displayName, technicalName: resource.technicalName, createdAt: resource.createdAt, updatedAt: resource.updatedAt, canManage: actor.role === 'administrator' || resource.creatorId === actor.userId }, jobs: jobs.rows, artifacts: artifacts.rows };
  }

  @Post('build-requests/:id/visibility')
  async setVisibility(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) {
    const actor = await this.sessions.authenticate(cookie(request));
    this.sessions.assertCsrf(actor, csrf);
    const value = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const visibility = value.visibility;
    if (visibility !== 'private' && visibility !== 'published') throw new BadRequestException('Visibility must be private or published.');
    const userIds = Array.isArray(value.userIds) ? (value.userIds as unknown[]).filter((u): u is string => typeof u === 'string') : [];
    const groupIds = Array.isArray(value.groupIds) ? (value.groupIds as unknown[]).filter((g): g is string => typeof g === 'string') : [];
    const updated = await this.pool.query<{ id: string; visibility: 'private' | 'published' }>(
      `UPDATE build_requests SET visibility = $1, updated_at = now()
       WHERE id = $2 AND ($3 = 'administrator' OR creator_id = $4)
       RETURNING id, visibility`, [visibility, id, actor.role, actor.userId]
    );
    if (!updated.rowCount) throw new NotFoundException('Build request not found.');
    await this.pool.query(`DELETE FROM request_audiences WHERE request_id = $1`, [id]);
    if (visibility === 'published') {
      for (const userId of userIds) await this.pool.query(`INSERT INTO request_audiences (request_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, userId]);
      for (const groupId of groupIds) await this.pool.query(`INSERT INTO request_audiences (request_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, groupId]);
    }
    await this.audit.record(actor.userId, visibility === 'published' ? 'build_request.published' : 'build_request.withdrawn', 'build_request', id, {});
    return { request: updated.rows[0] };
  }

  @Get('artifacts/:id/download')
  async download(@Param('id') id: string, @Req() request: RequestLike, @Res() response: ResponseLike): Promise<void> {
    const actor = await this.sessions.authenticate(cookie(request));
    const result = await this.pool.query<ArtifactRow>(
      `SELECT a.id, r.id AS "requestId", a.storage_key AS "storageKey", a.filename, a.content_type AS "contentType", a.bytes, a.sha256,
              r.creator_id AS "creatorId", r.visibility
       FROM artifacts a JOIN build_jobs j ON j.id = a.job_id JOIN build_requests r ON r.id = j.request_id
       WHERE a.id = $1 AND a.tombstoned_at IS NULL`, [id]
    );
    const artifact = result.rows[0];
    if (!artifact) throw new NotFoundException('Artifact not found.');
    await this.assertAudience(actor, artifact.requestId, artifact.creatorId, artifact.visibility);
    const leaseOwner = `api-download-${randomUUID()}`;
    const lease = await this.pool.query(`UPDATE artifacts SET download_lease_owner = $2, download_lease_expires_at = now() + interval '15 minutes' WHERE id = $1 AND tombstoned_at IS NULL AND (download_lease_expires_at IS NULL OR download_lease_expires_at < now()) RETURNING id`, [artifact.id, leaseOwner]);
    if (!lease.rowCount) throw new NotFoundException('Artifact not found.');
    const release = async () => { await this.pool.query(`UPDATE artifacts SET download_lease_owner = NULL, download_lease_expires_at = NULL WHERE id = $1 AND download_lease_owner = $2`, [artifact.id, leaseOwner]).catch(() => undefined); };
    const root = resolve(this.environment.APP_STORAGE_PATH);
    const file = resolve(root, artifact.storageKey);
    const fileRelative = relative(root, file);
    if (!fileRelative || fileRelative.startsWith('..') || fileRelative.includes('..\\') || !fileRelative.startsWith('generated/artifacts/')) { await release(); throw new NotFoundException('Artifact not found.'); }
    try { await access(file); } catch { await release(); throw new NotFoundException('Artifact not found.'); }
    await this.audit.record(actor.userId, 'artifact.downloaded', 'artifact', artifact.id, { bytes: Number(artifact.bytes) });
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
}
