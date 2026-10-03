import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';

// Root scripts do not have production dependencies of their own; resolve these
// through the API workspace so this remains an explicit API smoke.
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const pg = requireApi('pg');
const bcrypt = requireApi('bcryptjs');

process.loadEnvFile('.env');

async function command(program: string, args: string[], environment = process.env): Promise<void> {
  const child = spawn(program, args, { stdio: 'inherit', env: environment });
  const [code] = await once(child, 'exit') as [number | null];
  if (code !== 0) throw new Error(`${program} ${args.join(' ')} failed`);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApi(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/health`)).status < 500) return;
    } catch { /* The process is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('API did not start');
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(/rdgen_session=([^;]*)/);
  assert(match, 'login did not set a session cookie');
  return `rdgen_session=${match[1]}`;
}

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { response, body };
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function signalApi(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    child.kill(signal);
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (!(typeof error === 'object' && error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ESRCH') return false;
    return true;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function stopApi(child: ChildProcess): Promise<void> {
  if (process.platform !== 'win32' && child.pid) {
    signalApi(child, 'SIGTERM');
    if (await waitForProcessGroupExit(child.pid, 5_000)) return;
    signalApi(child, 'SIGKILL');
    if (!await waitForProcessGroupExit(child.pid, 3_000)) throw new Error('API process group did not terminate after SIGKILL');
    return;
  }
  const gracefulExit = waitForExit(child, 5_000);
  signalApi(child, 'SIGTERM');
  if (await gracefulExit) return;
  const forcedExit = waitForExit(child, 3_000);
  signalApi(child, 'SIGKILL');
  if (!await forcedExit) throw new Error('API process did not terminate after SIGKILL');
}

async function main(): Promise<void> {
  await command('docker', ['compose', 'up', '-d', 'postgres', 'redis']);
  await command(process.execPath, ['--import', 'tsx', 'apps/api/src/database/migrate.ts']);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const administratorEmail = `smoke-admin-${suffix}@example.invalid`;
  const userEmail = `smoke-user-${suffix}@example.invalid`;
  const password = 'SmokeAuthPassword123';
  const passwordHash = await bcrypt.hash(password, 12);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'administrator', 'active') RETURNING id`,
    [administratorEmail, passwordHash]
  );
  const administratorId = inserted.rows[0].id;
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const api = spawn(pnpm, ['--filter', '@rdgen/api', 'start'], {
    env: { ...process.env, API_PORT: String(port), API_BASE_URL: baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  api.stdout.on('data', (data) => process.stdout.write(`[api] ${data}`));
  api.stderr.on('data', (data) => process.stderr.write(`[api] ${data}`));
  let createdUserId: string | undefined;
  try {
    await waitForApi(baseUrl);
    const login = await jsonRequest(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: administratorEmail, password }) });
    assert.equal(login.response.status, 201);
    const adminCookie = cookieFrom(login.response);
    const csrfToken = login.body.csrfToken;
    assert.equal(typeof csrfToken, 'string');

    const current = await jsonRequest(`${baseUrl}/me`, { headers: { cookie: adminCookie } });
    assert.equal(current.response.status, 200);
    const rejectedMutation = await jsonRequest(`${baseUrl}/admin/users`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ email: userEmail, password }) });
    assert.equal(rejectedMutation.response.status, 403);

    const created = await jsonRequest(`${baseUrl}/admin/users`, { method: 'POST', headers: { cookie: adminCookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ email: userEmail, password }) });
    assert.equal(created.response.status, 201);
    assert(created.body.user && typeof created.body.user === 'object');
    createdUserId = (created.body.user as { id: string }).id;

    const userLogin = await jsonRequest(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: userEmail, password }) });
    assert.equal(userLogin.response.status, 201);
    const disabledUserCookie = cookieFrom(userLogin.response);
    const disabled = await jsonRequest(`${baseUrl}/admin/users/${createdUserId}/disable`, { method: 'POST', headers: { cookie: adminCookie, 'x-csrf-token': csrfToken } });
    assert.equal(disabled.response.status, 201);
    const disabledSession = await jsonRequest(`${baseUrl}/me`, { headers: { cookie: disabledUserCookie } });
    assert.equal(disabledSession.response.status, 401);

    const logout = await jsonRequest(`${baseUrl}/auth/logout`, { method: 'POST', headers: { cookie: adminCookie, 'x-csrf-token': csrfToken } });
    assert.equal(logout.response.status, 201);
    const revokedSession = await jsonRequest(`${baseUrl}/me`, { headers: { cookie: adminCookie } });
    assert.equal(revokedSession.response.status, 401);
    console.log('Auth smoke passed: login, CSRF mutation, disabled-session rejection, and logout revocation.');
  } finally {
    try { await stopApi(api); }
    finally {
      await pool.query(`DELETE FROM audit_events WHERE actor_id = $1 OR actor_id = $2 OR (subject_type = 'user' AND subject_id = $2)`, [administratorId, createdUserId ?? '']).catch(() => undefined);
      await pool.query('DELETE FROM users WHERE id = $1 OR id = $2', [administratorId, createdUserId ?? '']).catch(() => undefined);
      await pool.end();
    }
  }
}

void main().catch((error) => {
  console.error(`Auth smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
