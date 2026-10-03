import { permissions as permissionKeys, type Permission } from './types';
import type { Branding, Preset, Server } from './api-provider';

// RDGen's own build form (and the JSON it lets you export/import) uses this
// exact flat field set. It bundles server, branding and preset data into one
// file, so importing it anywhere in the panel can plausibly feed all three.
type RdgenJson = Record<string, unknown>;

const permissionField: Record<Permission, string> = {
  keyboard: 'enableKeyboard', clipboard: 'enableClipboard', fileTransfer: 'enableFileTransfer', audio: 'enableAudio',
  tunnel: 'enableTCP', remoteRestart: 'enableRemoteRestart', recording: 'enableRecording', blockInput: 'enableBlockingInput',
  remoteConfigModification: 'enableRemoteModi', printer: 'enablePrinter', camera: 'enableCamera', terminal: 'enableTerminal'
};

function str(json: RdgenJson, key: string): string { const value = json[key]; return typeof value === 'string' ? value : ''; }
function on(json: RdgenJson, key: string): boolean { return str(json, key) === 'on'; }
function bool(json: RdgenJson, key: string): boolean { return json[key] === true; }

export type ParsedImport = {
  server?: Omit<Server, 'id'>;
  branding?: Omit<Branding, 'id' | 'images'>;
  preset?: Omit<Preset, 'id' | 'version'>;
};

/** Parses an RDGen build-form JSON export. Returns only the sections it can confidently identify. */
export function parseRdgenConfigJson(raw: unknown): ParsedImport {
  if (!raw || typeof raw !== 'object') return {};
  const json = raw as RdgenJson;
  const result: ParsedImport = {};

  const serverIP = str(json, 'serverIP');
  const publicKey = str(json, 'key');
  if (serverIP && publicKey) {
    result.server = {
      name: str(json, 'compname') || str(json, 'appname') || str(json, 'exename') || serverIP,
      host: serverIP,
      port: '21116',
      publicKey,
      apiServer: str(json, 'apiServer'),
      linkUrl: str(json, 'urlLink'),
      downloadUrl: str(json, 'downloadLink')
    };
  }

  const compname = str(json, 'compname');
  if (compname) {
    const theme = str(json, 'theme');
    result.branding = {
      name: compname,
      company: compname,
      androidId: str(json, 'androidappid'),
      theme: theme === 'dark' ? 'Escuro' : theme === 'light' ? 'Claro' : 'Sistema',
      themeScope: str(json, 'themeDorO') === 'override' ? 'Sim' : 'Não'
    };
  }

  const direction = str(json, 'direction');
  const approval = str(json, 'passApproveMode');
  if (direction && approval) {
    const permissionsOut = Object.fromEntries(
      permissionKeys.map((permission) => [permission, on(json, permissionField[permission])])
    ) as Record<Permission, boolean>;
    result.preset = {
      name: `${str(json, 'appname') || compname || 'Preset'} (importado)`,
      profile: str(json, 'permissionsType') === 'full' ? 'full' : 'qs',
      config: {
        direction: direction === 'incoming' ? 'Entrada' : direction === 'outgoing' ? 'Saída' : 'Ambas',
        install: str(json, 'installation') === 'installationY',
        settings: str(json, 'settings') === 'settingsY',
        approval: approval === 'password' ? 'Senha permanente' : approval === 'click' ? 'Clique para aprovar' : 'Ambos',
        lan: !bool(json, 'denyLan'),
        directIp: on(json, 'enableDirectIP'),
        autoDisconnect: bool(json, 'autoClose'),
        hideConnectionManager: bool(json, 'hidecm'),
        wallpaper: bool(json, 'removeWallpaper'),
        offline: on(json, 'xOffline'),
        suppressUpdates: on(json, 'removeNewVersionNotif'),
        permissions: permissionsOut
      }
    };
  }

  return result;
}
