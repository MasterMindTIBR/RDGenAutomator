import { createHash, randomUUID } from 'node:crypto';
import type { Platform } from './configuration.js';
import type { DownloadManifest, RemoteBuild } from './rdgen-provider.js';

export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MIN_ARTIFACT_BYTES = 64;
export class ArtifactValidationError extends Error {}
export type NormalizedArtifact = { filename: string; url: string };
export type DownloadedArtifact = { url: string; contentType: string | null; body: ReadableStream<Uint8Array> };

export function expectedArtifactFilenames(filename: string, platform: Platform): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw new ArtifactValidationError('Invalid normalized remote filename');
  if (platform === 'windows') return [`${filename}.exe`, `${filename}.msi`];
  if (platform === 'windows-x86') return [`${filename}.exe`];
  if (platform === 'macos') return [`${filename}-x86_64.dmg`, `${filename}-aarch64.dmg`];
  if (platform === 'android') return [`${filename}-aarch64.apk`, `${filename}-x86_64.apk`, `${filename}-armv7.apk`];
  return [`${filename}-x86_64.deb`, `${filename}-x86_64.rpm`, `${filename}-suse-x86_64.rpm`, `${filename}-x86_64.pkg.tar.zst`, `${filename}-aarch64.deb`, `${filename}-aarch64.rpm`, `${filename}-suse-aarch64.rpm`, `${filename}-suse-aarch64.pkg.tar.zst`, `${filename}-x86_64.AppImage`, `${filename}-aarch64.AppImage`, `${filename}-x86_64.flatpak`, `${filename}-aarch64.flatpak`];
}

/** Rejects anything that was not constructed by the normalized provider contract. */
export function validateNormalizedManifest(manifest: DownloadManifest, remote: RemoteBuild): NormalizedArtifact[] {
  if (manifest.remoteBuild.uuid !== remote.uuid || manifest.remoteBuild.filename !== remote.filename || manifest.remoteBuild.platform !== remote.platform) throw new ArtifactValidationError('Manifest provenance does not match the active remote build');
  const expected = new Set(expectedArtifactFilenames(remote.filename, remote.platform)); const seen = new Set<string>();
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw new ArtifactValidationError('Normalized manifest is empty');
  return manifest.artifacts.map((artifact) => {
    if (!artifact || typeof artifact.filename !== 'string' || typeof artifact.url !== 'string' || !expected.has(artifact.filename) || seen.has(artifact.filename)) throw new ArtifactValidationError('Manifest contains an unexpected artifact');
    seen.add(artifact.filename); try { new URL(artifact.url); } catch { throw new ArtifactValidationError('Manifest contains an invalid artifact URL'); }
    return { filename: artifact.filename, url: artifact.url };
  });
}

export function contentTypeFor(filename: string): string {
  if (filename.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (filename.endsWith('.msi')) return 'application/x-msi';
  if (filename.endsWith('.apk')) return 'application/vnd.android.package-archive';
  if (filename.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (filename.endsWith('.deb')) return 'application/vnd.debian.binary-package';
  if (filename.endsWith('.rpm')) return 'application/x-rpm';
  return 'application/octet-stream';
}
export function artifactStorageKey(jobId: string): string { return `generated/artifacts/${jobId}/${randomUUID()}`; }
export function rejectResponseContent(contentType: string | null, prefix: Buffer): void {
  if (contentType && /(?:text\/html|application\/(?:json|problem\+json)|text\/plain)/i.test(contentType)) throw new ArtifactValidationError('Artifact response has an unsafe content type');
  const text = prefix.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (text.startsWith('<!doctype') || text.startsWith('<html') || text.startsWith('{"') || text.startsWith('error')) throw new ArtifactValidationError('Artifact response contains HTML or an error document');
}
export function validateArtifactFormat(filename: string, prefix: Buffer, suffix: Buffer): void {
  const starts = (...values: number[]) => prefix.subarray(0, values.length).equals(Buffer.from(values)); const extension = filename.slice(filename.lastIndexOf('.'));
  const valid = extension === '.exe' ? starts(0x4d, 0x5a) : extension === '.msi' ? starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) : extension === '.apk' ? starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) : extension === '.flatpak' ? starts(0x50, 0x4b, 0x03, 0x04) || prefix.subarray(0, 6).equals(Buffer.from('ostree')) : extension === '.deb' ? prefix.subarray(0, 8).equals(Buffer.from('!<arch>\n')) : extension === '.rpm' ? starts(0xed, 0xab, 0xee, 0xdb) : extension === '.AppImage' ? starts(0x7f, 0x45, 0x4c, 0x46) : extension === '.dmg' ? suffix.includes(Buffer.from('koly')) : extension === '.zst' ? starts(0x28, 0xb5, 0x2f, 0xfd) : false;
  if (!valid) throw new ArtifactValidationError(`Artifact ${filename} does not have the expected binary format`);
}
export async function copyAndHashArtifact(source: ReadableStream<Uint8Array>, write: (chunk: Uint8Array) => Promise<void>, contentType: string | null): Promise<{ bytes: number; sha256: string; prefix: Buffer; suffix: Buffer }> {
  const reader = source.getReader(); const hash = createHash('sha256'); let bytes = 0; let prefix = Buffer.alloc(0); let suffix = Buffer.alloc(0);
  let failed = true;
  try { while (true) { const next = await reader.read(); if (next.done) break; const chunk = Buffer.from(next.value); bytes += chunk.byteLength; if (bytes > MAX_ARTIFACT_BYTES) throw new ArtifactValidationError('Artifact exceeds the streaming size limit'); if (prefix.byteLength < 512) prefix = Buffer.concat([prefix, chunk]).subarray(0, 512); suffix = Buffer.concat([suffix, chunk]).subarray(Math.max(0, suffix.byteLength + chunk.byteLength - 512)); hash.update(chunk); await write(chunk); } failed = false; } finally { if (failed) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (bytes < MIN_ARTIFACT_BYTES) throw new ArtifactValidationError('Artifact is below the minimum size'); rejectResponseContent(contentType, prefix); return { bytes, sha256: hash.digest('hex'), prefix, suffix };
}
