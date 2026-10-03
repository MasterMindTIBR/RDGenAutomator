import { Injectable } from '@nestjs/common';
import { checkProtectedStorage, EncryptionService, type AppEnvironment } from '@rdgen/domain';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { verifyStartupSentinel } from './database/client.js';

export type DependencyStatus = { ready: boolean; detail?: string };
export type HealthResponse = { status: 'ready' | 'degraded'; dependencies: Record<string, DependencyStatus> };

@Injectable()
export class HealthService {
  constructor(
    private readonly environment: AppEnvironment,
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly encryption: EncryptionService
  ) {}

  async check(): Promise<HealthResponse> {
    const results = await Promise.all([
      this.dependency(async () => { await this.pool.query('SELECT 1'); }),
      this.dependency(async () => { if (await this.redis.ping() !== 'PONG') throw new Error('Redis PING failed'); }),
      this.dependency(() => checkProtectedStorage(this.environment.APP_STORAGE_PATH)),
      this.dependency(() => verifyStartupSentinel(this.pool, this.encryption)),
      this.dependency(async () => {
        const heartbeat = await this.pool.query<{ fresh: boolean }>("SELECT last_seen_at > now() - interval '30 seconds' AS fresh FROM service_heartbeats WHERE service = 'worker'");
        if (heartbeat.rowCount !== 1 || !heartbeat.rows[0].fresh) throw new Error('Worker heartbeat is absent or stale');
      })
    ]);
    const dependencies = { postgres: results[0], redis: results[1], storage: results[2], encryption: results[3], worker: results[4] };
    return { status: Object.values(dependencies).every((dependency) => dependency.ready) ? 'ready' : 'degraded', dependencies };
  }

  private async dependency(operation: () => Promise<void>): Promise<DependencyStatus> {
    try { await operation(); return { ready: true }; }
    catch (error) { return { ready: false, detail: error instanceof Error ? error.message : 'unavailable' }; }
  }
}
