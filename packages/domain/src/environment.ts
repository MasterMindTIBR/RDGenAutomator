import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

// Every workspace service starts from its own package directory. The repository
// root owns .env and is also the base for any relative local-storage path.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: resolve(repositoryRoot, '.env') });

const rootKey = z.string().min(1).transform((value, context) => {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be base64 encoded' });
    return z.NEVER;
  }
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be canonical base64 for exactly 32 bytes' });
    return z.NEVER;
  }
  return decoded;
});

const environmentSchema = z.object({
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  REDIS_URL: z.string().url().startsWith('redis://'),
  APP_STORAGE_PATH: z.string().min(1).transform((value) => isAbsolute(value) ? value : resolve(repositoryRoot, value)),
  APP_ENCRYPTION_KEY: rootKey,
  APP_ENCRYPTION_KEY_ID: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  APP_BIND_HOST: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9._:-]+$/, 'must be a valid host or IP address').default('127.0.0.1'),
  API_BASE_URL: z.string().url().default('http://localhost:3001')
});

export type AppEnvironment = z.output<typeof environmentSchema>;

export function loadEnvironment(input: NodeJS.ProcessEnv = process.env): AppEnvironment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid environment: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}

export function loadSeedEnvironment(input: NodeJS.ProcessEnv = process.env): { email: string; password: string } {
  const result = z.object({
    ADMIN_EMAIL: z.string().email(),
    ADMIN_PASSWORD: z.string().min(16)
  }).safeParse(input);
  if (!result.success) throw new Error(`Invalid administrator seed environment: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  return { email: result.data.ADMIN_EMAIL.toLowerCase(), password: result.data.ADMIN_PASSWORD };
}

export function loadRotationEnvironment(input: NodeJS.ProcessEnv = process.env): { key: Buffer; keyId: string } {
  const result = z.object({
    REENCRYPT_NEW_APP_ENCRYPTION_KEY: rootKey,
    REENCRYPT_NEW_APP_ENCRYPTION_KEY_ID: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  }).safeParse(input);
  if (!result.success) throw new Error(`Invalid rotation environment: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  return { key: result.data.REENCRYPT_NEW_APP_ENCRYPTION_KEY, keyId: result.data.REENCRYPT_NEW_APP_ENCRYPTION_KEY_ID };
}
