import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JobsService } from '../apps/api/src/jobs/jobs.service.js';
import { OutboxDispatcher, RdgenJobRunner } from '../apps/worker/src/lifecycle.js';

const execFile = promisify(execFileCallback);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dependencies = ['postgres', 'redis'] as const;
const workerRequire = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const { Queue, Worker } = workerRequire('bullmq');
const { Redis } = workerRequire('ioredis');
const pg = workerRequire('pg');
const { EncryptionService, loadEnvironment, RdgenProvider } = workerRequire('@rdgen/domain');
type ResolvedJobConfiguration = { version: string; platform: 'windows'; exename: string; appname: string; serverIP: string; key: string; permanentPassword: string; logoStorageKey: string; custom: Record<string, string> };

async function command(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile(file, args, { cwd: repositoryRoot });
    return stdout;
  } catch (error) {
    const details = error as { stderr?: string; message: string };
    throw new Error(`Unable to run ${file} ${args.join(' ')}: ${details.stderr?.trim() || details.message}`);
  }
}

async function runningServices(): Promise<Set<string>> {
  const output = await command('docker', ['compose', 'ps', '--status', 'running', '--services']);
  return new Set(output.split(/\s+/).filter(Boolean));
}

async function waitForHealthyServices(services: readonly string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  let states = new Map<string, string>();
  while (Date.now() < deadline) {
    states = new Map(await Promise.all(services.map(async (service) => {
      const id = (await command('docker', ['compose', 'ps', '-q', service])).trim();
      if (!id) return [service, 'missing'] as const;
      const state = (await command('docker', ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id])).trim();
      return [service, state] as const;
    })));
    if (services.every((service) => states.get(service) === 'healthy')) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Local Compose dependencies did not become healthy within 30 seconds: ${[...states].map(([service, state]) => `${service}=${state}`).join(', ')}`);
}

async function main(): Promise<void> {
  const runningBefore = await runningServices();
  const ownedServices = dependencies.filter((service) => !runningBefore.has(service));
  if (ownedServices.length) await command('docker', ['compose', 'up', '-d', ...ownedServices]);

  let pool: InstanceType<typeof pg.Pool> | undefined;
  let connection: InstanceType<typeof Redis> | undefined;
  let queue: InstanceType<typeof Queue> | undefined;
  let worker: InstanceType<typeof Worker> | undefined;
  try {
    await waitForHealthyServices(dependencies);
    await command(process.execPath, ['--import', 'tsx', 'apps/api/src/database/migrate.ts']);

    const environment = loadEnvironment();
    pool = new pg.Pool({ connectionString: environment.DATABASE_URL });
    connection = new Redis(environment.REDIS_URL, { maxRetriesPerRequest: null });
    const encryption = new EncryptionService(environment.APP_ENCRYPTION_KEY, environment.APP_ENCRYPTION_KEY_ID);
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../packages/domain/src/fixtures');
    const started = await readFile(join(fixtures, 'rdgen-start.html'), 'utf8');
    const succeeded = await readFile(join(fixtures, 'rdgen-success.html'), 'utf8');
    const suffix = `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    function configuration(name: string): ResolvedJobConfiguration {
      return { version: '1.4.9', platform: 'windows', exename: name, appname: name, serverIP: 'relay.example.invalid', key: 'test-key', permanentPassword: 'test-password', logoStorageKey: 'logos/test.png', custom: {} };
    }
    async function eventually(check: () => Promise<boolean>, label: string): Promise<void> {
      for (let tries = 0; tries < 100; tries += 1) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${label}`);
    }
    async function addJob(ownerId: string, config: ResolvedJobConfiguration): Promise<string> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const request = await client.query<{ id: string }>(`INSERT INTO build_requests (creator_id, display_name, technical_name) VALUES ($1, $2, $3) RETURNING id`, [ownerId, config.appname, `${config.exename}-${suffix}`]);
        const protectedValue = encryption.encrypt(JSON.stringify(config));
        const record = await client.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('smoke-config', $1, $2, $3) RETURNING id`, [protectedValue.ciphertext, protectedValue.integrity, protectedValue.keyId]);
        const job = await client.query<{ id: string }>(`INSERT INTO build_jobs (request_id, profile, platform, version, status, resolved_configuration_protected_id) VALUES ($1, 'full', 'windows', '1.4.9', 'enfileirado', $2) RETURNING id`, [request.rows[0].id, record.rows[0].id]);
        await client.query(`INSERT INTO job_outbox (job_id, kind, idempotency_key) VALUES ($1, 'dispatch', $2)`, [job.rows[0].id, `${suffix}:${job.rows[0].id}`]);
        await client.query('COMMIT');
        return job.rows[0].id;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    }

    await pool.query('SELECT 1 FROM job_outbox LIMIT 1');
    await connection.ping();
    queue = new Queue('rdgen-builds-smoke', { connection });
    const provider = new RdgenProvider({ fetch: async (url, init) => {
      const body = String(init?.body ?? '');
      if (init?.method === 'POST' && body.includes('exename=indeterminate')) throw new TypeError('fixture lost response after send');
      if (String(url).includes('/download?')) {
        if (String(url).includes('filename=partial.msi')) return new Response(Buffer.from('<html>error</html>'.padEnd(96)), { status: 200, headers: { 'content-type': 'text/html' } });
        const binary = String(url).includes('.msi') ? Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(90)]) : Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(96)]);
        return new Response(binary, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(binary.byteLength) } });
      }
      return new Response(init?.method === 'POST' ? (body.includes('exename=partial') ? started.replaceAll('acme-support', 'partial') : started) : succeeded, { status: 200 });
    } });
    const runner = new RdgenJobRunner(pool, queue, encryption, provider, 100, environment.APP_STORAGE_PATH);
    worker = new Worker('rdgen-builds-smoke', async (job) => runner.run(String(job.data.jobId)), { connection, concurrency: 1 });
    const dispatcher = new OutboxDispatcher(pool, queue);
    await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
    const owner = await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, role, status) VALUES ($1, 'not-used', 'user', 'active') RETURNING id`, [`${suffix}@example.invalid`]);
    const first = await addJob(owner.rows[0].id, configuration('recovered'));
    await dispatcher.publishReady();
    await eventually(async () => (await pool.query(`SELECT 1 FROM build_jobs WHERE id = $1 AND status = 'aguardando_rdgen'`, [first])).rowCount === 1, 'fixture start through outbox');
    await pool.query(`UPDATE build_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [first]);
    await dispatcher.recover();
    await dispatcher.publishReady();
    await eventually(async () => (await pool.query(`SELECT 1 FROM build_jobs WHERE id = $1 AND status = 'concluído'`, [first])).rowCount === 1, 'recovered lease poll');
    if ((await pool.query(`SELECT 1 FROM artifacts WHERE job_id = $1 AND tombstoned_at IS NULL`, [first])).rowCount !== 2) throw new Error('fixture build did not persist both validated artifacts');
    const partial = await addJob(owner.rows[0].id, configuration('partial'));
    await dispatcher.publishReady();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await dispatcher.publishReady();
    await eventually(async () => (await pool.query(`SELECT 1 FROM build_jobs WHERE id = $1 AND status = 'concluído_parcial'`, [partial])).rowCount === 1, 'partial artifact delivery');
    if ((await pool.query(`SELECT 1 FROM artifacts WHERE job_id = $1 AND tombstoned_at IS NULL`, [partial])).rowCount !== 1) throw new Error('partial fixture did not preserve exactly one valid artifact');
    const uncertain = await addJob(owner.rows[0].id, configuration('indeterminate'));
    await dispatcher.publishReady();
    await eventually(async () => (await pool.query(`SELECT 1 FROM build_jobs WHERE id = $1 AND status = 'início_indeterminado'`, [uncertain])).rowCount === 1, 'indeterminate start');
    const jobs = new JobsService(pool, encryption);
    await jobs.reconcile({ userId: owner.rows[0].id, role: 'user' }, uncertain, { uuid: '11111111-1111-4111-8111-111111111111', filename: 'reconciled', platform: 'windows' });
    await dispatcher.publishReady();
    await eventually(async () => (await pool.query(`SELECT 1 FROM build_jobs WHERE id = $1 AND status = 'concluído'`, [uncertain])).rowCount === 1, 'authorized reconciliation');
    console.log('worker artifact fixture smoke passed: migrations, streamed validation, partial results, outbox dispatch, lease recovery, indeterminate start, and reconciliation');
  } finally {
    await worker?.close();
    await queue?.close();
    await connection?.quit();
    await pool?.end();
    if (ownedServices.length) await command('docker', ['compose', 'stop', ...ownedServices]);
  }
}

void main();
