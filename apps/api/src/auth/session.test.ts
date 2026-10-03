import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpaqueToken, hashOpaqueToken, opaqueTokenMatches } from '@rdgen/domain';
import { parseCookies, sessionCookie } from './session.service.js';

const environment = {
  DATABASE_URL: 'postgresql://rdgen:rdgen@localhost:5432/rdgen_automator',
  REDIS_URL: 'redis://localhost:6379',
  APP_STORAGE_PATH: '/tmp/rdgen-session-test',
  APP_ENCRYPTION_KEY: Buffer.alloc(32),
  APP_ENCRYPTION_KEY_ID: 'test-key',
  API_PORT: 3001,
  WEB_PORT: 3000,
  WORKER_PORT: 3002,
  APP_BIND_HOST: '127.0.0.1',
  API_BASE_URL: 'https://localhost:3001'
};

test('session and CSRF values are opaque, independently generated, and checked in constant time', () => {
  const firstSession = createOpaqueToken();
  const secondSession = createOpaqueToken();
  const csrf = createOpaqueToken();
  assert.notEqual(firstSession, secondSession);
  assert.notEqual(firstSession, csrf);
  const digest = hashOpaqueToken(firstSession);
  assert.notEqual(digest, firstSession);
  assert.equal(opaqueTokenMatches(firstSession, digest), true);
  assert.equal(opaqueTokenMatches(secondSession, digest), false);
});

test('the session cookie is HttpOnly, SameSite, and Secure over HTTPS', () => {
  const cookie = sessionCookie('opaque value', environment);
  assert.match(cookie, /^rdgen_session=opaque%20value;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.deepEqual(parseCookies('other=value; rdgen_session=opaque%20value'), { other: 'value', rdgen_session: 'opaque value' });
});
