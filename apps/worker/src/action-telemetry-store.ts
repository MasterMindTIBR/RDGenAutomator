import { ActionJobsClient, canonicalActionRunUrl, emptyActionSnapshot, extractActionRunId, type NormalizedActionSnapshot } from '@rdgen/domain';
import type { Pool } from 'pg';

type SnapshotRow = { runId: string; source: string; snapshot: NormalizedActionSnapshot; complete: boolean; terminal: boolean; observedAt: Date; attemptedAt: Date; fetchError: string | null };
/** The safe projection persisted on attempts and returned by request detail; capability URLs never appear here. */
export type SafeActionTelemetry = {
  source: string; observedAt: string; stale: boolean; fetchError: string | null;
  complete: boolean; status: NormalizedActionSnapshot['status']; conclusion: NormalizedActionSnapshot['conclusion']; step: string | null; percentage: number | null;
};

function rowOf(result: { runId: string; source: string; snapshot: unknown; complete: boolean; terminal: boolean; observedAt: Date; attemptedAt: Date; fetchError: string | null }): SnapshotRow {
  // The cache row is written exclusively by this store, so the persisted blob only needs a structural cast.
  return { ...result, snapshot: result.snapshot as NormalizedActionSnapshot };
}

/**
 * Shared, persisted snapshot cache keyed by validated run ID. A fresh row is
 * served for the TTL window; a failed fetch keeps the previous snapshot, marks
 * it stale, and never triggers any automatic retry by itself.
 */
export class ActionTelemetryStore {
  constructor(private readonly pool: Pool, private readonly client: ActionJobsClient = new ActionJobsClient(), private readonly ttlMs = 90_000) {}

  async refresh(actionUrl: string | undefined): Promise<SnapshotRow | undefined> {
    const runId = extractActionRunId(actionUrl);
    if (!runId) return undefined;
    const existing = await this.pool.query(
      `SELECT run_id AS "runId", source, snapshot, complete, terminal, observed_at AS "observedAt", attempted_at AS "attemptedAt", fetch_error AS "fetchError"
       FROM action_snapshots WHERE run_id = $1`, [runId]
    );
    const current = existing.rows[0] as SnapshotRow | undefined;
    if (current && Date.now() - new Date(current.attemptedAt).getTime() < this.ttlMs) return rowOf(current);
    const source = canonicalActionRunUrl(runId);
    const result = await this.client.fetchSnapshot(runId);
    if (result.ok) {
      const snapshot = result.snapshot;
      const upserted = await this.pool.query(
        `INSERT INTO action_snapshots (run_id, source, snapshot, complete, terminal, observed_at, attempted_at, fetch_error)
         VALUES ($1, $2, $3::jsonb, $4, $5, now(), now(), NULL)
         ON CONFLICT (run_id) DO UPDATE SET source = EXCLUDED.source, snapshot = EXCLUDED.snapshot, complete = EXCLUDED.complete,
           terminal = EXCLUDED.terminal, observed_at = now(), attempted_at = now(), fetch_error = NULL
         RETURNING run_id AS "runId", source, snapshot, complete, terminal, observed_at AS "observedAt", attempted_at AS "attemptedAt", fetch_error AS "fetchError"`,
        [runId, source, JSON.stringify(snapshot), snapshot.complete, snapshot.status === 'completed']
      );
      return rowOf(upserted.rows[0]);
    }
    const failed = await this.pool.query(
      `INSERT INTO action_snapshots (run_id, source, snapshot, complete, terminal, observed_at, attempted_at, fetch_error)
       VALUES ($1, $2, $3::jsonb, false, false, now(), now(), $4)
       ON CONFLICT (run_id) DO UPDATE SET source = EXCLUDED.source, attempted_at = now(), fetch_error = EXCLUDED.fetch_error
       RETURNING run_id AS "runId", source, snapshot, complete, terminal, observed_at AS "observedAt", attempted_at AS "attemptedAt", fetch_error AS "fetchError"`,
      [runId, source, JSON.stringify(current?.snapshot ?? emptyActionSnapshot(runId)), result.failure]
    );
    return rowOf(failed.rows[0]);
  }

  static telemetry(row: SnapshotRow): SafeActionTelemetry {
    return {
      source: row.source,
      observedAt: new Date(row.observedAt).toISOString(),
      stale: row.fetchError !== null,
      fetchError: row.fetchError,
      complete: row.complete,
      status: row.snapshot.status,
      conclusion: row.snapshot.conclusion,
      step: row.snapshot.activeStep,
      percentage: row.snapshot.percentage
    };
  }

  /** A snapshot authorizes a retry decision only when the latest fetch succeeded and was complete. */
  static decisionSnapshot(row: SnapshotRow | undefined): NormalizedActionSnapshot | undefined {
    return row && row.fetchError === null ? row.snapshot : undefined;
  }
}

/** Terminal snapshots are pruned after 24 hours; final telemetry was already persisted on the attempt. */
export async function sweepTerminalActionSnapshots(pool: Pool): Promise<number> {
  const result = await pool.query('DELETE FROM action_snapshots WHERE terminal AND observed_at < now() - interval \'24 hours\'');
  return result.rowCount ?? 0;
}
