import type { User } from '@prisma/client';
import { getPrisma } from '../../db/client.js';
import { getEnv } from '../../config/env.js';
import { generateToken, hashPassword, sha256Hex, verifyPassword } from '../../lib/crypto.js';
import { AuthError } from '../../lib/errors.js';

/**
 * Dashboard authentication: opaque session tokens stored hashed in Postgres,
 * delivered as HttpOnly cookies. No JWTs to leak, immediate revocation.
 */

export const SESSION_COOKIE = 'sid';

// Verified against when the login is unknown, so both paths cost one full
// scrypt derivation — otherwise response timing enumerates valid logins.
let timingEqualizerHash: string | null = null;

export async function login(
  username: string,
  password: string,
): Promise<{ token: string; user: User; expiresAt: Date }> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { username: username.trim() } });
  // Uniform error AND uniform work whether the user exists or not.
  if (!user) {
    timingEqualizerHash ??= await hashPassword('timing-equalizer-dummy-password');
    await verifyPassword(password, timingEqualizerHash);
    throw new AuthError('Invalid login or password');
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new AuthError('Invalid login or password');
  }

  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + getEnv().SESSION_TTL_HOURS * 3600_000);
  await prisma.authSession.create({
    data: { id: sha256Hex(token), userId: user.id, expiresAt },
  });
  return { token, user, expiresAt };
}

export async function logout(token: string): Promise<void> {
  await getPrisma()
    .authSession.delete({ where: { id: sha256Hex(token) } })
    .catch(() => undefined);
}

export async function getSessionUser(token: string): Promise<User | null> {
  const prisma = getPrisma();
  const session = await prisma.authSession.findUnique({
    where: { id: sha256Hex(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.authSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return session.user;
}

export async function createUser(params: {
  tenantId: string;
  username: string;
  email?: string;
  password: string;
  name: string;
  role: 'ADMIN' | 'OPERATOR';
}): Promise<User> {
  const prisma = getPrisma();
  return prisma.user.create({
    data: {
      tenantId: params.tenantId,
      username: params.username.trim(),
      email: params.email?.toLowerCase().trim() ?? null,
      passwordHash: await hashPassword(params.password),
      name: params.name,
      role: params.role,
    },
  });
}

/** Periodic cleanup of expired sessions. */
export async function pruneExpiredSessions(): Promise<void> {
  await getPrisma().authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
