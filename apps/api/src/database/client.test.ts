import assert from 'node:assert/strict';
import test from 'node:test';
import { EncryptionService, type ProtectedValue } from '@rdgen/domain';
import type { Pool } from 'pg';
import { provisionAndVerifyStartupSentinel, verifyStartupSentinel } from './client.js';

test('rejects a missing startup sentinel after provisioning', async () => {
  const encryption = new EncryptionService(Buffer.alloc(32, 9), 'test-key-1');
  let sentinel: ProtectedValue | undefined;
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('SELECT ciphertext')) return sentinel ? { rowCount: 1, rows: [sentinel] } : { rowCount: 0, rows: [] };
    if (sql.startsWith('INSERT INTO protected_sentinels')) {
      sentinel = { ciphertext: String(values[1]), integrity: String(values[2]), keyId: String(values[3]) };
    }
    return { rowCount: 0, rows: [] };
  };
  const pool = {
    connect: async () => ({ query, release: () => undefined }),
    query
  } as unknown as Pool;

  await provisionAndVerifyStartupSentinel(pool, encryption);
  sentinel = undefined;
  await assert.rejects(() => verifyStartupSentinel(pool, encryption), /Protected startup sentinel is missing/);
});
