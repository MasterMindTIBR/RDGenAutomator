import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const SENTINEL_PLAINTEXT = 'rdgen-automator:startup-sentinel:v1';

export type ProtectedValue = { ciphertext: string; integrity: string; keyId: string };

export class EncryptionService {
  readonly encryptionKey: Buffer;
  readonly integrityKey: Buffer;

  constructor(readonly rootKey: Buffer, readonly keyId: string) {
    if (rootKey.length !== 32) throw new Error('Encryption root key must be exactly 32 bytes');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(keyId)) throw new Error('Invalid encryption key ID');
    const salt = Buffer.from(`rdgen-automator:key-id:${keyId}`, 'utf8');
    this.encryptionKey = Buffer.from(hkdfSync('sha256', rootKey, salt, Buffer.from('rdgen-automator:encryption:v1'), 32));
    this.integrityKey = Buffer.from(hkdfSync('sha256', rootKey, salt, Buffer.from('rdgen-automator:integrity:v1'), 32));
  }

  encrypt(plaintext: string | Buffer): ProtectedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encoded = [VERSION, this.keyId, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
    return { ciphertext: encoded, integrity: this.integrity(encoded), keyId: this.keyId };
  }

  decrypt(value: ProtectedValue): Buffer {
    if (value.keyId !== this.keyId) throw new Error(`Protected value key ID ${value.keyId} is unavailable`);
    this.assertIntegrity(value.ciphertext, value.integrity);
    const [version, keyId, ivValue, ciphertextValue, tagValue, ...extra] = value.ciphertext.split('.');
    if (extra.length || version !== VERSION || keyId !== this.keyId || !ivValue || !ciphertextValue || !tagValue) throw new Error('Malformed protected value');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(ivValue, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]);
    } catch {
      throw new Error('Protected value could not be decrypted');
    }
  }

  integrity(ciphertext: string): string {
    return createHmac('sha256', this.integrityKey).update(ciphertext).digest('base64url');
  }

  assertIntegrity(ciphertext: string, integrity: string): void {
    const expected = Buffer.from(this.integrity(ciphertext));
    const received = Buffer.from(integrity);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('Protected value integrity validation failed');
  }

  createSentinel(): ProtectedValue { return this.encrypt(SENTINEL_PLAINTEXT); }

  verifySentinel(value: ProtectedValue): void {
    if (this.decrypt(value).toString('utf8') !== SENTINEL_PLAINTEXT) throw new Error('Protected startup sentinel validation failed');
  }
}
