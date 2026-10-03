import { describe, expect, it, vi } from 'vitest';
import { backendRequest, forwardBackendRequest } from './proxy';

describe('same-origin backend proxy', () => {
  it('forwards the session, CSRF and idempotency headers', () => {
    const request = new Request('http://web.test/api/backend/build-requests?x=1', { method: 'POST', headers: { cookie: 'rdgen_session=s', 'x-csrf-token': 'csrf', 'idempotency-key': 'attempt-1', 'content-type': 'application/json', 'x-not-forwarded': 'no' }, body: '{}' });
    const forwarded = backendRequest(request, 'http://api.test:3001', '/build-requests');
    expect(forwarded.url).toBe('http://api.test:3001/build-requests?x=1');
    expect(forwarded.headers.get('cookie')).toBe('rdgen_session=s');
    expect(forwarded.headers.get('x-csrf-token')).toBe('csrf');
    expect(forwarded.headers.get('idempotency-key')).toBe('attempt-1');
    expect(forwarded.headers.get('content-type')).toBe('application/json');
    expect(forwarded.headers.has('x-not-forwarded')).toBe(false);
  });

  it('copies content type and set-cookie and prevents redirects', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'rdgen_session=s; HttpOnly' } }));
    vi.stubGlobal('fetch', fetchStub);
    const response = await forwardBackendRequest(new Request('http://web.test/api/backend/me'), '/me', 'http://api.test:3001');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('set-cookie')).toContain('rdgen_session=s');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(fetchStub.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    vi.unstubAllGlobals();
  });

  it('forwards a body-less POST (e.g. logout) without disturbing the request stream', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchStub);
    const response = await forwardBackendRequest(new Request('http://web.test/api/backend/auth/logout', { method: 'POST', headers: { cookie: 'rdgen_session=s', 'x-csrf-token': 'csrf' } }), '/auth/logout', 'http://api.test:3001');
    expect(response.status).toBe(204);
    const forwarded = fetchStub.mock.calls[0]?.[0] as Request;
    expect(forwarded.method).toBe('POST');
    vi.unstubAllGlobals();
  });
});
