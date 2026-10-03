import assert from 'node:assert/strict';
import test from 'node:test';
import { EncryptionService } from './encryption.js';

const key = Buffer.alloc(32, 7);

test('derives separated keys and round-trips protected values', () => {
  const encryption = new EncryptionService(key, 'test-key-1');
  assert.notDeepEqual(encryption.encryptionKey, encryption.integrityKey);
  const value = encryption.encrypt('sensitive value');
  assert.equal(value.keyId, 'test-key-1');
  assert.equal(encryption.decrypt(value).toString(), 'sensitive value');
});

test('rejects ciphertext and integrity tampering', () => {
  const encryption = new EncryptionService(key, 'test-key-1');
  const value = encryption.encrypt('sensitive value');
  assert.throws(() => encryption.decrypt({ ...value, integrity: `${value.integrity}x` }));
  assert.throws(() => encryption.decrypt({ ...value, ciphertext: `${value.ciphertext}x` }));
});

test('fails closed for a wrong key or key ID', () => {
  const original = new EncryptionService(key, 'test-key-1').createSentinel();
  assert.throws(() => new EncryptionService(Buffer.alloc(32, 8), 'test-key-1').verifySentinel(original));
  assert.throws(() => new EncryptionService(key, 'test-key-2').verifySentinel(original));
});
