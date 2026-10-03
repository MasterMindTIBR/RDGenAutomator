import assert from 'node:assert/strict';
import test from 'node:test';
import { composeResolvedJobConfiguration, presetConfigurationSchema, validatePngBase64 } from './index.js';

const permissions = { keyboard: true, clipboard: true, fileTransfer: false, audio: true, tunnel: false, remoteRestart: true, recording: false, blockInput: true, remoteConfigModification: false, printer: true, camera: false, terminal: true };
const preset = { direction: 'incoming' as const, installationEnabled: false, settingsEnabled: false, approvalMode: 'password' as const, denyLanDiscovery: true, enableDirectIp: true, autoDisconnect: false, hideConnectionManager: true, removeWallpaper: true, offlineMode: false, suppressNewVersionNotification: true, permissions };

test('typed preset accepts every supported control and rejects raw configuration overrides', () => {
  assert.equal(presetConfigurationSchema.safeParse(preset).success, true);
  assert.equal(presetConfigurationSchema.safeParse({ ...preset, arbitraryJson: { dangerous: true } }).success, false);
  assert.equal(presetConfigurationSchema.safeParse({ ...preset, approvalMode: 'click' }).success, false);
});

test('composition keeps secrets only in the resolved configuration and maps typed controls', () => {
  const result = composeResolvedJobConfiguration({
    request: { displayName: 'Example Support', technicalName: 'example-support', permanentPassword: 'permanent-secret' }, platform: 'windows', version: '1.4.9', password: 'permanent-secret', logoStorageKey: 'request-images/logo/generated.png', iconStorageKey: 'request-images/icon/generated.png',
    branding: { name: 'Example', companyName: 'Example Co', theme: 'dark', themeScope: 'default' }, server: { host: 'relay.example.invalid', port: '21116', publicKey: 'server-public-key', apiServer: 'https://api.example.invalid' }, preset
  });
  assert.equal(result.resolved.permanentPassword, 'permanent-secret');
  assert.equal(result.resolved.key, 'server-public-key');
  assert.equal(result.resolved.custom['disable-installation'], 'Y');
  assert.equal((result.resolved.custom['override-settings'] as Record<string, string>)['approve-mode'], 'password');
  assert.equal((result.resolved.custom['override-settings'] as Record<string, string>)['access-mode'], 'custom');
  assert.equal((result.resolved.custom['override-settings'] as Record<string, string>)['custom-rendezvous-server'], 'relay.example.invalid');
  assert.equal(JSON.stringify(result.redacted).includes('permanent-secret'), false);
  assert.equal(JSON.stringify(result.redacted).includes('server-public-key'), false);
});

test('composition without branding emits no theme override or company name', () => {
  let result: ReturnType<typeof composeResolvedJobConfiguration> | undefined;
  assert.doesNotThrow(() => {
    result = composeResolvedJobConfiguration({
      request: { displayName: 'Unbranded Support', technicalName: 'unbranded-support' }, platform: 'windows', version: '1.4.9', password: '',
      server: { host: 'relay.example.invalid', publicKey: 'server-public-key' }, preset
    });
  });
  assert(result);
  const override = result.resolved.custom['override-settings'] as Record<string, unknown>;
  const defaults = result.resolved.custom['default-settings'] as Record<string, unknown>;
  assert.equal('theme' in override, false); assert.equal('allow-darktheme' in override, false);
  assert.equal('theme' in defaults, false); assert.equal('allow-darktheme' in defaults, false);
  assert.equal('compname' in result.resolved, false);
});

test('PNG validation reads decoded IHDR dimensions and rejects non-PNG input', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  assert.deepEqual(validatePngBase64(png.toString('base64')), { bytes: png, width: 1, height: 1 });
  assert.throws(() => validatePngBase64(Buffer.from('not a png').toString('base64')));
});
