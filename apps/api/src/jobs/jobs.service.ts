import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EncryptionService, RdgenProvider, type Platform, type RemoteBuild } from '@rdgen/domain';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit.service.js';

type Actor = { userId: string; role: 'administrator' | 'user' };
const platforms = new Set<Platform>(['windows', 'windows-x86', 'linux', 'android', 'macos']);
const manualCooldownMs = 5 * 60_000;

@Injectable()
export class JobsService {
  private readonly provider = new RdgenProvider();
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool, @Inject('ENCRYPTION_SERVICE') private readonly encryption: EncryptionService) {}
  async cancel(actor: Actor, jobId: string): Promise<{ cancelled: true; remoteMayContinue: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); const job = await this.authorize(client, actor, jobId, true);
      if (['concluído', 'concluído_parcial', 'falhou', 'cancelado'].includes(job.status)) throw new BadRequestException('Terminal jobs cannot be cancelled.');
      const remote = await client.query<{ remoteUuid: string | null }>('SELECT remote_uuid AS "remoteUuid" FROM build_attempts WHERE job_id = $1 AND active FOR UPDATE', [jobId]);
      const remoteMayContinue = Boolean(remote.rows[0]?.remoteUuid);
      await client.query(`UPDATE build_attempts SET active = false, status = 'cancelado', ended_at = now() WHERE job_id = $1 AND active`, [jobId]);
      await client.query(`UPDATE build_jobs SET status = 'cancelado', lease_owner = NULL, lease_expires_at = NULL, next_retry_at = NULL, cancellation_remote_may_continue = $2, updated_at = now() WHERE id = $1`, [jobId, remoteMayContinue]);
      await new AuditService(client).record(actor.userId, 'build_job.cancelled', 'build_job', jobId, { remoteMayContinue });
      await client.query('COMMIT'); return { cancelled: true, remoteMayContinue };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  async retry(actor: Actor, jobId: string, riskConfirmed: boolean): Promise<{ queued: true }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); const job = await this.authorize(client, actor, jobId, true);
      if (!['início_indeterminado', 'falhou'].includes(job.status)) throw new BadRequestException('Only indeterminate or failed jobs may be retried manually.');
      if (job.status === 'início_indeterminado' && !riskConfirmed) throw new BadRequestException('Retrying an indeterminate start requires explicit duplicate-build risk confirmation.');
      if (job.manualRetryAfter && job.manualRetryAfter > new Date()) throw new BadRequestException('Manual retry is in cooldown.');
      if (job.status === 'início_indeterminado') await client.query(`UPDATE build_attempts SET risk_confirmed_at = now() WHERE job_id = $1 AND status = 'início_indeterminado' AND risk_confirmed_at IS NULL`, [jobId]);
      await client.query(`UPDATE build_jobs SET status = 'aguardando_retry', manual_retry_after = now() + ($2 * interval '1 millisecond'), next_retry_at = now(), last_error_code = NULL, updated_at = now() WHERE id = $1`, [jobId, manualCooldownMs]);
      await this.outbox(client, jobId, 'manual-retry');
      await new AuditService(client).record(actor.userId, 'build_job.manual_retry_authorized', 'build_job', jobId, { riskConfirmed });
      await client.query('COMMIT'); return { queued: true };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  async reconcile(actor: Actor, jobId: string, raw: unknown): Promise<{ reconciled: true }> {
    const remote = this.remote(raw); const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); const job = await this.authorize(client, actor, jobId, true);
      if (job.status !== 'início_indeterminado') throw new BadRequestException('Only an indeterminate start can be reconciled.');
      const protectedValue = this.encryption.encrypt(JSON.stringify(remote));
      const record = await client.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('rdgen-remote-links', $1, $2, $3) RETURNING id`, [protectedValue.ciphertext, protectedValue.integrity, protectedValue.keyId]);
      const attempt = await client.query<{ id: string }>(`SELECT id FROM build_attempts WHERE job_id = $1 AND status = 'início_indeterminado' ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`, [jobId]);
      if (!attempt.rowCount) throw new BadRequestException('Indeterminate attempt no longer exists.');
      await client.query(`UPDATE build_attempts SET status = 'aguardando_rdgen', active = true, remote_uuid = $2, remote_filename = $3, remote_platform = $4, remote_metadata_protected_id = $5, remote_stage = 'reconciled', ended_at = NULL WHERE id = $1`, [attempt.rows[0].id, remote.uuid, remote.filename, remote.platform, record.rows[0].id]);
      await client.query(`UPDATE build_jobs SET status = 'aguardando_rdgen', last_error_code = NULL, updated_at = now() WHERE id = $1`, [jobId]);
      await this.outbox(client, jobId, 'reconcile');
      await new AuditService(client).record(actor.userId, 'build_job.reconciled', 'build_job', jobId, {});
      await client.query('COMMIT'); return { reconciled: true };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  async bulkAction(actor: Actor, requestId: string, action: 'retry' | 'reconcile', scope: 'all' | 'failed'): Promise<{ acted: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const request = await client.query<{ creatorId: string }>(`SELECT creator_id AS "creatorId" FROM build_requests WHERE id = $1 FOR UPDATE`, [requestId]);
      if (request.rowCount !== 1) throw new NotFoundException('Request not found.');
      if (actor.role !== 'administrator' && request.rows[0].creatorId !== actor.userId) throw new ForbiddenException('You cannot act on this request.');
      const statusFilter = scope === 'failed' ? ` AND j.status IN ('início_indeterminado', 'falhou')` : '';
      const jobs = await client.query<{ id: string; status: string }>(`SELECT j.id, j.status FROM build_jobs j WHERE j.request_id = $1${statusFilter} FOR UPDATE OF j`, [requestId]);
      let acted = 0;
      for (const job of jobs.rows) {
        if (action === 'retry') {
          if (!['início_indeterminado', 'falhou'].includes(job.status)) continue;
          await client.query(`UPDATE build_attempts SET risk_confirmed_at = now() WHERE job_id = $1 AND status = 'início_indeterminado' AND risk_confirmed_at IS NULL`, [job.id]);
          await client.query(`UPDATE build_jobs SET status = 'aguardando_retry', manual_retry_after = now(), next_retry_at = now(), last_error_code = NULL, updated_at = now() WHERE id = $1`, [job.id]);
          await this.outbox(client, job.id, 'bulk-retry');
          acted += 1;
        } else {
          if (job.status !== 'início_indeterminado') continue;
          await client.query(`UPDATE build_attempts SET active = false, status = 'falhou', error_code = 'reconciled_dead', ended_at = now() WHERE job_id = $1 AND status = 'início_indeterminado'`, [job.id]);
          await client.query(`UPDATE build_jobs SET status = 'falhou', lease_owner = NULL, lease_expires_at = NULL, last_error_code = 'reconciled_dead', updated_at = now() WHERE id = $1`, [job.id]);
          acted += 1;
        }
      }
      await new AuditService(client).record(actor.userId, 'build_job.bulk_action', 'build_request', requestId, { action, scope, count: acted });
      await client.query('COMMIT'); return { acted };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  /**
   * External capability links are decrypted only after the ownership check. They
   * are intentionally separate from ordinary job detail responses so polling
   * and dashboard telemetry cannot accidentally carry them.
   */
  async externalLinks(actor: Actor, jobId: string): Promise<{ links: { statusUrl?: string; actionUrl?: string } }> {
    const client = await this.pool.connect();
    try {
      await this.authorize(client, actor, jobId, false);
      const row = await client.query<{ ciphertext: string; integrity: string; keyId: string }>(
        `SELECT p.ciphertext, p.integrity, p.key_id AS "keyId"
         FROM build_attempts a JOIN protected_records p ON p.id = a.remote_metadata_protected_id
         WHERE a.job_id = $1 ORDER BY a.attempt_number DESC LIMIT 1`, [jobId]
      );
      if (!row.rowCount) return { links: {} };
      let remote: unknown;
      try { remote = JSON.parse(this.encryption.decrypt(row.rows[0]).toString('utf8')); }
      catch { throw new NotFoundException('External build links are unavailable.'); }
      if (!remote || typeof remote !== 'object') return { links: {} };
      const value = remote as Record<string, unknown>;
      const links = {
        ...(typeof value.statusUrl === 'string' ? { statusUrl: value.statusUrl } : {}),
        ...(typeof value.actionUrl === 'string' ? { actionUrl: value.actionUrl } : {})
      };
      return { links };
    } finally { client.release(); }
  }
  private remote(raw: unknown): RemoteBuild {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Remote build identity is required.');
    const value = raw as Record<string, unknown>; const uuid = value.uuid; const filename = value.filename; const platform = value.platform;
    if (typeof uuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(uuid) || typeof filename !== 'string' || !/^[A-Za-z0-9._-]+$/.test(filename) || typeof platform !== 'string' || !platforms.has(platform as Platform)) throw new BadRequestException('Remote build identity is invalid.');
    // The status URL is derived from allowlisted fields, never trusted from the request body.
    return this.provider.parseStart(`<span id="statusText">reconciled</span><script>window.location.replace('/check_for_file?filename=${encodeURIComponent(filename)}&uuid=${encodeURIComponent(uuid)}&platform=${encodeURIComponent(platform)}');</script>`);
  }
  private async authorize(client: PoolClient, actor: Actor, jobId: string, lock: boolean) {
    const result = await client.query<{ status: string; manualRetryAfter: Date | null }>(
      `SELECT j.status, j.manual_retry_after AS "manualRetryAfter" FROM build_jobs j JOIN build_requests r ON r.id = j.request_id WHERE j.id = $1 AND ($2 = 'administrator' OR r.creator_id = $3)${lock ? ' FOR UPDATE' : ''}`,
      [jobId, actor.role, actor.userId]
    );
    if (!result.rowCount) {
      const exists = await client.query('SELECT 1 FROM build_jobs WHERE id = $1', [jobId]);
      if (exists.rowCount) throw new ForbiddenException('Only the request creator or an administrator may manage this job.');
      throw new NotFoundException('Build job not found.');
    }
    return result.rows[0];
  }
  private async outbox(client: PoolClient, jobId: string, label: string): Promise<void> {
    await client.query(`INSERT INTO job_outbox (job_id, kind, idempotency_key) VALUES ($1, 'dispatch', $2) ON CONFLICT (idempotency_key) DO NOTHING`, [jobId, `${label}:${jobId}:${Date.now()}`]);
  }
}
