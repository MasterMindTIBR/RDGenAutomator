import type { Platform, ResolvedJobConfiguration } from './configuration.js';
import { expectedArtifactFilenames, type DownloadedArtifact } from './artifacts.js';

export type RemoteBuild = { uuid: string; filename: string; platform: Platform; statusUrl: string; actionUrl?: string };
export type DownloadManifest = { remoteBuild: RemoteBuild; artifacts: Array<{ filename: string; url: string }> };
export type RemoteBuildStatus = { stage: 'pending' | 'succeeded' | 'failed'; text: string; actionUrl?: string; manifest?: DownloadManifest };
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class RdgenProtocolError extends Error {}
/** RDGen answered 404: it lost track of the run; the GitHub Actions run is the remaining source of truth. */
export class RdgenRunUnknownError extends Error {}
export class RdgenTransientError extends Error {}
/** The provider definitely rejected the request; a new remote build was not started. */
export class RdgenTerminalError extends Error {}
/** A request may have crossed the network boundary; never retry this automatically. */
export class RdgenAmbiguousStartError extends Error {}

const productionOrigin = 'https://rdgen.crayoneater.org';
function absolute(base: string, value: string): string {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.origin !== new URL(base).origin) throw new RdgenProtocolError('RDGen returned an off-allowlist URL');
  return url.toString();
}
function decodeQuery(html: string): URLSearchParams {
  const match = /window\.location\.replace\(\s*['"]([^'"]*\/check_for_file\?[^'"]+)['"]\s*\)/i.exec(html);
  if (!match) throw new RdgenProtocolError('RDGen protocol changed: check_for_file redirect is missing');
  return new URL(match[1], productionOrigin).searchParams;
}
function textStatus(html: string): string {
  const status = /<span\s+id=["']statusText["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
  if (status) return status[1].replace(/<[^>]+>/g, '').trim();
  const success = /<h[1-6]\b[^>]*\bclass=["'][^"']*\bsuccess-text\b[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html);
  if (success) return success[1].replace(/<[^>]+>/g, '').trim();
  const interruption = /<h[1-6]\b[^>]*\bclass=["'][^"']*\berror-header\b[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html);
  if (interruption) return interruption[1].replace(/<[^>]+>/g, '').trim();
  throw new RdgenProtocolError('RDGen protocol changed: no recognizable status template');
}
function action(html: string, base: string): string | undefined {
  const match = /<a\b[^>]*href=["']([^"']+)["'][^>]*>(?:(?!<\/a>)[\s\S])*(?:Actions|GitHub)(?:(?!<\/a>)[\s\S])*<\/a>/i.exec(html);
  if (!match) return undefined;
  const url = new URL(match[1], base);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new RdgenProtocolError('RDGen returned an off-allowlist Actions URL');
  return url.toString();
}
/** The only product integration. It exposes normalized values, never HTML. */
export class RdgenProvider {
  readonly baseUrl: string;
  constructor(options: { baseUrl?: string; fetch?: FetchLike; allowedOrigins?: string[] } = {}) {
    this.baseUrl = (options.baseUrl ?? productionOrigin).replace(/\/$/, '');
    const parsed = new URL(this.baseUrl);
    this.allowedOrigins = new Set(options.allowedOrigins ?? [productionOrigin]);
    if (parsed.protocol !== 'https:' || !this.allowedOrigins.has(parsed.origin)) throw new Error('RDGen base URL must be an allowlisted HTTPS origin');
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  private readonly fetch: FetchLike;
  private readonly allowedOrigins: Set<string>;
  async startBuild(configuration: ResolvedJobConfiguration, images: { icon?: Buffer; logo?: Buffer; privacyScreen?: Buffer } = {}): Promise<RemoteBuild> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/generator`, { method: 'POST', body: this.form(configuration, images), redirect: 'error' });
    } catch { throw new RdgenAmbiguousStartError('RDGen start response was not received'); }
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) throw new RdgenTransientError(`RDGen start returned HTTP ${response.status}`);
    if (!response.ok) throw new RdgenTerminalError(`RDGen start rejected with HTTP ${response.status}`);
    let html: string;
    try { html = await response.text(); return this.parseStart(html); }
    catch (error) {
      if (error instanceof RdgenProtocolError) throw new RdgenAmbiguousStartError('RDGen accepted start but its response cannot be persisted safely');
      throw error;
    }
  }
  parseStart(html: string): RemoteBuild {
    textStatus(html);
    const query = decodeQuery(html);
    const filename = query.get('filename'); const uuid = query.get('uuid'); const platform = query.get('platform');
    if (!filename || !/^[A-Za-z0-9._-]+$/.test(filename) || !uuid || !/^[0-9a-f-]{36}$/i.test(uuid) || !platform || !['windows', 'windows-x86', 'linux', 'android', 'macos'].includes(platform)) throw new RdgenProtocolError('RDGen start response has invalid remote build metadata');
    const statusUrl = absolute(this.baseUrl, `/check_for_file?${new URLSearchParams({ filename, uuid, platform }).toString()}`);
    return { uuid, filename, platform: platform as Platform, statusUrl, ...(action(html, this.baseUrl) ? { actionUrl: action(html, this.baseUrl) } : {}) };
  }
  async getBuildStatus(remote: RemoteBuild): Promise<RemoteBuildStatus> {
    let response: Response;
    try { response = await this.fetch(absolute(this.baseUrl, remote.statusUrl), { redirect: 'error' }); }
    catch { throw new RdgenTransientError('RDGen status request failed'); }
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) throw new RdgenTransientError(`RDGen status returned HTTP ${response.status}`);
    if (response.status === 404) throw new RdgenRunUnknownError('RDGen has no record of this remote build');
    if (!response.ok) throw new RdgenProtocolError(`RDGen status rejected with HTTP ${response.status}`);
    const html = await response.text(); const text = textStatus(html); const actionUrl = action(html, this.baseUrl) ?? remote.actionUrl;
    const lowered = text.toLowerCase();
    if (/(failure|cancelled|interrupted|timed_out|skipped|action_required|failed)/.test(lowered)) return { stage: 'failed', text, ...(actionUrl ? { actionUrl } : {}) };
    if (/(success|generated|complete)/.test(lowered)) return { stage: 'succeeded', text, ...(actionUrl ? { actionUrl } : {}), manifest: this.getDownloadManifest({ ...remote, ...(actionUrl ? { actionUrl } : {}) }) };
    return { stage: 'pending', text, ...(actionUrl ? { actionUrl } : {}) };
  }
  getDownloadManifest(remote: RemoteBuild): DownloadManifest {
    return { remoteBuild: remote, artifacts: expectedArtifactFilenames(remote.filename, remote.platform).map((filename) => ({ filename, url: absolute(this.baseUrl, `/download?${new URLSearchParams({ filename, uuid: remote.uuid }).toString()}`) })) };
  }
  async downloadArtifact(_remote: RemoteBuild, artifact: { filename: string; url: string }): Promise<DownloadedArtifact> {
    if (!expectedArtifactFilenames(_remote.filename, _remote.platform).includes(artifact.filename)) throw new RdgenProtocolError('RDGen artifact is not in the normalized platform manifest');
    let url = this.allowArtifactUrl(artifact.url); let response: Response | undefined;
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      try { response = await this.fetch(url, { method: 'GET', redirect: 'manual', headers: { accept: 'application/octet-stream' } }); }
      catch { throw new RdgenTransientError('RDGen artifact request failed'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 2) throw new RdgenProtocolError('RDGen artifact redirect is invalid or exceeds the limit');
        url = this.allowArtifactUrl(new URL(location, url).toString()); continue;
      }
      break;
    }
    if (!response || !response.ok || !response.body) throw new RdgenProtocolError(`RDGen artifact returned HTTP ${response?.status ?? 0}`);
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > 512 * 1024 * 1024)) throw new RdgenProtocolError('RDGen artifact content length is invalid');
    return { url, contentType: response.headers.get('content-type'), body: response.body };
  }
  private allowArtifactUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !this.allowedOrigins.has(url.origin)) throw new RdgenProtocolError('RDGen artifact URL is off the allowlist');
    return url.toString();
  }
  private form(configuration: ResolvedJobConfiguration, images: { icon?: Buffer; logo?: Buffer; privacyScreen?: Buffer }): FormData {
    // RDGen's live /generator view is a flat Django form: text/select fields by name, checkboxes present only when true, images as real file uploads.
    const { iconStorageKey, logoStorageKey, privacyStorageKey, ...fields } = configuration;
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string') form.append(key, value);
      else if (typeof value === 'boolean') { if (value) form.append(key, 'on'); }
    }
    if (images.icon) form.append('iconfile', new File([images.icon], 'icon.png', { type: 'image/png' }));
    if (images.logo) form.append('logofile', new File([images.logo], 'logo.png', { type: 'image/png' }));
    if (images.privacyScreen) form.append('privacyfile', new File([images.privacyScreen], 'privacy.png', { type: 'image/png' }));
    return form;
  }
}
