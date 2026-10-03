import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RetentionService } from '../apps/worker/src/retention.js';

const execFile = promisify(execFileCallback); const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url)); const pg = require('pg'); const { Redis } = require('ioredis'); const { loadEnvironment } = require('@rdgen/domain');
async function command(file: string, args: string[]) { await execFile(file, args, { cwd: root }); }
async function main() {
  await command('docker', ['compose', 'up', '-d', 'postgres', 'redis']);
  await command(process.execPath, ['--import', 'tsx', 'apps/api/src/database/migrate.ts']);
  const environment = loadEnvironment(); const pool = new pg.Pool({ connectionString: environment.DATABASE_URL }); const redis = new Redis(environment.REDIS_URL, { maxRetriesPerRequest: null });
  const suffix = `retention-${Date.now()}-${Math.random().toString(16).slice(2)}`; const storage = join(environment.APP_STORAGE_PATH, `smoke-${suffix}`);
  try {
    await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    const owner = (await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, role, status) VALUES ($1, 'not-used', 'user', 'active') RETURNING id`, [`${suffix}@example.invalid`])).rows[0].id;
    const request = (await pool.query<{ id: string }>(`INSERT INTO build_requests (creator_id, display_name, technical_name, logo_storage_key, logo_retention_expires_at) VALUES ($1, 'retention', $2, $3, now() - interval '1 second') RETURNING id`, [owner, suffix, `logos/${suffix}.png`])).rows[0].id;
    const job = (await pool.query<{ id: string }>(`INSERT INTO build_jobs (request_id, profile, platform, status) VALUES ($1, 'full', 'windows', 'concluído') RETURNING id`, [request])).rows[0].id;
    const key = `generated/artifacts/${job}/${suffix}`;
    const artifact = (await pool.query<{ id: string }>(`INSERT INTO artifacts (job_id, storage_key, filename, sha256, bytes, content_type, retention_expires_at, download_lease_owner, download_lease_expires_at) VALUES ($1, $2, 'fixture.exe', repeat('a', 64), 98, 'application/octet-stream', now() - interval '1 second', 'active-download', now() + interval '5 minutes') RETURNING id`, [job, key])).rows[0].id;
    await mkdir(join(storage, 'generated/artifacts', job), { recursive: true, mode: 0o700 }); await mkdir(join(storage, 'logos'), { recursive: true, mode: 0o700 });
    await writeFile(join(storage, key), Buffer.from('artifact'), { mode: 0o600 }); await writeFile(join(storage, `logos/${suffix}.png`), Buffer.from('logo'), { mode: 0o600 });
    const retention = new RetentionService(pool, storage);
    await retention.run();
    assert.equal((await pool.query('SELECT 1 FROM artifacts WHERE id = $1 AND tombstoned_at IS NULL', [artifact])).rowCount, 1, 'active download was not raced');
    await pool.query(`UPDATE artifacts SET download_lease_owner = NULL, download_lease_expires_at = NULL WHERE id = $1`, [artifact]);
    await retention.run();
    assert.equal((await pool.query('SELECT 1 FROM artifacts WHERE id = $1 AND tombstoned_at IS NOT NULL AND purged_at IS NOT NULL', [artifact])).rowCount, 1);
    assert.equal((await pool.query('SELECT 1 FROM build_requests WHERE id = $1 AND logo_tombstoned_at IS NOT NULL AND logo_purged_at IS NOT NULL', [request])).rowCount, 1);
    console.log('retention smoke passed: real postgres/redis, global lease, artifact download lease, tombstones, artifact and logo purge');
  } finally { await rm(storage, { recursive: true, force: true }); await redis.quit(); await pool.end(); }
}
void main();
