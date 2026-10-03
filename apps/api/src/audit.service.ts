import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** Writes deliberately small, secret-free security and operational audit records. */
export class AuditService {
  constructor(private readonly database: Queryable) {}

  async record(actorId: string | null, action: string, subjectType: string, subjectId: string, metadata: Record<string, string | number | boolean | null> = {}): Promise<void> {
    await this.database.query(
      `INSERT INTO audit_events (actor_id, action, subject_type, subject_id, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actorId, action, subjectType, subjectId, JSON.stringify(metadata)]
    );
  }
}
