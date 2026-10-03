import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequestInputSchema, validatePngBase64 } from '@rdgen/domain';

function png(): string { return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='; }

test('request schema requires selected presets, unique platforms, and accepts optional/split passwords', () => {
  const valid = { displayName: 'Customer Support', technicalName: 'customer-support', serverId: '00000000-0000-4000-8000-000000000001', presets: { full: '00000000-0000-4000-8000-000000000002', qs: '00000000-0000-4000-8000-000000000003' }, profiles: ['full', 'qs'], platforms: ['windows', 'linux'], version: '1.4.9', profilePasswords: { full: 'full-secret', qs: 'qs-secret' }, images: { icon: { contentType: 'image/png', dataBase64: png() } } };
  assert.equal(buildRequestInputSchema.safeParse(valid).success, true);
  assert.equal(buildRequestInputSchema.safeParse({ ...valid, profiles: ['full'], presets: {} }).success, false);
  assert.equal(buildRequestInputSchema.safeParse({ ...valid, platforms: ['windows', 'windows'] }).success, false);
  assert.equal(buildRequestInputSchema.safeParse({ ...valid, permanentPassword: '' }).success, true);
  assert.equal(validatePngBase64(valid.images.icon.dataBase64).width, 1);
});
