import assert from 'node:assert/strict';
import test from 'node:test';
import { RdgenAmbiguousStartError, RdgenTerminalError, RdgenTransientError } from '@rdgen/domain';
test('worker error taxonomy separates ambiguous starts from retryable transient errors', () => {
  assert.equal(new RdgenAmbiguousStartError('lost response') instanceof RdgenTransientError, false);
  assert.equal(new RdgenTransientError('503') instanceof RdgenTransientError, true);
  assert.equal(new RdgenTerminalError('400') instanceof RdgenTransientError, false);
});
test('worker durable lifecycle source contains pre-POST intent and lease guarded dispatch', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('./lifecycle.ts', import.meta.url), 'utf8'));
  assert.match(source, /start_intent_at/); assert.match(source, /lease_expires_at/); assert.match(source, /início_indeterminado/); assert.match(source, /provider_rejected/); assert.match(source, /job_outbox/);
});
