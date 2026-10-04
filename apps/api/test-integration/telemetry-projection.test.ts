import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { presentRequestWithJobs } from '../src/requests/requests.service.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'integration tests require DATABASE_URL from the runner');

const telemetry = {
  source: 'https://github.com/bryangerlach/rdgen/actions/runs/47110815',
  observedAt: '2026-10-04T12:00:00.000Z',
  stale: false,
  fetchError: null,
  complete: true,
  status: 'in_progress',
  conclusion: null,
  step: 'Install vcpkg dependencies',
  percentage: 42
};

test('request projection returns safe telemetry per job and never a capability URL', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let requestId = ''; let userId = '';
  try {
    const user = await client.query<{ id: string }>(`INSERT INTO users (email, password_hash, role, status) VALUES ($1, 'x', 'user', 'active') RETURNING id`, [`projection-${Date.now()}@example.invalid`]);
    userId = user.rows[0].id;
    const request = await client.query<{ id: string }>(`INSERT INTO build_requests (creator_id, display_name, technical_name) VALUES ($1, 'Projection', 'projection') RETURNING id`, [userId]);
    requestId = request.rows[0].id;
    const withTelemetry = await client.query<{ id: string }>(`INSERT INTO build_jobs (request_id, profile, platform, version, status) VALUES ($1, 'full', 'windows', '1', 'aguardando_rdgen') RETURNING id`, [requestId]);
    const withoutTelemetry = await client.query<{ id: string }>(`INSERT INTO build_jobs (request_id, profile, platform, version, status) VALUES ($1, 'qs', 'linux', '1', 'enfileirado') RETURNING id`, [requestId]);
    await client.query(`INSERT INTO build_attempts (job_id, attempt_number, status, active, action_telemetry) VALUES ($1, 1, 'aguardando_rdgen', true, $2::jsonb)`, [withTelemetry.rows[0].id, JSON.stringify(telemetry)]);
    await client.query(`INSERT INTO build_attempts (job_id, attempt_number, status, active) VALUES ($1, 1, 'iniciando', false)`, [withoutTelemetry.rows[0].id]);
    // An older closed attempt without telemetry must lose to the latest attempt of the same job.
    await client.query(`INSERT INTO build_attempts (job_id, attempt_number, status, active, ended_at, action_telemetry) VALUES ($1, 2, 'falhou', false, now(), $2::jsonb)`, [withoutTelemetry.rows[0].id, JSON.stringify({ ...telemetry, percentage: 7 })]);

    const projection = await presentRequestWithJobs(client, requestId);
    assert.equal(projection.request.displayName, 'Projection');
    assert.equal(projection.jobs.length, 2);
    const windows = projection.jobs.find((job) => job.id === withTelemetry.rows[0].id);
    const linux = projection.jobs.find((job) => job.id === withoutTelemetry.rows[0].id);
    assert.deepEqual(windows?.actionTelemetry, telemetry);
    assert.ok(linux?.actionTelemetry && typeof linux.actionTelemetry === 'object' && 'percentage' in linux.actionTelemetry);
    assert.equal(linux.actionTelemetry.percentage, 7, 'latest attempt wins even when inactive');
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes('check_for_file'), false);
    assert.equal(serialized.includes('statusUrl'), false);
    assert.equal(serialized.includes('ciphertext'), false);
  } finally {
    if (requestId) await client.query('DELETE FROM build_requests WHERE id = $1', [requestId]).catch(() => undefined);
    if (userId) await client.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
    client.release(); await pool.end();
  }
});
