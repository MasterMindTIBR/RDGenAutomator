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

export type ResolvedJobConfiguration = { version: string; platform: Platform; exename: string; appname: string; compname?: string; serverIP: string; serverPort?: string; key: string; apiServer?: string; urlLink?: string; downloadLink?: string; permanentPassword: string; iconStorageKey?: string; logoStorageKey?: string; privacyStorageKey?: string; custom: Record<string, unknown>; };
const yn = (value: boolean) => value ? 'Y' : 'N';

/** Composes one backend-only RDGen configuration for exactly one job. */
export function composeResolvedJobConfiguration(input: { request: Pick<BuildRequestInput, 'displayName' | 'technicalName' | 'permanentPassword' | 'profilePasswords'>; platform: Platform; version: string; password: string; server: RustDeskServerConfiguration; preset: PresetConfiguration; branding?: BrandingConfiguration; iconStorageKey?: string; logoStorageKey?: string; privacyStorageKey?: string; }): { resolved: ResolvedJobConfiguration; redacted: Record<string, unknown> } {
  const { request, platform, version, password, server, preset, branding, iconStorageKey, logoStorageKey, privacyStorageKey } = input;
  const permissions = { 'access-mode': 'custom', 'enable-keyboard': yn(preset.permissions.keyboard), 'enable-clipboard': yn(preset.permissions.clipboard), 'enable-file-transfer': yn(preset.permissions.fileTransfer), 'enable-audio': yn(preset.permissions.audio), 'enable-tunnel': yn(preset.permissions.tunnel), 'enable-remote-restart': yn(preset.permissions.remoteRestart), 'enable-record-session': yn(preset.permissions.recording), 'enable-block-input': yn(preset.permissions.blockInput), 'allow-remote-config-modification': yn(preset.permissions.remoteConfigModification), 'enable-remote-printer': yn(preset.permissions.printer), 'enable-camera': yn(preset.permissions.camera), 'enable-terminal': yn(preset.permissions.terminal), 'direct-server': yn(preset.enableDirectIp), 'verification-method': preset.hideConnectionManager ? 'use-permanent-password' : 'use-both-passwords', 'approve-mode': preset.approvalMode, 'allow-hide-cm': yn(preset.hideConnectionManager), 'allow-remove-wallpaper': yn(preset.removeWallpaper) };
  const custom: Record<string, unknown> = { 'override-settings': {}, 'default-settings': {}, 'conn-type': preset.direction, 'enable-lan-discovery': yn(!preset.denyLanDiscovery), 'allow-auto-disconnect': yn(preset.autoDisconnect), 'offline-mode': yn(preset.offlineMode), 'remove-new-version-notification': yn(preset.suppressNewVersionNotification) };
  if (!preset.installationEnabled) custom['disable-installation'] = 'Y';
  if (!preset.settingsEnabled) custom['disable-settings'] = 'Y';
  if (branding && branding.theme !== 'system') {
    const theme = platform === 'windows-x86' ? { 'allow-darktheme': yn(branding.theme === 'dark') } : { theme: branding.theme };
    custom[branding.themeScope === 'default' ? 'default-settings' : 'override-settings'] = theme;
  }
  Object.assign(custom['override-settings'] as Record<string, unknown>, permissions);
  if (preset.direction === 'incoming') { (custom['override-settings'] as Record<string, unknown>)['custom-rendezvous-server'] = server.host; if (server.apiServer) (custom['override-settings'] as Record<string, unknown>)['api-server'] = server.apiServer; }
  const resolved: ResolvedJobConfiguration = { version, platform, exename: request.technicalName, appname: request.displayName, ...(branding ? { compname: branding.companyName } : {}), serverIP: server.host, ...(server.port ? { serverPort: server.port } : {}), key: server.publicKey, ...(server.apiServer ? { apiServer: server.apiServer } : {}), ...(server.linkUrl ? { urlLink: server.linkUrl } : {}), ...(server.downloadUrl ? { downloadLink: server.downloadUrl } : {}), permanentPassword: password, ...(iconStorageKey ? { iconStorageKey } : {}), ...(logoStorageKey ? { logoStorageKey } : {}), ...(privacyStorageKey ? { privacyStorageKey } : {}), custom };
  return { resolved, redacted: { version, platform, exename: request.technicalName, appname: request.displayName, ...(branding ? { compname: branding.companyName } : {}), server: '[redacted]', permanentPassword: '[redacted]', images: { icon: Boolean(iconStorageKey), logo: Boolean(logoStorageKey), privacyScreen: Boolean(privacyStorageKey) }, custom } };
}
