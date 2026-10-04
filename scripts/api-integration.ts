import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';

/**
 * Integration proof runner: owns its disposable PostgreSQL/Redis stack
 * (compose project `rdgen-test-integration` on ports 55432/6380), applies
 * migrations, runs the database-backed API/worker integration suites, and
 * always tears the stack down. No standalone `db:migrate` prerequisite.
 */
const composeFiles = ['-f', 'compose.yaml', '-f', 'compose.integration.yaml'];
const project = ['-p', 'rdgen-test-integration'];
const testDatabaseUrl = 'postgresql://rdgen:rdgen@127.0.0.1:55433/rdgen_automator';
const testRedisUrl = 'redis://127.0.0.1:6380';

async function command(program: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const child: ChildProcess = spawn(program, args, { stdio: 'inherit', env, cwd: process.cwd() });
  const [code] = await once(child, 'exit') as [number | null];
  if (code !== 0) throw new Error(`${program} ${args.join(' ')} failed with exit ${code}`);
}

async function main(): Promise<void> {
  if (!existsSync('.env')) await command('node', ['scripts/generate-env.mjs']);
  process.loadEnvFile('.env');
  const testEnv = { ...process.env, DATABASE_URL: testDatabaseUrl, REDIS_URL: testRedisUrl };
  try {
    await command('docker', ['compose', ...project, ...composeFiles, 'up', '-d', '--wait', 'postgres', 'redis']);
    await command(process.execPath, ['--import', 'tsx', 'apps/api/src/database/migrate.ts'], testEnv);
    await command(process.execPath, ['--import', 'tsx', '--test', 'apps/api/test-integration/telemetry-projection.test.ts'], { ...testEnv, TSX_TSCONFIG_PATH: 'apps/api/tsconfig.json' });
    await command(process.execPath, ['--import', 'tsx', '--test', 'apps/worker/test-integration/workflow-retry.test.ts'], testEnv);
    console.log('API integration proof passed.');
  } finally {
    await command('docker', ['compose', ...project, ...composeFiles, 'down', '-v']).catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  console.error(`API integration proof failed: ${error instanceof Error ? error.message : 'unknown error'}`);
});
