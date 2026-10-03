import { randomBytes, randomInt } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
const ports = new Set();
while (ports.size < 3) ports.add(randomInt(20_000, 60_000));
const [apiPort, webPort, workerPort] = [...ports];
const generatedValues = {
  PLACEHOLDER_APP_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  PLACEHOLDER_APP_ENCRYPTION_KEY_ID: () => `development-${randomBytes(12).toString('hex')}`,
  PLACEHOLDER_ADMIN_PASSWORD: () => randomBytes(32).toString('base64url'),
  PLACEHOLDER_REENCRYPT_NEW_APP_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  PLACEHOLDER_REENCRYPT_NEW_APP_ENCRYPTION_KEY_ID: () => `development-next-${randomBytes(12).toString('hex')}`,
  PLACEHOLDER_API_PORT: () => String(apiPort),
  PLACEHOLDER_WEB_PORT: () => String(webPort),
  PLACEHOLDER_WORKER_PORT: () => String(workerPort),
  PLACEHOLDER_API_BASE_URL: () => `http://127.0.0.1:${apiPort}`
};

let source;
try {
  source = await readFile(envPath, 'utf8');
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    throw new Error('Missing .env. Copy .env.example to .env before running env:generate.');
  }
  throw error;
}

let replacements = 0;
const output = source.split(/(\r?\n)/).map((line) => {
  const match = line.match(/^([A-Z0-9_]+)=(PLACEHOLDER_[A-Z0-9_]+)$/);
  if (!match) return line;
  const generator = generatedValues[match[2]];
  if (!generator) return line;
  replacements += 1;
  return `${match[1]}=${generator()}`;
}).join('');

if (replacements > 0) await writeFile(envPath, output, { encoding: 'utf8', mode: 0o600 });
await chmod(envPath, 0o600);
console.log(replacements > 0 ? 'Generated local development environment values.' : 'No placeholder values found; local environment unchanged.');
