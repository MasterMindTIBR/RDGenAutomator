import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EncryptionService, loadEnvironment } from '@rdgen/domain';
import pg from 'pg';
import { provisionAndVerifyStartupSentinel } from './client.js';

const environment = loadEnvironment();
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const pool = new pg.Pool({ connectionString: environment.DATABASE_URL });

try {
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
      if (applied.rowCount === 0) {
        await client.query(await readFile(join(migrationsDirectory, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        console.log(`Applied migration ${file}`);
      } else console.log(`Migration already applied ${file}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  await provisionAndVerifyStartupSentinel(pool, new EncryptionService(environment.APP_ENCRYPTION_KEY, environment.APP_ENCRYPTION_KEY_ID));
} finally { await pool.end(); }
