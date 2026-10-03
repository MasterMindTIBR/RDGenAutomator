import { spawn, type ChildProcess } from 'node:child_process';

process.loadEnvFile('.env');

type Service = { name: string; args: string[]; environment?: NodeJS.ProcessEnv; child?: ChildProcess };
const services: Service[] = [
  { name: 'api', args: ['--filter', '@rdgen/api', 'start'] },
  { name: 'worker', args: ['--filter', '@rdgen/worker', 'start'] },
  { name: 'web', args: ['--filter', '@rdgen/web', 'dev'], environment: { ...process.env, PORT: process.env.WEB_PORT ?? '3000' } }
];

function start(service: Service): void {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  service.child = spawn(command, service.args, { stdio: ['ignore', 'pipe', 'pipe'], env: service.environment ?? process.env, detached: process.platform !== 'win32' });
  service.child.stdout?.on('data', (data) => process.stdout.write(`[${service.name}] ${data}`));
  service.child.stderr?.on('data', (data) => process.stderr.write(`[${service.name}] ${data}`));
}

async function waitForReady(url: string): Promise<unknown> {
  const deadline = Date.now() + 45_000;
  let lastError = 'not started';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json() as { status?: string };
      if (response.ok && body.status === 'ready') return body;
      lastError = `status ${response.status}: ${JSON.stringify(body)}`;
    } catch (error) { lastError = error instanceof Error ? error.message : 'unavailable'; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function stop(): Promise<void> {
  for (const service of services) {
    if (!service.child?.pid) continue;
    if (process.platform === 'win32') service.child.kill('SIGTERM');
    else {
      try { process.kill(-service.child.pid, 'SIGTERM'); }
      catch { service.child.kill('SIGTERM'); }
    }
  }
  await Promise.all(services.map((service) => new Promise<void>((resolve) => service.child?.once('exit', () => resolve()) ?? resolve())));
}

async function main(): Promise<void> {
  try {
  services.forEach(start);
  const apiPort = process.env.API_PORT ?? '3001';
  const workerPort = process.env.WORKER_PORT ?? '3002';
  const webPort = process.env.WEB_PORT ?? '3000';
  const [api, worker, web] = await Promise.all([
    waitForReady(`http://127.0.0.1:${apiPort}/health`),
    waitForReady(`http://127.0.0.1:${workerPort}/health`),
    waitForReady(`http://127.0.0.1:${webPort}/api/health`)
  ]);
  console.log(`Smoke passed: ${JSON.stringify({ api, worker, web })}`);
  } finally {
    await stop();
  }
}

void main().catch((error) => {
  console.error(`Smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
