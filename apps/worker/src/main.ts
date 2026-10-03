import { createServer } from 'node:http';
import { Queue, Worker } from 'bullmq';
import { EncryptionService, ensureProtectedStorage, loadEnvironment, RdgenProvider, sweepTemporaryConfigurations } from '@rdgen/domain';
import { Redis } from 'ioredis';
import pg from 'pg';
import { OutboxDispatcher, RdgenJobRunner } from './lifecycle.js';
import { RetentionService } from './retention.js';

async function bootstrap(): Promise<void> {
  const environment = loadEnvironment();
  const encryption = new EncryptionService(environment.APP_ENCRYPTION_KEY, environment.APP_ENCRYPTION_KEY_ID);
  const pool = new pg.Pool({ connectionString: environment.DATABASE_URL });
  const connection = new Redis(environment.REDIS_URL, { maxRetriesPerRequest: null });
  await ensureProtectedStorage(environment.APP_STORAGE_PATH);
  await sweepTemporaryConfigurations(environment.APP_STORAGE_PATH);
  await pool.query('SELECT 1');
  await connection.ping();
  const sentinel = await pool.query<{ ciphertext: string; integrity: string; keyId: string }>('SELECT ciphertext, integrity, key_id AS "keyId" FROM protected_sentinels WHERE name = $1', ['startup']);
  if (sentinel.rowCount !== 1) throw new Error('Encryption startup validation failed: protected startup sentinel is missing');
  encryption.verifySentinel(sentinel.rows[0]);
  const queue = new Queue('rdgen-builds', { connection });
  const dispatcher = new OutboxDispatcher(pool, queue);
  const runner = new RdgenJobRunner(pool, queue, encryption, new RdgenProvider(), 15_000, environment.RDGEN_START_DELAY_SECONDS * 1000, environment.APP_STORAGE_PATH);
  const retention = new RetentionService(pool, environment.APP_STORAGE_PATH);
  const worker = new Worker('rdgen-builds', async (job) => runner.run(String(job.data.jobId)), { connection, concurrency: 1 });
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);

  const heartbeat = async () => {
    await pool.query(
      `INSERT INTO service_heartbeats (service, last_seen_at, metadata)
       VALUES ('worker', now(), '{"queue":"rdgen-builds"}'::jsonb)
       ON CONFLICT (service) DO UPDATE SET last_seen_at = excluded.last_seen_at, metadata = excluded.metadata`
    );
  };
  await heartbeat();
  await dispatcher.recover();
  await dispatcher.publishReady();
  await retention.run();
  const dispatchInterval = setInterval(() => { void dispatcher.recover().then(() => dispatcher.publishReady()).catch((error) => console.error(`Worker outbox failed: ${error instanceof Error ? error.message : 'unknown error'}`)); }, 1_000);
  const interval = setInterval(() => { void heartbeat().catch((error) => console.error(`Worker heartbeat failed: ${error instanceof Error ? error.message : 'unknown error'}`)); }, 10_000);
  const retentionInterval = setInterval(() => { void retention.run().catch((error) => console.error(`Worker retention failed: ${error instanceof Error ? error.message : 'unknown error'}`)); }, 60_000);
  const server = createServer(async (request, response) => {
    if (request.url !== '/health') { response.writeHead(404); response.end(); return; }
    try {
      await Promise.all([pool.query('SELECT 1'), connection.ping(), ensureProtectedStorage(environment.APP_STORAGE_PATH)]);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ready', dependencies: { postgres: { ready: true }, redis: { ready: true }, storage: { ready: true }, queue: { ready: true }, encryption: { ready: Boolean(encryption) } } }));
    } catch (error) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'degraded', detail: error instanceof Error ? error.message : 'unavailable' }));
    }
  });
  server.listen(environment.WORKER_PORT, environment.APP_BIND_HOST, () => console.log(`Worker ready on http://${environment.APP_BIND_HOST}:${environment.WORKER_PORT}`));
  const shutdown = async () => {
    clearInterval(interval);
    clearInterval(dispatchInterval);
    clearInterval(retentionInterval);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await worker.close();
    await queue.close();
    await connection.quit();
    await pool.end();
  };
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
}

void bootstrap().catch((error) => {
  console.error(`Worker startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
