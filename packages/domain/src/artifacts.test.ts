import assert from 'node:assert/strict';
import test from 'node:test';
import { ArtifactValidationError, copyAndHashArtifact, expectedArtifactFilenames, validateArtifactFormat, validateNormalizedManifest } from './artifacts.js';
import { RdgenProtocolError, RdgenProvider } from './rdgen-provider.js';

function stream(bytes: Buffer): ReadableStream<Uint8Array> { return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }); }
test('artifact checks accept a streamed Windows executable and bind it to normalized provenance', async () => {
  const bytes = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(96)]); const chunks: Buffer[] = [];
  const measured = await copyAndHashArtifact(stream(bytes), async (chunk) => { chunks.push(Buffer.from(chunk)); }, 'application/octet-stream');
  validateArtifactFormat('acme.exe', measured.prefix, measured.suffix);
  assert.equal(measured.bytes, 98); assert.match(measured.sha256, /^[a-f0-9]{64}$/);
  const remote = { uuid: '11111111-1111-4111-8111-111111111111', filename: 'acme', platform: 'windows' as const, statusUrl: 'https://rdgen.crayoneater.org/check' };
  assert.deepEqual(validateNormalizedManifest({ remoteBuild: remote, artifacts: [{ filename: 'acme.exe', url: 'https://rdgen.crayoneater.org/download' }] }, remote).map((item) => item.filename), ['acme.exe']);
  assert.deepEqual(expectedArtifactFilenames('acme', 'windows'), ['acme.exe', 'acme.msi']);
});
test('artifact checks reject HTML/error payloads and incompatible names or formats', async () => {
  await assert.rejects(() => copyAndHashArtifact(stream(Buffer.from('<html>error page</html>'.padEnd(90))), async () => undefined, 'text/html'), ArtifactValidationError);
  assert.throws(() => validateArtifactFormat('acme.exe', Buffer.alloc(96), Buffer.alloc(0)), ArtifactValidationError);
  const remote = { uuid: '11111111-1111-4111-8111-111111111111', filename: 'acme', platform: 'windows' as const, statusUrl: 'https://rdgen.crayoneater.org/check' };
  assert.throws(() => validateNormalizedManifest({ remoteBuild: remote, artifacts: [{ filename: '../outside.exe', url: 'https://rdgen.crayoneater.org/x' }] }, remote), ArtifactValidationError);
});
test('provider allows only allowlisted HTTPS redirects and caps the redirect chain', async () => {
  let calls = 0;
  const provider = new RdgenProvider({ fetch: async () => {
    calls += 1;
    if (calls < 3) return new Response(null, { status: 302, headers: { location: `/redirect-${calls}` } });
    return new Response(Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(96)]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  } });
  const remote = { uuid: '11111111-1111-4111-8111-111111111111', filename: 'acme', platform: 'windows' as const, statusUrl: 'https://rdgen.crayoneater.org/check' };
  const downloaded = await provider.downloadArtifact(remote, { filename: 'acme.exe', url: 'https://rdgen.crayoneater.org/download' });
  assert.equal(calls, 3); assert.equal(downloaded.contentType, 'application/octet-stream');
  await assert.rejects(() => provider.downloadArtifact(remote, { filename: 'acme.exe', url: 'https://evil.example/download' }), RdgenProtocolError);
});
