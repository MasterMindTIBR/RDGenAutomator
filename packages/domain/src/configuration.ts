import { z } from 'zod';

export const profileSchema = z.enum(['full', 'qs']);
export type Profile = z.infer<typeof profileSchema>;
export const platformSchema = z.enum(['windows', 'windows-x86', 'linux', 'android', 'macos']);
export type Platform = z.infer<typeof platformSchema>;

const safeName = z.string().trim().min(1).max(120).regex(/^[^&\\|'"$`\r\n]+$/, 'Contains characters unsupported by RDGen build scripts.');
const optionalUrl = z.string().url().max(2048).optional();
const androidApplicationId = z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/).max(255).optional();

/** Secret connection material: persisted only through protected_records. */
export const rustDeskServerConfigurationSchema = z.object({
  host: z.string().trim().min(1).max(253), port: z.string().trim().regex(/^\d{1,5}$/).optional(), publicKey: z.string().trim().min(1).max(8192),
  apiServer: optionalUrl, linkUrl: optionalUrl, downloadUrl: optionalUrl
}).strict();
export type RustDeskServerConfiguration = z.infer<typeof rustDeskServerConfigurationSchema>;

const permissionsSchema = z.object({
  keyboard: z.boolean(), clipboard: z.boolean(), fileTransfer: z.boolean(), audio: z.boolean(), tunnel: z.boolean(), remoteRestart: z.boolean(),
  recording: z.boolean(), blockInput: z.boolean(), remoteConfigModification: z.boolean(), printer: z.boolean(), camera: z.boolean(), terminal: z.boolean()
}).strict();

/** Presets deliberately contain only build behavior and permissions. */
export const presetConfigurationSchema = z.object({
  direction: z.enum(['incoming', 'outgoing', 'both']), installationEnabled: z.boolean(), settingsEnabled: z.boolean(),
  approvalMode: z.enum(['password', 'click', 'password-click']), denyLanDiscovery: z.boolean(), enableDirectIp: z.boolean(), autoDisconnect: z.boolean(),
  hideConnectionManager: z.boolean(), removeWallpaper: z.boolean(), offlineMode: z.boolean(), suppressNewVersionNotification: z.boolean(), permissions: permissionsSchema
}).strict().superRefine((value, context) => {
  if (value.hideConnectionManager && value.approvalMode !== 'password') context.addIssue({ code: z.ZodIssueCode.custom, path: ['approvalMode'], message: 'Hiding the connection manager requires password approval.' });
});
export type PresetConfiguration = z.infer<typeof presetConfigurationSchema>;

export const brandingConfigurationSchema = z.object({
  name: safeName, companyName: safeName, androidApplicationId, theme: z.enum(['light', 'dark', 'system']), themeScope: z.enum(['default', 'override'])
}).strict();
export type BrandingConfiguration = z.infer<typeof brandingConfigurationSchema>;
export const pngUploadSchema = z.object({ contentType: z.literal('image/png'), dataBase64: z.string().min(1) }).strict();
export const brandingAdminInputSchema = brandingConfigurationSchema.extend({ icon: pngUploadSchema.optional(), logo: pngUploadSchema.optional(), privacyScreen: pngUploadSchema.optional() }).strict();
export type BrandingAdminInput = z.infer<typeof brandingAdminInputSchema>;

const unique = <T>(values: T[], context: z.RefinementCtx, message: string) => { if (new Set(values).size !== values.length) context.addIssue({ code: z.ZodIssueCode.custom, message }); };

export const buildRequestInputSchema = z.object({
  displayName: safeName,
  technicalName: safeName.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Technical name may contain only letters, digits, dot, underscore and hyphen.'),
  permanentPassword: z.string().max(1024).optional(),
  profilePasswords: z.object({ full: z.string().max(1024).optional(), qs: z.string().max(1024).optional() }).strict().optional(),
  serverId: z.string().uuid(), brandingId: z.string().uuid().optional(),
  presets: z.object({ full: z.string().uuid().optional(), qs: z.string().uuid().optional() }).strict(),
  profiles: z.array(profileSchema).min(1).max(2).superRefine((values, context) => unique(values, context, 'Profiles must be unique.')),
  platforms: z.array(platformSchema).min(1).max(5).superRefine((values, context) => unique(values, context, 'Platforms must be unique.')),
  version: z.string().trim().min(1).max(80),
  images: z.object({ icon: pngUploadSchema.optional(), logo: pngUploadSchema.optional(), privacyScreen: pngUploadSchema.optional() }).strict().optional()
}).strict().superRefine((value, context) => { for (const profile of value.profiles) if (!value.presets[profile]) context.addIssue({ code: z.ZodIssueCode.custom, path: ['presets', profile], message: `A ${profile} preset is required.` }); });
export type BuildRequestInput = z.infer<typeof buildRequestInputSchema>;

export type ResolvedJobConfiguration = {
  version: string; platform: Platform; exename: string; appname: string; compname?: string;
  serverIP?: string; serverPort?: string; key?: string; apiServer?: string; urlLink?: string; downloadLink?: string;
  androidAppId?: string; permanentPassword: string;
  direction: 'incoming' | 'outgoing' | 'both';
  installation: 'installationY' | 'installationN';
  settings: 'settingsY' | 'settingsN';
  passApproveMode: 'password' | 'click' | 'password-click';
  theme: 'light' | 'dark' | 'system';
  themeDorO: 'default' | 'override';
  permissionsDorO: 'override'; permissionsType: 'custom';
  enableKeyboard: boolean; enableClipboard: boolean; enableFileTransfer: boolean; enableAudio: boolean; enableTCP: boolean;
  enableRemoteRestart: boolean; enableRecording: boolean; enableBlockingInput: boolean; enableRemoteModi: boolean;
  enablePrinter: boolean; enableCamera: boolean; enableTerminal: boolean;
  denyLan: boolean; enableDirectIP: boolean; autoClose: boolean; hidecm: boolean; xOffline: boolean;
  removeNewVersionNotif: boolean; removeWallpaper: boolean;
  iconStorageKey?: string; logoStorageKey?: string; privacyStorageKey?: string;
};

/** Composes one backend-only RDGen configuration for exactly one job. Field names match RDGen's live /generator form exactly: it is a flat Django form, not a JSON-blob API. */
export function composeResolvedJobConfiguration(input: { request: Pick<BuildRequestInput, 'displayName' | 'technicalName' | 'permanentPassword' | 'profilePasswords'>; platform: Platform; version: string; password: string; server: RustDeskServerConfiguration; preset: PresetConfiguration; branding?: BrandingConfiguration; iconStorageKey?: string; logoStorageKey?: string; privacyStorageKey?: string; }): { resolved: ResolvedJobConfiguration; redacted: Record<string, unknown> } {
  const { request, platform, version, password, server, preset, branding, iconStorageKey, logoStorageKey, privacyStorageKey } = input;
  const resolved: ResolvedJobConfiguration = {
    version, platform, exename: request.technicalName, appname: request.displayName,
    ...(branding ? { compname: branding.companyName } : {}),
    serverIP: server.host, ...(server.port ? { serverPort: server.port } : {}), key: server.publicKey,
    ...(server.apiServer ? { apiServer: server.apiServer } : {}), ...(server.linkUrl ? { urlLink: server.linkUrl } : {}), ...(server.downloadUrl ? { downloadLink: server.downloadUrl } : {}),
    ...(branding?.androidApplicationId ? { androidAppId: branding.androidApplicationId } : {}),
    permanentPassword: password,
    direction: preset.direction,
    installation: preset.installationEnabled ? 'installationY' : 'installationN',
    settings: preset.settingsEnabled ? 'settingsY' : 'settingsN',
    passApproveMode: preset.approvalMode,
    theme: branding?.theme ?? 'system',
    themeDorO: branding?.themeScope ?? 'default',
    permissionsDorO: 'override', permissionsType: 'custom',
    enableKeyboard: preset.permissions.keyboard, enableClipboard: preset.permissions.clipboard, enableFileTransfer: preset.permissions.fileTransfer,
    enableAudio: preset.permissions.audio, enableTCP: preset.permissions.tunnel, enableRemoteRestart: preset.permissions.remoteRestart,
    enableRecording: preset.permissions.recording, enableBlockingInput: preset.permissions.blockInput, enableRemoteModi: preset.permissions.remoteConfigModification,
    enablePrinter: preset.permissions.printer, enableCamera: preset.permissions.camera, enableTerminal: preset.permissions.terminal,
    denyLan: preset.denyLanDiscovery, enableDirectIP: preset.enableDirectIp, autoClose: preset.autoDisconnect, hidecm: preset.hideConnectionManager,
    xOffline: preset.offlineMode, removeNewVersionNotif: preset.suppressNewVersionNotification, removeWallpaper: preset.removeWallpaper,
    ...(iconStorageKey ? { iconStorageKey } : {}), ...(logoStorageKey ? { logoStorageKey } : {}), ...(privacyStorageKey ? { privacyStorageKey } : {})
  };
  const redacted = {
    version, platform, exename: request.technicalName, appname: request.displayName, ...(branding ? { compname: branding.companyName } : {}),
    server: '[redacted]', permanentPassword: '[redacted]',
    images: { icon: Boolean(iconStorageKey), logo: Boolean(logoStorageKey), privacyScreen: Boolean(privacyStorageKey) },
    direction: preset.direction, passApproveMode: preset.approvalMode, permissions: preset.permissions
  };
  return { resolved, redacted };
}
