import 'reflect-metadata';
import { NestFactory, NestApplication } from '@nestjs/core';
import { EncryptionService, ensureProtectedStorage, loadEnvironment } from '@rdgen/domain';
import { Redis } from 'ioredis';
import pg from 'pg';
import { createAppModule } from './app.module.js';
import { verifyStartupSentinel } from './database/client.js';

async function bootstrap(): Promise<void> {
  const environment = loadEnvironment();
  const encryption = new EncryptionService(environment.APP_ENCRYPTION_KEY, environment.APP_ENCRYPTION_KEY_ID);
  const pool = new pg.Pool({ connectionString: environment.DATABASE_URL });
  const redis = new Redis(environment.REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    await ensureProtectedStorage(environment.APP_STORAGE_PATH);
    await pool.query('SELECT 1');
    await redis.ping();
    await verifyStartupSentinel(pool, encryption);
  } catch (error) {
    await redis.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
  const app = await NestFactory.create<NestApplication>(createAppModule(environment, pool, redis, encryption), { logger: ['log', 'warn', 'error'] });
  app.useBodyParser('json', { limit: '10mb' });
  app.enableShutdownHooks();
  const closeDependencies = async () => { await redis.quit(); await pool.end(); };
  app.getHttpAdapter().getInstance().once('close', () => { void closeDependencies(); });
  await app.listen(environment.API_PORT, environment.APP_BIND_HOST);
  console.log(`API ready on http://${environment.APP_BIND_HOST}:${environment.API_PORT}`);
}

void bootstrap().catch((error) => {
  console.error(`API startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
