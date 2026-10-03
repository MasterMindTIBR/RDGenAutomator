import { EncryptionService, loadEnvironment, loadRotationEnvironment, type ProtectedValue } from '@rdgen/domain';
import pg from 'pg';
import { verifyStartupSentinel } from './client.js';

const environment = loadEnvironment();
const replacement = loadRotationEnvironment();
if (replacement.keyId === environment.APP_ENCRYPTION_KEY_ID) throw new Error('New encryption key ID must differ from the current key ID');
const oldEncryption = new EncryptionService(environment.APP_ENCRYPTION_KEY, environment.APP_ENCRYPTION_KEY_ID);
const newEncryption = new EncryptionService(replacement.key, replacement.keyId);
const pool = new pg.Pool({ connectionString: environment.DATABASE_URL });

try {
  await verifyStartupSentinel(pool, oldEncryption);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('rdgen-automator-encryption-rotation'))");
    const sentinel = await client.query<ProtectedValue>('SELECT ciphertext, integrity, key_id AS "keyId" FROM protected_sentinels WHERE name = $1 FOR UPDATE', ['startup']);
    oldEncryption.verifySentinel(sentinel.rows[0]);
    const records = await client.query<ProtectedValue & { id: string }>('SELECT id, ciphertext, integrity, key_id AS "keyId" FROM protected_records FOR UPDATE');
    for (const record of records.rows) {
      const reencrypted = newEncryption.encrypt(oldEncryption.decrypt(record));
      await client.query('UPDATE protected_records SET ciphertext = $1, integrity = $2, key_id = $3, updated_at = now() WHERE id = $4', [reencrypted.ciphertext, reencrypted.integrity, reencrypted.keyId, record.id]);
    }
    const newSentinel = newEncryption.encrypt(oldEncryption.decrypt(sentinel.rows[0]));
    await client.query('UPDATE protected_sentinels SET ciphertext = $1, integrity = $2, key_id = $3, updated_at = now() WHERE name = $4', [newSentinel.ciphertext, newSentinel.integrity, newSentinel.keyId, 'startup']);
    await client.query('COMMIT');
    console.log(`Rotated ${records.rowCount} protected record(s) to key ID ${replacement.keyId}; update APP_ENCRYPTION_KEY and APP_ENCRYPTION_KEY_ID before restarting services.`);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
} finally { await pool.end(); }
