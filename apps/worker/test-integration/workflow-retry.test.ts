import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionJobsClient, EncryptionService, RdgenProvider, type FetchLike } from '@rdgen/domain';
import type { Queue } from 'bullmq';
import pg from 'pg';
import { ActionTelemetryStore, sweepTerminalActionSnapshots } from '../src/action-telemetry-store.js';
import { RdgenJobRunner } from '../src/lifecycle.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'integration tests require DATABASE_URL from the runner');
assert.ok(process.env.APP_ENCRYPTION_KEY && process.env.APP_ENCRYPTION_KEY_ID, 'integration tests require encryption environment');

/** Each test gets its own run ID so the shared snapshot cache cannot leak state between scenarios. */
function scenarioFor(runId: string) {
  const actionUrl = `https://github.com/bryangerlach/rdgen/actions/runs/${runId}`;
  const remote = { uuid: '22222222-2222-4222-8222-222222222222', filename: 'acme', platform: 'windows', statusUrl: 'https://rdgen.crayoneater.org/check_for_file?filename=acme&uuid=22222222-2222-4222-8222-222222222222&platform=windows', actionUrl };
  return { actionUrl, remote };
}

function rdgenFailureHtml(actionUrl: string): string { return `<h2 class="error-header">Workflow Interrupted</h2><a href="${actionUrl}">Check GitHub Logs for error details</a>`; }
function jobsBody(failedStep: string | null): unknown {
  const steps = [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, ...(failedStep ? [{ name: failedStep, status: 'completed', conclusion: 'failure' }] : [{ name: 'Build executable', status: 'completed', conclusion: 'success' }])];
  return { total_count: 1, jobs: [{ id: 1, name: 'build', status: 'completed', conclusion: failedStep ? 'failure' : 'success', steps }] };
}

type GithubScenario = { actionUrl: string; failedStep: string | null };
function scenarioFetch(scenario: GithubScenario): FetchLike {
  return async (input: string) => {
    if (input.includes('rdgen.crayoneater.org')) return new Response(rdgenFailureHtml(scenario.actionUrl), { status: 200 });
    if (input.includes('api.github.com')) return new Response(JSON.stringify(jobsBody(scenario.failedStep)), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected fetch ${input}`);
  };
}

type Remote = ReturnType<typeof scenarioFor>['remote'];
type Seed = { userId: string; requestId: string; jobId: string; attemptId: string; protectedId: string };

async function seed(pool: pg.Pool, encryption: EncryptionService, suffix: string, remote: Remote): Promise<Seed> {
  const user = await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, role, status) VALUES ($1, 'x', 'user', 'active') RETURNING id`, [`retry-${suffix}@example.invalid`]);
  const request = await pool.query<{ id: string }>(`INSERT INTO build_requests (creator_id, display_name, technical_name) VALUES ($1, $2, $3) RETURNING id`, [user.rows[0].id, `Retry ${suffix}`, `retry-${suffix}`]);
  const job = await pool.query<{ id: string }>(`INSERT INTO build_jobs (request_id, profile, platform, version, status) VALUES ($1, 'full', 'windows', '1', 'aguardando_rdgen') RETURNING id`, [request.rows[0].id]);
  const protectedValue = encryption.encrypt(JSON.stringify(remote));
  const record = await pool.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('rdgen-remote-links', $1, $2, $3) RETURNING id`, [protectedValue.ciphertext, protectedValue.integrity, protectedValue.keyId]);
  const attempt = await pool.query<{ id: string }>(`INSERT INTO build_attempts (job_id, attempt_number, status, active, remote_uuid, remote_filename, remote_platform, remote_metadata_protected_id, remote_stage) VALUES ($1, 1, 'aguardando_rdgen', true, $2, 'acme', 'windows', $3, 'started') RETURNING id`, [job.rows[0].id, remote.uuid, record.rows[0].id]);
  return { userId: user.rows[0].id, requestId: request.rows[0].id, jobId: job.rows[0].id, attemptId: attempt.rows[0].id, protectedId: record.rows[0].id };
}

async function armNextAttempt(pool: pg.Pool, encryption: EncryptionService, remote: Remote, jobId: string, attemptNumber: number): Promise<{ attemptId: string; protectedId: string }> {
  const protectedValue = encryption.encrypt(JSON.stringify(remote));
  const record = await pool.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('rdgen-remote-links', $1, $2, $3) RETURNING id`, [protectedValue.ciphertext, protectedValue.integrity, protectedValue.keyId]);
  const attempt = await pool.query<{ id: string }>(`INSERT INTO build_attempts (job_id, attempt_number, status, active, remote_uuid, remote_filename, remote_platform, remote_metadata_protected_id, remote_stage) VALUES ($1, $2, 'aguardando_rdgen', true, $3, 'acme', 'windows', $4, 'started') RETURNING id`, [jobId, attemptNumber, remote.uuid, record.rows[0].id]);
  await pool.query(`UPDATE build_jobs SET status = 'aguardando_rdgen', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [jobId]);
  return { attemptId: attempt.rows[0].id, protectedId: record.rows[0].id };
}

async function teardown(pool: pg.Pool, context: Seed & { protectedIds: string[] }): Promise<void> {
  await pool.query('DELETE FROM build_requests WHERE id = $1', [context.requestId]).catch(() => undefined);
  for (const id of context.protectedIds) await pool.query('DELETE FROM protected_records WHERE id = $1', [id]).catch(() => undefined);
  await pool.query('DELETE FROM users WHERE id = $1', [context.userId]).catch(() => undefined);
}

function runnerFor(pool: pg.Pool, encryption: EncryptionService, scenario: GithubScenario): RdgenJobRunner {
  const fetch = scenarioFetch(scenario);
  const provider = new RdgenProvider({ fetch });
  const store = new ActionTelemetryStore(pool, new ActionJobsClient({ fetch }));
  // Test seam: only the durable outbox row is under test, not the BullMQ publish side.
  const queue = { add: async () => undefined } as unknown as Queue;
  return new RdgenJobRunner(pool, queue, encryption, provider, 15_000, 0, store);
}

test('infrastructure failures retry twice inside one guarded transaction and exhaust terminally on the third', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const encryption = new EncryptionService(Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64'), process.env.APP_ENCRYPTION_KEY_ID!);
  const { actionUrl, remote } = scenarioFor('47110816');
  const seeded = await seed(pool, encryption, 'cycle', remote);
  const protectedIds = [seeded.protectedId];
  try {
    const runner = runnerFor(pool, encryption, { actionUrl, failedStep: 'Install vcpkg dependencies' });
    await runner.run(seeded.jobId);
    let job = await pool.query<{ status: string; counter: number; errorCode: string | null }>(`SELECT status, consecutive_workflow_infrastructure_failures AS counter, last_error_code AS "errorCode" FROM build_jobs WHERE id = $1`, [seeded.jobId]);
    assert.equal(job.rows[0].status, 'aguardando_retry');
    assert.equal(job.rows[0].counter, 1);
    assert.equal(job.rows[0].errorCode, 'workflow_infrastructure');
    let attempt = await pool.query<{ status: string; active: boolean; errorCode: string | null; telemetry: { source: string; percentage: number | null; stale: boolean } | null }>(`SELECT status, active, error_code AS "errorCode", action_telemetry AS telemetry FROM build_attempts WHERE id = $1`, [seeded.attemptId]);
    assert.equal(attempt.rows[0].active, false);
    assert.equal(attempt.rows[0].status, 'falhou');
    assert.equal(attempt.rows[0].errorCode, 'workflow_infrastructure');
    assert.equal(attempt.rows[0].telemetry?.percentage, 100);
    assert.equal(attempt.rows[0].telemetry?.stale, false);
    const outbox = await pool.query<{ kind: string }>('SELECT kind FROM job_outbox WHERE job_id = $1', [seeded.jobId]);
    assert.equal(outbox.rows.some((row) => row.kind === 'dispatch'), true);

    // A duplicate dispatch of the already-rescheduled job must change nothing.
    await runner.run(seeded.jobId);
    job = await pool.query<{ status: string; counter: number }>('SELECT status, consecutive_workflow_infrastructure_failures AS counter FROM build_jobs WHERE id = $1', [seeded.jobId]);
    assert.equal(job.rows[0].status, 'aguardando_retry');
    assert.equal(job.rows[0].counter, 1);
    const attemptsAfterDuplicate = await pool.query('SELECT id FROM build_attempts WHERE job_id = $1', [seeded.jobId]);
    assert.equal(attemptsAfterDuplicate.rowCount, 1);

    const second = await armNextAttempt(pool, encryption, remote, seeded.jobId, 2); protectedIds.push(second.protectedId);
    await runner.run(seeded.jobId);
    job = await pool.query<{ status: string; counter: number }>('SELECT status, consecutive_workflow_infrastructure_failures AS counter FROM build_jobs WHERE id = $1', [seeded.jobId]);
    assert.equal(job.rows[0].status, 'aguardando_retry');
    assert.equal(job.rows[0].counter, 2);

    const third = await armNextAttempt(pool, encryption, remote, seeded.jobId, 3); protectedIds.push(third.protectedId);
    await runner.run(seeded.jobId);
    job = await pool.query<{ status: string; counter: number; errorCode: string | null }>('SELECT status, consecutive_workflow_infrastructure_failures AS counter, last_error_code AS "errorCode" FROM build_jobs WHERE id = $1', [seeded.jobId]);
    assert.equal(job.rows[0].status, 'falhou');
    assert.equal(job.rows[0].counter, 3);
    assert.equal(job.rows[0].errorCode, 'workflow_retry_exhausted');
    attempt = await pool.query<{ status: string; errorCode: string | null }>(`SELECT status, error_code AS "errorCode" FROM build_attempts WHERE id = $1`, [third.attemptId]);
    assert.equal(attempt.rows[0].status, 'falhou');
    assert.equal(attempt.rows[0].errorCode, 'workflow_infrastructure');
  } finally {
    await pool.query('DELETE FROM action_snapshots WHERE run_id = $1', ['47110816']).catch(() => undefined);
    await teardown(pool, { ...seeded, protectedIds }); await pool.end();
  }
});

test('unrecognized workflow failures stay terminal and reset the consecutive counter', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const encryption = new EncryptionService(Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64'), process.env.APP_ENCRYPTION_KEY_ID!);
  const { actionUrl, remote } = scenarioFor('47110817');
  const seeded = await seed(pool, encryption, 'unrecognized', remote);
  const protectedIds = [seeded.protectedId];
  try {
    await pool.query('UPDATE build_jobs SET consecutive_workflow_infrastructure_failures = 2 WHERE id = $1', [seeded.jobId]);
    await runnerFor(pool, encryption, { actionUrl, failedStep: 'Build executable' }).run(seeded.jobId);
    const job = await pool.query<{ status: string; counter: number; errorCode: string | null }>('SELECT status, consecutive_workflow_infrastructure_failures AS counter, last_error_code AS "errorCode" FROM build_jobs WHERE id = $1', [seeded.jobId]);
    assert.equal(job.rows[0].status, 'falhou');
    assert.equal(job.rows[0].counter, 0);
    assert.equal(job.rows[0].errorCode, null);
    const outbox = await pool.query('SELECT id FROM job_outbox WHERE job_id = $1 AND kind = \'dispatch\'', [seeded.jobId]);
    assert.equal(outbox.rowCount, 0);
  } finally {
    await pool.query('DELETE FROM action_snapshots WHERE run_id = $1', ['47110817']).catch(() => undefined);
    await teardown(pool, { ...seeded, protectedIds }); await pool.end();
  }
});

test('snapshot cache honors the TTL, keeps stale data under rate limits, and prunes terminal snapshots after 24 hours', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { actionUrl } = scenarioFor('47110818');
  try {
    let fetches = 0; let rateLimited = false;
    const countingFetch: FetchLike = async (input: string) => {
      if (input.includes('api.github.com')) {
        fetches += 1;
        if (rateLimited) return new Response('rate limit', { status: 403 });
        return new Response(JSON.stringify(jobsBody('Install vcpkg dependencies')), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${input}`);
    };
    const fresh = new ActionTelemetryStore(pool, new ActionJobsClient({ fetch: countingFetch }), 600_000);
    const first = await fresh.refresh(actionUrl);
    assert.equal(first?.fetchError, null);
    assert.equal(ActionTelemetryStore.telemetry(first!).percentage, 100);
    await fresh.refresh(actionUrl);
    assert.equal(fetches, 1, 'fresh TTL window must not refetch');
    rateLimited = true;
    // TTL zero always misses the freshness window without depending on the wall clock.
    const expired = new ActionTelemetryStore(pool, new ActionJobsClient({ fetch: countingFetch }), 0);
    const stale = await expired.refresh(actionUrl);
    assert.equal(fetches, 2);
    assert.equal(stale?.fetchError, 'rate_limited');
    assert.equal(ActionTelemetryStore.telemetry(stale!).stale, true);
    assert.equal(ActionTelemetryStore.telemetry(stale!).percentage, 100, 'stale snapshot keeps the last good data');
    assert.equal(ActionTelemetryStore.decisionSnapshot(stale), undefined, 'stale data never authorizes a retry');

    await pool.query(`INSERT INTO action_snapshots (run_id, source, snapshot, complete, terminal, observed_at, attempted_at) VALUES ('999', $1, '{}', true, true, now() - interval '25 hours', now() - interval '25 hours')`, [actionUrl]);
    await pool.query(`INSERT INTO action_snapshots (run_id, source, snapshot, complete, terminal, observed_at, attempted_at) VALUES ('998', $1, '{}', true, false, now() - interval '25 hours', now() - interval '25 hours')`, [actionUrl]);
    const pruned = await sweepTerminalActionSnapshots(pool);
    assert.ok(pruned >= 1);
    const survivors = await pool.query<{ run_id: string }>('SELECT run_id FROM action_snapshots WHERE run_id IN ($1, $2)', ['47110818', '998']);
    assert.equal(survivors.rows.some((row) => row.run_id === '998'), true, 'non-terminal snapshots survive the prune');
    assert.equal(survivors.rows.some((row) => row.run_id === '47110818'), true, 'young snapshots survive the prune');
  } finally {
    await pool.query('DELETE FROM action_snapshots WHERE run_id IN ($1, $2)', ['47110818', '998']).catch(() => undefined);
    await pool.end();
  }
});
