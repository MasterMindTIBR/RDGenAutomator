import { EncryptionService, type ProtectedValue } from '@rdgen/domain';
import type { Pool } from 'pg';

export async function provisionAndVerifyStartupSentinel(pool: Pool, encryption: EncryptionService): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('rdgen-automator-startup-sentinel'))");
    const existing = await client.query<ProtectedValue>('SELECT ciphertext, integrity, key_id AS "keyId" FROM protected_sentinels WHERE name = $1 FOR UPDATE', ['startup']);
    if (existing.rowCount === 0) {
      const created = encryption.createSentinel();
      await client.query('INSERT INTO protected_sentinels (name, ciphertext, integrity, key_id) VALUES ($1, $2, $3, $4)', ['startup', created.ciphertext, created.integrity, created.keyId]);
    } else {
      encryption.verifySentinel(existing.rows[0]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`Encryption startup validation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    client.release();
  }
}

export async function verifyStartupSentinel(pool: Pool, encryption: EncryptionService): Promise<void> {
  const result = await pool.query<ProtectedValue>('SELECT ciphertext, integrity, key_id AS "keyId" FROM protected_sentinels WHERE name = $1', ['startup']);
  if (result.rowCount !== 1) throw new Error('Protected startup sentinel is missing');
  encryption.verifySentinel(result.rows[0]);
}
