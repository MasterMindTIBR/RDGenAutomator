import { rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

type Stored = { id: string; storageKey: string };
/** One DB lease serializes sweeps; per-artifact tombstones make a claimed download win over expiry. */
export class RetentionService {
  private readonly owner = `retention-${randomUUID()}`; private readonly root: string;
  constructor(private readonly pool: Pool, storagePath: string) { this.root = resolve(storagePath); }
  async run(limit = 100): Promise<{ artifacts: number; logos: number; skipped: boolean }> {
    const claimed = await this.pool.query(`UPDATE retention_leases SET owner = $1, expires_at = now() + interval '5 minutes', updated_at = now() WHERE name = 'persistent-storage' AND (expires_at IS NULL OR expires_at < now() OR owner = $1) RETURNING name`, [this.owner]);
    if (!claimed.rowCount) return { artifacts: 0, logos: 0, skipped: true };
    try {
      const artifacts = await this.tombstoneArtifacts(limit); const logos = await this.tombstoneRequestImages(limit);
      return { artifacts, logos, skipped: false };
    } finally { await this.pool.query(`UPDATE retention_leases SET owner = NULL, expires_at = NULL, updated_at = now() WHERE name = 'persistent-storage' AND owner = $1`, [this.owner]); }
  }
  private safePath(key: string, prefix: string): string {
    const path = resolve(this.root, key); const inside = relative(this.root, path);
    if (!inside || inside.startsWith('..') || inside.includes('..\\') || !inside.startsWith(prefix)) throw new Error('Refusing retention outside protected storage');
    return path;
  }
  private async tombstoneArtifacts(limit: number): Promise<number> {
    const marked = await this.pool.query<Stored>(
      `WITH due AS (SELECT id FROM artifacts WHERE retention_expires_at <= now() AND tombstoned_at IS NULL AND (download_lease_expires_at IS NULL OR download_lease_expires_at < now()) ORDER BY retention_expires_at FOR UPDATE SKIP LOCKED LIMIT $1)
       UPDATE artifacts a SET tombstoned_at = now(), download_lease_owner = NULL, download_lease_expires_at = NULL FROM due WHERE a.id = due.id RETURNING a.id, a.storage_key AS "storageKey"`, [limit]);
    const pending = await this.pool.query<Stored>(`SELECT id, storage_key AS "storageKey" FROM artifacts WHERE tombstoned_at IS NOT NULL AND purged_at IS NULL ORDER BY tombstoned_at LIMIT $1`, [limit]);
    for (const item of [...marked.rows, ...pending.rows.filter((candidate) => !marked.rows.some((row) => row.id === candidate.id))]) {
      await rm(this.safePath(item.storageKey, 'generated/artifacts/'), { force: true });
      await this.pool.query('UPDATE artifacts SET purged_at = now() WHERE id = $1 AND tombstoned_at IS NOT NULL', [item.id]);
    }
    return marked.rowCount ?? 0;
  }
  private async tombstoneRequestImages(limit: number): Promise<number> {
    let total = 0;
    for (const slot of ['icon', 'logo', 'privacy'] as const) {
      const marked = await this.pool.query<Stored>(`WITH due AS (SELECT id FROM build_requests WHERE ${slot}_storage_key IS NOT NULL AND ${slot}_retention_expires_at <= now() AND ${slot}_tombstoned_at IS NULL ORDER BY ${slot}_retention_expires_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE build_requests r SET ${slot}_tombstoned_at = now() FROM due WHERE r.id = due.id RETURNING r.id, r.${slot}_storage_key AS "storageKey"`, [limit]);
      const pending = await this.pool.query<Stored>(`SELECT id, ${slot}_storage_key AS "storageKey" FROM build_requests WHERE ${slot}_tombstoned_at IS NOT NULL AND ${slot}_purged_at IS NULL ORDER BY ${slot}_tombstoned_at LIMIT $1`, [limit]);
      for (const item of [...marked.rows, ...pending.rows.filter((candidate) => !marked.rows.some((row) => row.id === candidate.id))]) {
        const prefix = item.storageKey.startsWith('logos/') ? 'logos/' : 'request-images/';
        await rm(this.safePath(item.storageKey, prefix), { force: true });
        await this.pool.query(`UPDATE build_requests SET ${slot}_purged_at = now() WHERE id = $1 AND ${slot}_tombstoned_at IS NOT NULL`, [item.id]);
      }
      total += marked.rowCount ?? 0;
    }
    return total;
  }
}
