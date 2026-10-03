import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type UserRole = 'administrator' | 'user';
export type UserStatus = 'active' | 'disabled';

export type AuthenticatedActor = {
  userId: string;
  role: UserRole;
  sessionId: string;
};

export type OwnedResource = {
  creatorId: string;
  visibility: 'private' | 'published';
};

/** The access rule shared by requests, jobs, and artifacts. */
export function canReadOwnedResource(actor: Pick<AuthenticatedActor, 'userId' | 'role'>, resource: OwnedResource): boolean {
  return actor.role === 'administrator' || resource.creatorId === actor.userId || resource.visibility === 'published';
}

/** Mutations of an owned resource remain private to its creator and administrators. */
export function canManageOwnedResource(actor: Pick<AuthenticatedActor, 'userId' | 'role'>, resource: Pick<OwnedResource, 'creatorId'>): boolean {
  return actor.role === 'administrator' || resource.creatorId === actor.userId;
}

/** Opaque values are stored only as a one-way digest. */
export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function opaqueTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Shared strength rule for any password an administrator or user sets through the panel. */
export function isStrongPassword(password: string): boolean {
  return password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
}
