import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTransition, canTransition, retryDelayMs, terminalJobStatuses } from './lifecycle.js';
test('the lifecycle makes indeterminate starts explicit and never automatically resendable', () => {
  assert.equal(canTransition('iniciando', 'início_indeterminado'), true);
  assert.equal(canTransition('início_indeterminado', 'iniciando'), false);
  assert.equal(canTransition('início_indeterminado', 'aguardando_rdgen'), true);
  assert.equal(canTransition('início_indeterminado', 'aguardando_retry'), true);
  assert.throws(() => assertTransition('concluído', 'cancelado'));
  assert.equal(terminalJobStatuses.has('cancelado'), true);
});
test('transient retries are capped by exponential backoff values', () => {
  assert.equal(retryDelayMs(1, 10, 100), 10); assert.equal(retryDelayMs(2, 10, 100), 20); assert.equal(retryDelayMs(10, 10, 100), 100);
});
