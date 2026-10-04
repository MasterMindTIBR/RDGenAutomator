import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { EncryptionService, type AppEnvironment } from '@rdgen/domain';
import { RequestsService } from '../src/requests/requests.service.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'integration tests require DATABASE_URL from the runner');
assert.ok(process.env.APP_ENCRYPTION_KEY && process.env.APP_ENCRYPTION_KEY_ID, 'integration tests require encryption environment');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const publicKey = 'CLONE-PUBLIC-KEY-NOT-RETURNED';
const presetConfig = (installationEnabled: boolean) => ({ direction: 'incoming', installationEnabled, settingsEnabled: installationEnabled, approvalMode: 'password', denyLanDiscovery: true, enableDirectIp: true, autoDisconnect: false, hideConnectionManager: true, removeWallpaper: true, offlineMode: false, suppressNewVersionNotification: true, permissions: { keyboard: true, clipboard: true, fileTransfer: true, audio: true, tunnel: false, remoteRestart: true, recording: false, blockInput: true, remoteConfigModification: false, printer: true, camera: false, terminal: true } });

type World = { storage: string; adminId: string; otherId: string; serverId: string; presetFullId: string; presetQsId: string };

async function seedWorld(pool: pg.Pool, encryption: EncryptionService, suffix: string): Promise<World> {
  const storage = await mkdtemp(join(tmpdir(), 'rdgen-clone-'));
  const admin = await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, role, status) VALUES ($1, 'x', 'administrator', 'active') RETURNING id`, [`clone-admin-${suffix}@example.invalid`]);
  const other = await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, role, status) VALUES ($1, 'x', 'user', 'active') RETURNING id`, [`clone-other-${suffix}@example.invalid`]);
  const serverConfig = encryption.encrypt(JSON.stringify({ host: 'relay.example.invalid', port: '21116', publicKey, apiServer: 'https://api.example.invalid' }));
  const serverRecord = await pool.query<{ id: string }>(`INSERT INTO protected_records (purpose, ciphertext, integrity, key_id) VALUES ('rustdesk-server-configuration', $1, $2, $3) RETURNING id`, [serverConfig.ciphertext, serverConfig.integrity, serverConfig.keyId]);
  const server = await pool.query<{ id: string }>(`INSERT INTO rustdesk_servers (name, configuration_protected_id) VALUES ($1, $2) RETURNING id`, [`clone-server-${suffix}`, serverRecord.rows[0].id]);
  const presetFull = await pool.query<{ id: string }>(`INSERT INTO presets (name, profile, version, configuration) VALUES ($1, 'full', 1, $2::jsonb) RETURNING id`, [`clone-full-${suffix}`, JSON.stringify(presetConfig(true))]);
  const presetQs = await pool.query<{ id: string }>(`INSERT INTO presets (name, profile, version, configuration) VALUES ($1, 'qs', 1, $2::jsonb) RETURNING id`, [`clone-qs-${suffix}`, JSON.stringify(presetConfig(false))]);
  return { storage, adminId: admin.rows[0].id, otherId: other.rows[0].id, serverId: server.rows[0].id, presetFullId: presetFull.rows[0].id, presetQsId: presetQs.rows[0].id };
}

async function seedSourceRequest(pool: pg.Pool, world: World, suffix: string, opts: { iconKey: string | null }): Promise<string> {
  const request = await pool.query<{ id: string }>(
    `INSERT INTO build_requests (creator_id, display_name, technical_name, server_id, icon_storage_key, icon_content_type, icon_bytes, icon_width, icon_height, icon_retention_expires_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE 'image/png' END, CASE WHEN $5::text IS NULL THEN NULL ELSE $6::bigint END, 1, 1, now() + interval '1 day') RETURNING id`,
    [world.adminId, `Source ${suffix}`, `source-${suffix}`, world.serverId, opts.iconKey, png.byteLength]);
  await pool.query(`INSERT INTO build_jobs (request_id, profile, platform, version, preset_id, status) VALUES ($1, 'full', 'windows', '1.4.9', $2, 'concluído')`, [request.rows[0].id, world.presetFullId]);
  return request.rows[0].id;
}

async function cleanup(pool: pg.Pool, world: World, requestIds: string[]): Promise<void> {
  for (const id of requestIds) await pool.query('DELETE FROM build_requests WHERE id = $1', [id]).catch(() => undefined);
  await pool.query('DELETE FROM build_jobs WHERE request_id IS NULL').catch(() => undefined);
  await pool.query(`DELETE FROM presets WHERE name LIKE 'clone-%'`).catch(() => undefined);
  await pool.query(`DELETE FROM rustdesk_servers WHERE name LIKE 'clone-server-%'`).catch(() => undefined);
  await pool.query(`DELETE FROM protected_records WHERE purpose = 'rustdesk-server-configuration'`).catch(() => undefined);
  await pool.query(`DELETE FROM clone_drafts WHERE source_request_id IS NULL OR true`).catch(() => undefined);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [world.adminId, world.otherId]).catch(() => undefined);
}

test('clone draft copies effective images, leaks no secrets, stays private, and consumes once', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const suffix = `lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const encryption = new EncryptionService(Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64'), process.env.APP_ENCRYPTION_KEY_ID!);
  const world = await seedWorld(pool, encryption, suffix);
  const iconKey = `request-images/icon/${Math.random().toString(16).slice(2)}.png`;
  await mkdir(join(world.storage, 'request-images/icon'), { recursive: true });
  await writeFile(join(world.storage, iconKey), png);
  const environment = { APP_STORAGE_PATH: world.storage } as AppEnvironment;
  const service = new RequestsService(pool, environment, encryption);
  const sourceId = await seedSourceRequest(pool, world, suffix, { iconKey });
  try {
    const { token } = await service.createCloneDraft({ userId: world.adminId, role: 'administrator' }, sourceId);
    const draft = await service.getCloneDraft(world.adminId, token);
    assert.equal(draft.serverId, world.serverId);
    assert.equal(draft.presets.full, world.presetFullId);
    assert.deepEqual(draft.profiles, ['full']);
    assert.deepEqual(draft.platforms, ['windows']);
    assert.equal(draft.version, '1.4.9');
    assert.equal(draft.images.icon?.startsWith('data:image/png;base64,'), true);
    assert.equal(draft.missing.icon, false);
    const serialized = JSON.stringify(draft);
    assert.equal(serialized.includes('ciphertext'), false, 'draft must not leak protected records');
    assert.equal(serialized.includes('statusUrl'), false, 'draft must not leak capability URLs');
    assert.equal(serialized.includes(publicKey), false, 'draft must not leak server public key');

    const body = { displayName: 'Cloned', technicalName: 'cloned', serverId: world.serverId, presets: { full: world.presetFullId }, profiles: ['full'], platforms: ['windows'], version: '1.4.9', cloneToken: token };
    const created = await service.create(world.adminId, `clone-consume-${Date.now()}`, body);
    assert.equal(created.request.visibility, 'private');
    assert.equal(created.jobs.length, 1);
    const consumed = await pool.query<{ consumedAt: Date | null }>('SELECT consumed_at AS "consumedAt" FROM clone_drafts WHERE token = $1', [token]);
    assert.ok(consumed.rows[0]?.consumedAt, 'token must be marked consumed');
    await assert.rejects(() => service.create(world.adminId, `clone-reuse-${Date.now()}`, body), /token de clonagem/i);
  } finally { await cleanup(pool, world, [sourceId]); await pool.end(); }
});

test('clone draft enforces the source audience and reports missing source assets', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const suffix = `authz-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const encryption = new EncryptionService(Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64'), process.env.APP_ENCRYPTION_KEY_ID!);
  const world = await seedWorld(pool, encryption, suffix);
  const environment = { APP_STORAGE_PATH: world.storage } as AppEnvironment;
  const service = new RequestsService(pool, environment, encryption);
  const missingSource = await seedSourceRequest(pool, world, suffix, { iconKey: 'request-images/icon/does-not-exist.png' });
  const privateSource = await seedSourceRequest(pool, world, `${suffix}-p`, { iconKey: null });
  try {
    // A non-owner non-admin cannot clone a private request.
    await assert.rejects(() => service.createCloneDraft({ userId: world.otherId, role: 'user' }, privateSource), /not found/i);
    // The owner can still clone it, and a missing source image is reported instead of failing.
    const { token } = await service.createCloneDraft({ userId: world.adminId, role: 'administrator' }, missingSource);
    const draft = await service.getCloneDraft(world.adminId, token);
    assert.equal(draft.missing.icon, true);
    assert.equal(draft.images.icon, undefined);
    // An expired token is not resolvable.
    await pool.query('UPDATE clone_drafts SET expires_at = now() - interval \'1 minute\' WHERE token = $1', [token]);
    await assert.rejects(() => service.getCloneDraft(world.adminId, token), /not found|expired/i);
  } finally { await cleanup(pool, world, [missingSource, privateSource]); await pool.end(); }
});
