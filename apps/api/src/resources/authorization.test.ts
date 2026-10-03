import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageOwnedResource, canReadOwnedResource } from '@rdgen/domain';

const creator = { userId: 'creator', role: 'user' as const };
const otherUser = { userId: 'other', role: 'user' as const };
const administrator = { userId: 'admin', role: 'administrator' as const };

test('direct resource IDs use the same owner/private/published rule for requests and artifacts', () => {
  const privateResource = { creatorId: creator.userId, visibility: 'private' as const };
  const publishedResource = { creatorId: creator.userId, visibility: 'published' as const };

  for (const resource of [privateResource, publishedResource]) {
    assert.equal(canReadOwnedResource(creator, resource), true);
    assert.equal(canReadOwnedResource(administrator, resource), true);
  }
  assert.equal(canReadOwnedResource(otherUser, privateResource), false);
  assert.equal(canReadOwnedResource(otherUser, publishedResource), true);
  assert.equal(canManageOwnedResource(otherUser, privateResource), false);
  assert.equal(canManageOwnedResource(creator, privateResource), true);
  assert.equal(canManageOwnedResource(administrator, privateResource), true);
});
