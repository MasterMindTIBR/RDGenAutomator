import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { companyAdminInputSchema } from '@rdgen/domain';
import { CompaniesController } from '../src/admin/companies.controller.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'integration tests require DATABASE_URL from the runner');

type Actor = { userId: string; role: 'administrator' | 'user' };
function controllerFor(pool: pg.Pool, actor: Actor): CompaniesController {
  const sessions = { authenticate: async () => actor, assertCsrf: () => undefined } as never;
  const audit = { record: async () => undefined } as never;
  return new CompaniesController(pool, sessions, audit);
}

test('company schema normalizes blank defaults to undefined and validates technical names', () => {
  const parsed = companyAdminInputSchema.parse({ name: 'Acme', serverId: '00000000-0000-4000-8000-000000000001', isPublic: false, defaultDisplayName: '', defaultTechnicalName: '' });
  assert.equal(parsed.defaultDisplayName, undefined);
  assert.equal(parsed.defaultTechnicalName, undefined);
  assert.equal(companyAdminInputSchema.parse({ name: 'Acme', serverId: '00000000-0000-4000-8000-000000000001', isPublic: false, defaultDisplayName: 'Acme Support', defaultTechnicalName: 'acme-support' }).defaultTechnicalName, 'acme-support');
  assert.equal(companyAdminInputSchema.safeParse({ name: 'Acme', serverId: '00000000-0000-4000-8000-000000000001', isPublic: false, defaultTechnicalName: 'bad name!' }).success, false);
});

test('company detail returns history with the latest execution and only surviving artifacts, admin-only', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const suffix = `company-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const admin = await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, role, status) VALUES ($1, 'x', 'administrator', 'active') RETURNING id`, [`co-admin-${suffix}@example.invalid`]);
  const other = await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, role, status) VALUES ($1, 'x', 'user', 'active') RETURNING id`, [`co-other-${suffix}@example.invalid`]);
  const server = await pool.query<{ id: string }>(`INSERT INTO rustdesk_servers (name) VALUES ($1) RETURNING id`, [`co-server-${suffix}`]);
  const company = await pool.query<{ id: string }>(`INSERT INTO companies (name, server_id, default_display_name, default_technical_name) VALUES ($1, $2, 'Default Display', 'default-tech') RETURNING id`, [`co-${suffix}`, server.rows[0].id]);
  const companyId = company.rows[0].id;
  const older = await pool.query<{ id: string }>(`INSERT INTO build_requests (creator_id, display_name, technical_name, company_id) VALUES ($1, 'Older', 'older', $2) RETURNING id`, [admin.rows[0].id, companyId]);
  const newer = await pool.query<{ id: string }>(`INSERT INTO build_requests (creator_id, display_name, technical_name, company_id) VALUES ($1, 'Newer', 'newer', $2) RETURNING id`, [admin.rows[0].id, companyId]);
  async function jobWith(requestId: string, platform: string, status: string, endedAgoMs: number): Promise<string> {
    const job = await pool.query<{ id: string }>(`INSERT INTO build_jobs (request_id, profile, platform, version, status) VALUES ($1, 'full', $2, '1', $3) RETURNING id`, [requestId, platform, status]);
    await pool.query(`INSERT INTO build_attempts (job_id, attempt_number, status, active, ended_at) VALUES ($1, 1, $2, false, now() - ($3 * interval '1 millisecond'))`, [job.rows[0].id, status, endedAgoMs]);
    return job.rows[0].id;
  }
  async function artifact(jobId: string, filename: string, opts: { tombstoned?: boolean; expired?: boolean } = {}): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO artifacts (job_id, storage_key, filename, sha256, bytes, content_type, retention_expires_at, tombstoned_at)
       VALUES ($1, $2, $3, 'abc', 1024, 'application/octet-stream', CASE WHEN $4 THEN now() - interval '1 day' ELSE now() + interval '1 day' END, CASE WHEN $5 THEN now() ELSE NULL END) RETURNING id`,
      [jobId, `generated/artifacts/${Math.random().toString(16).slice(2)}`, filename, opts.expired ?? false, opts.tombstoned ?? false]);
    return row.rows[0].id;
  }
  try {
    const olderWin = await jobWith(older.rows[0].id, 'windows', 'concluído', 60_000);
    await artifact(olderWin, 'older.exe');
    const newerWin = await jobWith(newer.rows[0].id, 'windows', 'concluído', 30_000);
    await artifact(newerWin, 'acme-support.exe');
    await artifact(newerWin, 'acme-support-tombstoned.exe', { tombstoned: true });
    await artifact(newerWin, 'acme-support-expired.exe', { expired: true });
    const newerLinux = await jobWith(newer.rows[0].id, 'linux', 'concluído_parcial', 20_000);
    await artifact(newerLinux, 'acme-support-linux.deb');

    const controller = controllerFor(pool, { userId: admin.rows[0].id, role: 'administrator' });
    const result = await controller.detail(companyId, { headers: {} });
    assert.equal(result.requests.length, 2);
    assert.equal(result.requests[0].technicalName, 'newer', 'requests are ordered newest first');
    assert.equal(result.requests[1].technicalName, 'older');
    const windows = result.requests[0].executions.find((execution) => execution.platform === 'windows');
    const linux = result.requests[0].executions.find((execution) => execution.platform === 'linux');
    assert.equal(windows?.status, 'concluído');
    assert.deepEqual(windows?.artifacts.map((artifact) => artifact.filename), ['acme-support.exe'], 'tombstoned and expired artifacts are excluded');
    assert.equal(linux?.status, 'concluído_parcial');
    assert.deepEqual(linux?.artifacts.map((artifact) => artifact.filename), ['acme-support-linux.deb']);

    const nonAdmin = controllerFor(pool, { userId: other.rows[0].id, role: 'user' });
    await assert.rejects(() => nonAdmin.detail(companyId, { headers: {} }), /Administrator access required/i);
  } finally {
    await pool.query('DELETE FROM build_requests WHERE id IN ($1, $2)', [older.rows[0].id, newer.rows[0].id]).catch(() => undefined);
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]).catch(() => undefined);
    await pool.query(`DELETE FROM rustdesk_servers WHERE name = $1`, [`co-server-${suffix}`]).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [admin.rows[0].id, other.rows[0].id]).catch(() => undefined);
    await pool.end();
  }
});
