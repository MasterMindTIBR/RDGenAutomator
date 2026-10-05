import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import type { Pool, PoolClient } from 'pg';
import { canonicalActionRunUrl, classifyWorkflowFailure, EncryptionService, extractActionRunId, RdgenAmbiguousStartError, RdgenProvider, RdgenRunUnknownError, RdgenTerminalError, RdgenTransientError, retryDelayMs, sweepTemporaryConfigurations, type DownloadManifest, type ProtectedValue, type RemoteBuild, type ResolvedJobConfiguration } from '@rdgen/domain';
import { ActionTelemetryStore } from './action-telemetry-store.js';
import { ArtifactDelivery } from './artifact-delivery.js';

const MAX_RETRIES = 3;
const WORKFLOW_RETRY_LIMIT = 3;
/** ~1h of 15s polls with neither RDGen nor GitHub reachable before a build is declared indeterminate. */
const UNKNOWN_REMOTE_LIMIT = 240;
type ClaimedStart = { kind: 'start'; jobId: string; attemptId: string; attemptNumber: number; configuration: ResolvedJobConfiguration };
type ClaimedPoll = { kind: 'poll'; jobId: string; attemptId: string; remote: RemoteBuild; actionUrl?: string; pollFailures: number; unknownMisses: number };
type Claim = ClaimedStart | ClaimedPoll;
type EncryptedColumns = { ciphertext: string | null; integrity: string | null; keyId: string | null };
function protectedValue(row: EncryptedColumns): ProtectedValue | undefined {
  return row.ciphertext && row.integrity && row.keyId ? { ciphertext: row.ciphertext, integrity: row.integrity, keyId: row.keyId } : undefined;
}

export class OutboxDispatcher {
  constructor(private readonly pool: Pool, private readonly queue: Queue) {}
  async publishReady(limit = 100): Promise<number> {
    const client = await this.pool.connect(); let rows: Array<{ id: string; jobId: string; availableAt: Date }> = [];
    try {
      await client.query('BEGIN');
      const selected = await client.query<{ id: string; jobId: string; availableAt: Date }>(
        `SELECT id, job_id AS "jobId", available_at AS "availableAt" FROM job_outbox
         WHERE published_at IS NULL AND available_at <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]
      );
      rows = selected.rows; await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
    for (const row of rows) {
      try {
        await this.queue.add('rdgen-job', { jobId: row.jobId }, { jobId: row.id, removeOnComplete: true, removeOnFail: 100 });
        await this.pool.query('UPDATE job_outbox SET published_at = now() WHERE id = $1 AND published_at IS NULL', [row.id]);
      } catch (error) {
        // A deterministic BullMQ job id means a prior publish is already safe.
        if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
        await this.pool.query('UPDATE job_outbox SET published_at = now() WHERE id = $1 AND published_at IS NULL', [row.id]);
      }
    }
    return rows.length;
  }
  async recover(): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM build_jobs WHERE status IN ('enfileirado', 'aguardando_retry', 'aguardando_rdgen')
       AND (next_retry_at IS NULL OR next_retry_at <= now())
       AND (lease_expires_at IS NULL OR lease_expires_at < now()) LIMIT 100`
    );
    for (const job of result.rows) await this.pool.query(
      `INSERT INTO job_outbox (job_id, kind, idempotency_key) VALUES ($1, 'dispatch', $2) ON CONFLICT (idempotency_key) DO NOTHING`,
      [job.id, `recovery:${job.id}:${Math.floor(Date.now() / 60_000)}`]
    );
    return result.rowCount ?? 0;
  }
}

export class RdgenJobRunner {
  private readonly owner = `worker-${randomUUID()}`;
  private readonly artifacts?: ArtifactDelivery;
  private readonly storagePath?: string;
  private readonly actionStore?: ActionTelemetryStore;
  private lastStartAt = 0;
  constructor(private readonly pool: Pool, private readonly queue: Queue, private readonly encryption: EncryptionService, private readonly provider: RdgenProvider, private readonly pollDelayMs = 15_000, private readonly startGapMs = 5_000, actionStore?: ActionTelemetryStore, storagePath?: string) {
    this.storagePath = storagePath; if (storagePath) this.artifacts = new ArtifactDelivery(pool, encryption, storagePath, provider); this.actionStore = actionStore;
  }
  async run(jobId: string): Promise<void> {
    const claim = await this.claim(jobId); if (!claim) return;
    try { if (claim.kind === 'start') return await this.start(claim); return await this.poll(claim); }
    finally { if (this.storagePath) await sweepTemporaryConfigurations(this.storagePath); }
  }
  private async claim(jobId: string): Promise<Claim | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ id: string; status: string; retryCount: number } & EncryptedColumns>(
        `SELECT j.id, j.status, j.retry_count AS "retryCount", p.ciphertext, p.integrity, p.key_id AS "keyId"
         FROM build_jobs j LEFT JOIN protected_records p ON p.id = j.resolved_configuration_protected_id WHERE j.id = $1 FOR UPDATE OF j`, [jobId]
      );
      const job = locked.rows[0]; if (!job || ['cancelado', 'concluído', 'concluído_parcial', 'falhou', 'início_indeterminado'].includes(job.status)) { await client.query('COMMIT'); return undefined; }
      const lease = await client.query(
        `UPDATE build_jobs SET lease_owner = $2, lease_expires_at = now() + interval '2 minutes', updated_at = now()
         WHERE id = $1 AND (lease_expires_at IS NULL OR lease_expires_at < now()) RETURNING id`, [jobId, this.owner]
      );
      if (!lease.rowCount) { await client.query('COMMIT'); return undefined; }
      const active = await client.query<{ id: string; remoteUuid: string | null; remoteFilename: string | null; remotePlatform: string | null; errorCode: string | null } & EncryptedColumns>(
        `SELECT a.id, a.remote_uuid AS "remoteUuid", a.remote_filename AS "remoteFilename", a.remote_platform AS "remotePlatform", p.ciphertext, p.integrity, p.key_id AS "keyId",
                a.error_code AS "errorCode"
         FROM build_attempts a LEFT JOIN protected_records p ON p.id = a.remote_metadata_protected_id
         WHERE a.job_id = $1 AND a.active FOR UPDATE OF a`, [jobId]
      );
      if (active.rowCount && active.rows[0].remoteUuid) {
        const attempt = active.rows[0];
        const metadata = protectedValue(attempt); if (!metadata) throw new Error('Active RDGen attempt is missing protected metadata');
        const remote = JSON.parse(this.encryption.decrypt(metadata).toString('utf8')) as RemoteBuild;
        await client.query(`UPDATE build_jobs SET status = 'aguardando_rdgen', updated_at = now() WHERE id = $1`, [jobId]);
        await client.query('COMMIT'); return { kind: 'poll', jobId, attemptId: attempt.id, remote, ...(remote.actionUrl ? { actionUrl: remote.actionUrl } : {}), pollFailures: Number(/^poll:(\d+)$/.exec(attempt.errorCode ?? '')?.[1] ?? 0), unknownMisses: Number(/^unknown:(\d+)$/.exec(attempt.errorCode ?? '')?.[1] ?? 0) };
      }
      const config = protectedValue(job);
      if (!['enfileirado', 'aguardando_retry'].includes(job.status) || !config) { await client.query('COMMIT'); return undefined; }
      const number = await client.query<{ value: number }>('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS value FROM build_attempts WHERE job_id = $1', [jobId]);
      const attempt = await client.query<{ id: string }>(
        `INSERT INTO build_attempts (job_id, attempt_number, status, active, start_intent_at) VALUES ($1, $2, 'iniciando', true, now()) RETURNING id`, [jobId, number.rows[0].value]
      );
      await client.query(`UPDATE build_jobs SET status = 'iniciando', updated_at = now() WHERE id = $1`, [jobId]);
      const configuration = JSON.parse(this.encryption.decrypt(config).toString('utf8')) as ResolvedJobConfiguration;
      await client.query('COMMIT'); return { kind: 'start', jobId, attemptId: attempt.rows[0].id, attemptNumber: number.rows[0].value, configuration };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  private async throttleStart(): Promise<void> {
    const elapsed = Date.now() - this.lastStartAt;
    if (elapsed < this.startGapMs) { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, this.startGapMs - elapsed); await promise; }
    this.lastStartAt = Date.now();
  }
  private async loadImages(configuration: ResolvedJobConfiguration): Promise<{ icon?: Buffer; logo?: Buffer; privacyScreen?: Buffer }> {
    if (!this.storagePath) return {};
    const root = this.storagePath;
    const read = async (key?: string) => key ? readFile(join(root, key)).catch(() => undefined) : undefined;
    const [icon, logo, privacyScreen] = await Promise.all([read(configuration.iconStorageKey), read(configuration.logoStorageKey), read(configuration.privacyStorageKey)]);
    return { ...(icon ? { icon } : {}), ...(logo ? { logo } : {}), ...(privacyScreen ? { privacyScreen } : {}) };
  }
  private async start(claim: ClaimedStart): Promise<void> {
    try { await this.throttleStart(); const images = await this.loadImages(claim.configuration); await this.persistRemote(claim, await this.provider.startBuild(claim.configuration, images)); }
    catch (error) {
      if (error instanceof RdgenAmbiguousStartError) return this.indeterminate(claim, error);
      if (error instanceof RdgenTransientError) return this.transient(claim, error, false);
      if (error instanceof RdgenTerminalError) return this.terminalStartFailure(claim, error);
      return this.transient(claim, error instanceof Error ? error : new Error('unknown start failure'), false);
    }
  }
  private async poll(claim: ClaimedPoll): Promise<void> {
    try {
      const status = await this.provider.getBuildStatus(claim.remote);
      if (status.stage === 'pending') return this.schedulePoll(claim, status.text, status.actionUrl);
      if (status.stage === 'succeeded') return this.download(claim, status.text, status.manifest, status.actionUrl);
      return this.remoteFailed(claim, status.text, status.actionUrl ?? claim.actionUrl);
    } catch (error) {
      if (error instanceof RdgenRunUnknownError) return this.unknownRemote(claim);
      if (error instanceof RdgenTransientError) return this.transient({ ...claim, attemptNumber: claim.pollFailures + 1 }, error, true);
      return this.finishPollFailure(claim, error instanceof Error ? error : new Error('RDGen status parse failure'));
    }
  }
  private async remoteFailed(claim: ClaimedPoll, text: string, actionUrl?: string): Promise<void> {
    const telemetryRow = await this.actionStore?.refresh(actionUrl);
    const telemetry = telemetryRow ? ActionTelemetryStore.telemetry(telemetryRow) : undefined;
    const classification = classifyWorkflowFailure({ rdgenFailed: true, snapshot: ActionTelemetryStore.decisionSnapshot(telemetryRow) });
    // A failed workflow still uploads every artifact it managed to build; a partial Linux matrix must not discard the good ones.
    if (!classification.retryable) return this.download(claim, text, this.provider.getDownloadManifest(claim.remote), actionUrl, true);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE build_attempts SET active = false, status = 'falhou', error_code = 'workflow_infrastructure', remote_stage = $2, ended_at = now(), last_polled_at = now(), action_telemetry = $3::jsonb WHERE id = $1 AND active`,
        [claim.attemptId, text, telemetry ? JSON.stringify(telemetry) : null]
      );
      const counted = await client.query<{ count: number }>(
        `UPDATE build_jobs SET consecutive_workflow_infrastructure_failures = consecutive_workflow_infrastructure_failures + 1, updated_at = now()
         WHERE id = $1 AND status = 'aguardando_rdgen' RETURNING consecutive_workflow_infrastructure_failures AS count`, [claim.jobId]);
      if (counted.rowCount && counted.rows[0].count >= WORKFLOW_RETRY_LIMIT) {
        await client.query(`UPDATE build_jobs SET status = 'falhou', lease_owner = NULL, lease_expires_at = NULL, last_error_code = 'workflow_retry_exhausted', updated_at = now() WHERE id = $1 AND status = 'aguardando_rdgen'`, [claim.jobId]);
      } else if (counted.rowCount) {
        const delay = retryDelayMs(counted.rows[0].count);
        await client.query(`UPDATE build_jobs SET status = 'aguardando_retry', next_retry_at = now() + ($2 * interval '1 millisecond'), lease_owner = NULL, lease_expires_at = NULL, last_error_code = 'workflow_infrastructure', updated_at = now() WHERE id = $1 AND status = 'aguardando_rdgen'`, [claim.jobId, delay]);
        await this.enqueue(client, claim.jobId, 'dispatch', delay);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  /** RDGen lost the run record (404). The GitHub Actions run is the remaining source of truth before declaring anything. */
  private async unknownRemote(claim: ClaimedPoll): Promise<void> {
    const actionUrl = claim.actionUrl ?? claim.remote.actionUrl;
    const runId = extractActionRunId(actionUrl);
    if (runId) {
      const row = await this.actionStore?.refresh(canonicalActionRunUrl(runId));
      const snapshot = row && row.fetchError === null ? row.snapshot : undefined;
      if (snapshot && snapshot.status) {
        if (snapshot.status !== 'completed') return this.schedulePoll(claim, `GitHub Actions: ${snapshot.status}`, actionUrl);
        if (snapshot.conclusion === 'success') return this.download(claim, 'Concluído (confirmado no GitHub Actions)', this.provider.getDownloadManifest(claim.remote), actionUrl);
        return this.remoteFailed(claim, `Falha confirmada no GitHub Actions: ${snapshot.conclusion ?? 'desconhecida'}`, actionUrl);
      }
    }
    const misses = claim.unknownMisses + 1;
    if (misses >= UNKNOWN_REMOTE_LIMIT) {
      await this.pool.query(`UPDATE build_attempts SET active = false, status = 'falhou', error_code = 'remote_status_unknown', ended_at = now(), last_polled_at = now() WHERE id = $1 AND active`, [claim.attemptId]);
      await this.pool.query(`UPDATE build_jobs SET status = 'início_indeterminado', lease_owner = NULL, lease_expires_at = NULL, last_error_code = 'remote_status_unknown', updated_at = now() WHERE id = $1`, [claim.jobId]);
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE build_attempts SET error_code = $2, remote_stage = 'status remoto indisponível', last_polled_at = now() WHERE id = $1 AND active`, [claim.attemptId, `unknown:${misses}`]);
      await client.query(`UPDATE build_jobs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1`, [claim.jobId]);
      await this.enqueue(client, claim.jobId, 'poll', this.pollDelayMs);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  private async download(claim: ClaimedPoll, text: string, manifest: DownloadManifest | undefined, actionUrl?: string, salvaged = false): Promise<void> {
    if (!manifest || !this.artifacts) {
      if (salvaged) return this.markFailed(claim, text, actionUrl);
      return this.finishArtifactFailure(claim);
    }
    const claimed = await this.pool.query(`UPDATE build_jobs SET status = 'baixando', updated_at = now() WHERE id = $1 AND status = 'aguardando_rdgen' AND lease_owner = $2 RETURNING id`, [claim.jobId, this.owner]);
    if (!claimed.rowCount) return;
    let result: { valid: number; expected: number; partial: boolean };
    try { result = await this.artifacts.deliver(claim.jobId, claim.remote, manifest); }
    catch {
      if (salvaged) return this.markFailed(claim, text, actionUrl);
      return this.finishArtifactFailure(claim);
    }
    const telemetryRow = await this.actionStore?.refresh(actionUrl ?? claim.actionUrl);
    const telemetry = telemetryRow ? ActionTelemetryStore.telemetry(telemetryRow) : undefined;
    const state = result.valid === result.expected ? 'concluído' : result.valid > 0 ? 'concluído_parcial' : 'falhou';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE build_attempts SET active = false, status = $2, remote_stage = $3, ended_at = now(), last_polled_at = now(), action_telemetry = $4::jsonb WHERE id = $1 AND active`, [claim.attemptId, state, text, telemetry ? JSON.stringify(telemetry) : null]);
      await client.query(`UPDATE build_jobs SET status = $2, lease_owner = NULL, lease_expires_at = NULL, consecutive_workflow_infrastructure_failures = 0, last_error_code = CASE WHEN $2 = 'falhou' THEN $3 ELSE NULL END, updated_at = now() WHERE id = $1 AND status = 'baixando'`, [claim.jobId, state, salvaged ? null : 'artifact_validation']);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  /** A salvaged failure that produced no downloadable artifact is a plain build failure, not an artifact-validation problem. */
  private async markFailed(claim: ClaimedPoll, text: string, actionUrl?: string): Promise<void> {
    const telemetryRow = await this.actionStore?.refresh(actionUrl ?? claim.actionUrl);
    const telemetry = telemetryRow ? ActionTelemetryStore.telemetry(telemetryRow) : undefined;
    await this.pool.query(`UPDATE build_attempts SET active = false, status = 'falhou', remote_stage = $2, ended_at = now(), last_polled_at = now(), action_telemetry = $3::jsonb WHERE id = $1 AND active`, [claim.attemptId, text, telemetry ? JSON.stringify(telemetry) : null]);
    await this.pool.query(`UPDATE build_jobs SET status = 'falhou', lease_owner = NULL, lease_expires_at = NULL, consecutive_workflow_infrastructure_failures = 0, updated_at = now() WHERE id = $1`, [claim.jobId]);
  }
  private async finishArtifactFailure(claim: ClaimedPoll): Promise<void> {
    await this.pool.query(`UPDATE build_attempts SET active = false, status = 'falhou', error_code = 'artifact_validation', ended_at = now() WHERE id = $1 AND active`, [claim.attemptId]);
    await this.pool.query(`UPDATE build_jobs SET status = 'falhou', lease_owner = NULL, lease_expires_at = NULL, consecutive_workflow_infrastructure_failures = 0, last_error_code = 'artifact_validation', updated_at = now() WHERE id = $1 AND status IN ('aguardando_rdgen', 'baixando')`, [claim.jobId]);
  }
  private async persistRemote(claim: ClaimedStart, remote: RemoteBuild): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const protectedValue = this.encryption.encrypt(JSON.stringify(remote));
      const record = await client.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('rdgen-remote-links', $1, $2, $3) RETURNING id`, [protectedValue.ciphertext, protectedValue.integrity, protectedValue.keyId]);
      const updated = await client.query(`UPDATE build_attempts SET status = 'aguardando_rdgen', remote_uuid = $2, remote_filename = $3, remote_platform = $4, remote_metadata_protected_id = $5, remote_stage = 'started' WHERE id = $1 AND active`, [claim.attemptId, remote.uuid, remote.filename, remote.platform, record.rows[0].id]);
      if (!updated.rowCount) throw new Error('Attempt no longer active while persisting RDGen start');
      await client.query(`UPDATE build_jobs SET status = 'aguardando_rdgen', lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND status = 'iniciando'`, [claim.jobId]);
      await this.enqueue(client, claim.jobId, 'poll', this.pollDelayMs);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  private async indeterminate(claim: ClaimedStart, error: Error): Promise<void> {
    await this.pool.query(`UPDATE build_attempts SET status = 'início_indeterminado', active = false, error_code = 'ambiguous_start', ended_at = now() WHERE id = $1 AND active`, [claim.attemptId]);
    await this.pool.query(`UPDATE build_jobs SET status = 'início_indeterminado', lease_owner = NULL, lease_expires_at = NULL, consecutive_workflow_infrastructure_failures = 0, last_error_code = 'ambiguous_start', updated_at = now() WHERE id = $1 AND status = 'iniciando'`, [claim.jobId]);
    void error; // Error text can include remote data and is intentionally not persisted.
  }
  private async terminalStartFailure(claim: ClaimedStart, error: Error): Promise<void> {
    await this.pool.query(`UPDATE build_attempts SET active = false, status = 'falhou', error_code = 'provider_rejected', ended_at = now() WHERE id = $1 AND active`, [claim.attemptId]);
    await this.pool.query(`UPDATE build_jobs SET status = 'falhou', lease_owner = NULL, lease_expires_at = NULL, consecutive_workflow_infrastructure_failures = 0, last_error_code = 'provider_rejected', updated_at = now() WHERE id = $1 AND status = 'iniciando'`, [claim.jobId]);
    void error;
  }
  private async transient(claim: ClaimedStart | (ClaimedPoll & { attemptNumber: number }), error: Error, polling: boolean): Promise<void> {
    const attemptNumber = claim.attemptNumber;
    if (attemptNumber >= MAX_RETRIES) {
      if (polling && claim.kind === 'poll') return this.finishPollFailure(claim, error);
      await this.pool.query(`UPDATE build_attempts SET active = false, status = 'falhou', error_code = 'retry_exhausted', ended_at = now() WHERE id = $1`, [claim.attemptId]);
      await this.pool.query(`UPDATE build_jobs SET status = 'falhou', lease_owner = NULL, lease_expires_at = NULL, consecutive_workflow_infrastructure_failures = 0, last_error_code = 'retry_exhausted', updated_at = now() WHERE id = $1`, [claim.jobId]); return;
    }
    const delay = retryDelayMs(attemptNumber);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (polling) await client.query(`UPDATE build_attempts SET status = 'falha_transitória', error_code = $2, last_polled_at = now() WHERE id = $1 AND active`, [claim.attemptId, `poll:${attemptNumber}`]);
      else await client.query(`UPDATE build_attempts SET active = false, status = 'falha_transitória', error_code = 'transient_start', ended_at = now() WHERE id = $1`, [claim.attemptId]);
      await client.query(`UPDATE build_jobs SET status = 'aguardando_retry', retry_count = retry_count + 1, next_retry_at = now() + ($2 * interval '1 millisecond'), lease_owner = NULL, lease_expires_at = NULL, last_error_code = 'transient', updated_at = now() WHERE id = $1`, [claim.jobId, delay]);
      await this.enqueue(client, claim.jobId, polling ? 'poll' : 'dispatch', delay); await client.query('COMMIT');
    } catch (failure) { await client.query('ROLLBACK').catch(() => undefined); throw failure; } finally { client.release(); }
    void error;
  }
  private async finishPollFailure(claim: ClaimedPoll, error: Error): Promise<void> {
    const telemetryRow = await this.actionStore?.refresh(claim.actionUrl ?? claim.remote.actionUrl);
    const telemetry = telemetryRow ? ActionTelemetryStore.telemetry(telemetryRow) : undefined;
    await this.pool.query(`UPDATE build_attempts SET active = false, status = 'falhou', error_code = 'remote_status_failure', ended_at = now(), action_telemetry = $2::jsonb WHERE id = $1`, [claim.attemptId, telemetry ? JSON.stringify(telemetry) : null]);
    await this.pool.query(`UPDATE build_jobs SET status = 'falhou', lease_owner = NULL, lease_expires_at = NULL, consecutive_workflow_infrastructure_failures = 0, last_error_code = 'remote_status_failure', updated_at = now() WHERE id = $1`, [claim.jobId]); void error;
  }
  private async schedulePoll(claim: ClaimedPoll, text: string, actionUrl?: string): Promise<void> {
    const telemetryRow = await this.actionStore?.refresh(actionUrl ?? claim.actionUrl);
    const telemetry = telemetryRow ? ActionTelemetryStore.telemetry(telemetryRow) : undefined;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (actionUrl) {
        const protectedValue = this.encryption.encrypt(JSON.stringify({ ...claim.remote, actionUrl }));
        const record = await client.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('rdgen-remote-links', $1, $2, $3) RETURNING id`, [protectedValue.ciphertext, protectedValue.integrity, protectedValue.keyId]);
        await client.query(`UPDATE build_attempts SET remote_metadata_protected_id = $2, remote_stage = $3, last_polled_at = now(), error_code = NULL, action_telemetry = $4::jsonb WHERE id = $1 AND active`, [claim.attemptId, record.rows[0].id, text, telemetry ? JSON.stringify(telemetry) : null]);
      } else await client.query(`UPDATE build_attempts SET remote_stage = $2, last_polled_at = now(), error_code = NULL, action_telemetry = $3::jsonb WHERE id = $1 AND active`, [claim.attemptId, text, telemetry ? JSON.stringify(telemetry) : null]);
      await client.query(`UPDATE build_jobs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1`, [claim.jobId]);
      await this.enqueue(client, claim.jobId, 'poll', this.pollDelayMs); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  private async enqueue(client: PoolClient, jobId: string, kind: 'dispatch' | 'poll', delayMs: number): Promise<void> {
    await client.query(`INSERT INTO job_outbox (job_id, kind, idempotency_key, available_at) VALUES ($1, $2, $3, now() + ($4 * interval '1 millisecond')) ON CONFLICT (idempotency_key) DO NOTHING`, [jobId, kind, `${kind}:${jobId}:${randomUUID()}`, delayMs]);
  }
}
