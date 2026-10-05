import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RdgenAmbiguousStartError, RdgenProvider, RdgenProtocolError, RdgenRunUnknownError, RdgenTerminalError } from './rdgen-provider.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
async function fixture(name: string) { return readFile(join(fixtures, name), 'utf8'); }
test('RDGen provider turns the recorded start HTML into normalized metadata and manifest', async () => {
  const provider = new RdgenProvider({ fetch: async () => new Response(await fixture('rdgen-start.html'), { status: 200 }) });
  const remote = await provider.startBuild({
    version: '1', platform: 'windows', exename: 'acme', appname: 'Acme', serverIP: 'x', key: 'k', permanentPassword: 'secret',
    direction: 'incoming', installation: 'installationY', settings: 'settingsY', passApproveMode: 'password-click',
    theme: 'system', themeDorO: 'default', permissionsDorO: 'override', permissionsType: 'custom',
    enableKeyboard: true, enableClipboard: true, enableFileTransfer: true, enableAudio: true, enableTCP: true,
    enableRemoteRestart: true, enableRecording: true, enableBlockingInput: true, enableRemoteModi: true,
    enablePrinter: true, enableCamera: true, enableTerminal: true,
    denyLan: false, enableDirectIP: true, autoClose: false, hidecm: false, xOffline: false,
    removeNewVersionNotif: true, removeWallpaper: false, logoStorageKey: 'logos/x.png'
  });
  assert.equal(remote.uuid, '11111111-1111-4111-8111-111111111111');
  assert.equal(remote.statusUrl.includes('/check_for_file?'), true);
  const manifest = provider.getDownloadManifest(remote);
  assert.deepEqual(manifest.artifacts.map((item) => item.filename), ['acme-support.exe', 'acme-support.msi']);
  assert.equal(JSON.stringify(manifest).includes('<span'), false);
});
test('RDGen provider rejects incompatible markup and treats a lost start response as indeterminate', async () => {
  const malformed = new RdgenProvider({ fetch: async () => new Response('<html>changed</html>', { status: 200 }) });
  await assert.rejects(() => malformed.startBuild({} as never), RdgenAmbiguousStartError);
  assert.throws(() => malformed.parseStart('<span id="statusText">x</span>'), RdgenProtocolError);
});
test('RDGen provider keeps an explicit start rejection terminal', async () => {
  const provider = new RdgenProvider({ fetch: async () => new Response('invalid configuration', { status: 400 }) });
  await assert.rejects(() => provider.startBuild({} as never), RdgenTerminalError);
});
test('RDGen status parser reads the real success page, which has no statusText span nor Actions link', async () => {
  const provider = new RdgenProvider({ fetch: async () => new Response(await fixture('rdgen-success.html'), { status: 200 }) });
  const status = await provider.getBuildStatus({ uuid: '11111111-1111-4111-8111-111111111111', filename: 'acme', platform: 'windows', statusUrl: 'https://rdgen.crayoneater.org/check_for_file?filename=acme&uuid=11111111-1111-4111-8111-111111111111&platform=windows' });
  assert.equal(status.stage, 'succeeded'); assert.equal(status.actionUrl, undefined); assert.equal(status.manifest?.artifacts.length, 2);
});
test('RDGen status parser keeps polling the waiting page and extracts the Actions link despite nested markup', async () => {
  const provider = new RdgenProvider({ fetch: async () => new Response(await fixture('rdgen-pending.html'), { status: 200 }) });
  const status = await provider.getBuildStatus({ uuid: '11111111-1111-4111-8111-111111111111', filename: 'acme', platform: 'windows', statusUrl: 'https://rdgen.crayoneater.org/check_for_file?filename=acme&uuid=11111111-1111-4111-8111-111111111111&platform=windows' });
  assert.equal(status.stage, 'pending'); assert.equal(status.text, 'in_progress'); assert.equal(status.actionUrl, 'https://github.com/bryangerlach/rdgen/actions/runs/37219299194');
});
test('RDGen status parser maps a lost run record to a dedicated error, never to a failed build', async () => {
  const provider = new RdgenProvider({ fetch: async () => new Response('<html>404</html>', { status: 404 }) });
  await assert.rejects(() => provider.getBuildStatus({ uuid: '11111111-1111-4111-8111-111111111111', filename: 'acme', platform: 'windows', statusUrl: 'https://rdgen.crayoneater.org/check_for_file?filename=acme&uuid=11111111-1111-4111-8111-111111111111&platform=windows' }), RdgenRunUnknownError);
});
test('RDGen status parser reports the live interruption response as a failed build', async () => {
  const provider = new RdgenProvider({ fetch: async () => new Response('<h2 class="error-header">Workflow Interrupted</h2><a href="https://github.com/bryangerlach/rdgen/actions/runs/37219299194">Check GitHub Logs for error details ↗</a>', { status: 200 }) });
  const status = await provider.getBuildStatus({ uuid: '11111111-1111-4111-8111-111111111111', filename: 'acme', platform: 'windows', statusUrl: 'https://rdgen.crayoneater.org/check_for_file?filename=acme&uuid=11111111-1111-4111-8111-111111111111&platform=windows' });
  assert.equal(status.stage, 'failed'); assert.equal(status.text, 'Workflow Interrupted'); assert.equal(status.actionUrl, 'https://github.com/bryangerlach/rdgen/actions/runs/37219299194');
});
