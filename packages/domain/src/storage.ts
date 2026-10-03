import { access, chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

export async function ensureProtectedStorage(storagePath: string): Promise<string> {
  const absolute = resolve(storagePath);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await chmod(absolute, 0o700);
  const metadata = await stat(absolute);
  if ((metadata.mode & 0o077) !== 0) throw new Error('Protected storage directory must not be accessible by group or others');
  await access(absolute, constants.R_OK | constants.W_OK | constants.X_OK);
  return absolute;
}

export async function checkProtectedStorage(storagePath: string): Promise<void> {
  const absolute = await ensureProtectedStorage(storagePath);
  const probe = await mkdtemp(join(absolute, '.health-'));
  await rm(probe, { recursive: true, force: true });
}

/** Only worker-created plaintext configuration names are eligible for recovery cleanup. */
export async function sweepTemporaryConfigurations(storagePath: string): Promise<number> {
  const root = await ensureProtectedStorage(storagePath); const temporary = join(root, 'temporary-configurations');
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  let removed = 0;
  for (const entry of await readdir(temporary, { withFileTypes: true })) {
    if (entry.isFile() && /^rdgen-config-[0-9a-f-]+\.json$/i.test(entry.name)) { await rm(join(temporary, entry.name), { force: true }); removed += 1; }
  }
  return removed;
}
