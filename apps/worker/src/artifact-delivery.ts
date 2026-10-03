import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { artifactStorageKey, contentTypeFor, copyAndHashArtifact, validateArtifactFormat, validateNormalizedManifest, type DownloadManifest, type EncryptionService, type RemoteBuild } from '@rdgen/domain';

type ArtifactProvider = { downloadArtifact(remote: RemoteBuild, artifact: { filename: string; url: string }): Promise<{ url: string; contentType: string | null; body: ReadableStream<Uint8Array> }> };
export type DeliveryResult = { valid: number; expected: number; partial: boolean };

/** Persists only verified bytes. URL-bearing provenance is encrypted before it reaches PostgreSQL. */
export class ArtifactDelivery {
  private readonly root: string;
  constructor(private readonly pool: Pool, private readonly encryption: EncryptionService, storagePath: string, private readonly provider: ArtifactProvider) { this.root = resolve(storagePath); }
  async deliver(jobId: string, remote: RemoteBuild, manifest: DownloadManifest): Promise<DeliveryResult> {
    const entries = validateNormalizedManifest(manifest, remote); let valid = 0;
    for (const entry of entries) {
      try { await this.persist(jobId, remote, entry); valid += 1; }
      catch { /* A bad/missing member is deliberately isolated so valid members remain available. */ }
    }
    return { valid, expected: entries.length, partial: valid > 0 && valid < entries.length };
  }
  private pathFor(key: string): string {
    const path = resolve(this.root, key); const inside = relative(this.root, path);
    if (!inside || inside.startsWith('..') || inside.includes('..\\') || !inside.startsWith('generated/artifacts/')) throw new Error('Refusing an artifact path outside the protected generated root');
    return path;
  }
  private async persist(jobId: string, remote: RemoteBuild, entry: { filename: string; url: string }): Promise<void> {
    const downloaded = await this.provider.downloadArtifact(remote, entry);
    const key = artifactStorageKey(jobId); const finalPath = this.pathFor(key); const temporaryPath = `${finalPath}.partial-${randomUUID()}`;
    let finalCreated = false;
    try {
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      const file = await open(temporaryPath, 'wx', 0o600);
      let measured: { bytes: number; sha256: string; prefix: Buffer; suffix: Buffer };
      try { measured = await copyAndHashArtifact(downloaded.body, async (chunk) => { await file.write(chunk); }, downloaded.contentType); }
      finally { await file.close(); }
      validateArtifactFormat(entry.filename, measured.prefix, measured.suffix);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const provenance = this.encryption.encrypt(JSON.stringify({ remote, filename: entry.filename, sourceUrl: downloaded.url, sha256: measured.sha256, bytes: measured.bytes }));
        const record = await client.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('artifact-immutable-provenance', $1, $2, $3) RETURNING id`, [provenance.ciphertext, provenance.integrity, provenance.keyId]);
        await rename(temporaryPath, finalPath); finalCreated = true;
        await client.query(
          `INSERT INTO artifacts (job_id, storage_key, filename, sha256, bytes, content_type, provenance_protected_id, retention_expires_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, now() + (s.artifact_retention_days * interval '1 day') FROM system_settings s WHERE s.id = true`,
          [jobId, key, entry.filename, measured.sha256, measured.bytes, contentTypeFor(entry.filename), record.rows[0].id]
        );
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
    } catch (error) {
      if (finalCreated) await rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    } finally { await rm(temporaryPath, { force: true }).catch(() => undefined); }
  }
}
