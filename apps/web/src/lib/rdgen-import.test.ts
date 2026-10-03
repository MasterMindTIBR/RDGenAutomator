import { describe, expect, it } from 'vitest';
import { parseRdgenConfigJson } from './rdgen-import';

// A real RDGen build-form export (fields renamed to a fictitious client; the
// shape and values are otherwise unmodified from what RDGen itself produces).
const sample = {
  platform: 'windows', version: '1.4.6', delayFix: 'on', exename: 'Carsoft', appname: '', direction: 'both',
  installation: 'installationY', settings: 'settingsY', androidappid: '', serverIP: 'rust.carsoft.com.br',
  key: 'zhplug24JxOspBjmv8IxWDK5bVQtnqYLhywQzeAByMQ=', apiServer: 'http://rust.carsoft.com.br:21114',
  urlLink: 'https://carsoft.com.br', downloadLink: 'https://suporte.carsoft.com.br', compname: 'Carsoft',
  passApproveMode: 'password-click', permanentPassword: '', enableDirectIP: 'on', iconbase64: '', logobase64: '',
  privacybase64: '', iconfile: {}, logofile: {}, privacyfile: {}, theme: 'light', themeDorO: 'override',
  permissionsDorO: 'override', permissionsType: 'full', enableKeyboard: 'on', enableClipboard: 'on',
  enableFileTransfer: 'on', enableAudio: 'on', enableTCP: 'on', enableRemoteRestart: 'on', enableRecording: 'on',
  enableBlockingInput: 'on', enableRemoteModi: 'on', enablePrinter: 'on', enableCamera: 'on', enableTerminal: 'on',
  cycleMonitor: 'on', xOffline: 'on', removeNewVersionNotif: 'on',
  defaultManual: 'view-style=adaptive\ndisable-audio=Y\nshow-remote-cursor=Y', overrideManual: '',
  denyLan: false, autoClose: false, hidecm: false, removeWallpaper: false
};

describe('parseRdgenConfigJson', () => {
  it('maps server connection fields', () => {
    const { server } = parseRdgenConfigJson(sample);
    expect(server).toEqual({
      name: 'Carsoft', host: 'rust.carsoft.com.br', port: '21116',
      publicKey: 'zhplug24JxOspBjmv8IxWDK5bVQtnqYLhywQzeAByMQ=',
      apiServer: 'http://rust.carsoft.com.br:21114', linkUrl: 'https://carsoft.com.br',
      downloadUrl: 'https://suporte.carsoft.com.br'
    });
  });

  it('maps branding identity and the forced-theme toggle', () => {
    const { branding } = parseRdgenConfigJson(sample);
    expect(branding).toEqual({ name: 'Carsoft', company: 'Carsoft', androidId: '', theme: 'Claro', themeScope: 'Sim' });
  });

  it('maps preset behavior and all twelve permissions in order', () => {
    const { preset } = parseRdgenConfigJson(sample);
    expect(preset?.profile).toBe('full');
    expect(preset?.config.direction).toBe('Ambas');
    expect(preset?.config.install).toBe(true);
    expect(preset?.config.settings).toBe(true);
    expect(preset?.config.approval).toBe('Ambos');
    expect(preset?.config.lan).toBe(true);
    expect(preset?.config.directIp).toBe(true);
    expect(preset?.config.autoDisconnect).toBe(false);
    expect(preset?.config.hideConnectionManager).toBe(false);
    expect(preset?.config.wallpaper).toBe(false);
    expect(preset?.config.offline).toBe(true);
    expect(preset?.config.suppressUpdates).toBe(true);
    expect(preset?.config.permissions).toEqual({
      keyboard: true, clipboard: true, fileTransfer: true, audio: true, tunnel: true, remoteRestart: true,
      recording: true, blockInput: true, remoteConfigModification: true, printer: true, camera: true, terminal: true
    });
  });

  it('only reports the sections it can confidently identify', () => {
    expect(parseRdgenConfigJson({})).toEqual({});
    expect(parseRdgenConfigJson(null)).toEqual({});
    expect(parseRdgenConfigJson('not json')).toEqual({});
    expect(parseRdgenConfigJson({ serverIP: 'x' })).toEqual({});
  });
});
