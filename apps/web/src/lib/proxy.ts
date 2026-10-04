export const forwardedRequestHeaders = ['cookie', 'x-csrf-token', 'idempotency-key', 'content-type'] as const;
export function backendRequest(request: Request, apiBaseUrl: string, path: string, bodyOverride?: ArrayBuffer): Request {
  const headers = new Headers();
  for (const name of forwardedRequestHeaders) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  const url = new URL(request.url); const target = new URL(`${path}${url.search}`, apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`);
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : bodyOverride ?? request.body;
  return new Request(target, { method: request.method, headers, body, ...(body ? { duplex: 'half' } : {}), redirect: 'manual' } as RequestInit);
}
export async function forwardBackendRequest(request: Request, path: string, apiBaseUrl = process.env['API_BASE_URL'] ?? 'http://127.0.0.1:3001'): Promise<Response> {
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const upstream = await fetch(backendRequest(request, apiBaseUrl, path, body));
  if (upstream.status >= 300 && upstream.status < 400) return new Response('Unexpected redirect from API.', { status: 502, headers: { 'cache-control': 'private, no-store' } });
  const headers = new Headers({ 'cache-control': 'private, no-store' }); for (const name of ['content-type', 'content-disposition', 'content-length', 'x-content-type-options'] as const) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
  const cookies = (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')!] : []); for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}
