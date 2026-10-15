import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { CompanyRef, Role, SessionInfo, SessionUser } from '../../../shared/api';
import { all, get, run, type DB } from '../db/connection';
import { initials, type Scope } from './context';

const SESSION_DAYS = 7;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

interface UserRow {
  id: number;
  name: string;
  email: string;
  title: string | null;
  role: Role;
  password_hash: string;
}

/**
 * Sessions are signed cookies (`v1.<userId>.<expiry>.<hmac>`) rather than
 * rows in the database, so any server instance can check them. That matters
 * on Vercel, where every function instance has its own in-memory database.
 *
 * The signing key comes from SESSION_SECRET, then a key baked in at build time
 * (Vercel bundle), then a random key stored in the database, which rotates on
 * every `db:reset` and so signs everyone out.
 */
const TOKEN_VERSION = 'v1';

function sessionSecret(db: DB): string {
  const fromEnv = process.env.SESSION_SECRET || process.env.BUILD_SESSION_SECRET;
  if (fromEnv) return fromEnv;
  const stored = get<{ value: string }>(db, "SELECT value FROM app_settings WHERE key = 'session_secret'");
  if (stored) return stored.value;
  const value = randomBytes(32).toString('hex');
  run(db, "INSERT INTO app_settings (key, value) VALUES ('session_secret', :value)", { value });
  return value;
}

function sign(db: DB, payload: string): string {
  return createHmac('sha256', sessionSecret(db)).update(payload).digest('base64url');
}

export function login(db: DB, email: string, password: string): { token: string; user: SessionUser } | null {
  const user = get<UserRow>(db, 'SELECT * FROM users WHERE email = :email COLLATE NOCASE', { email: email.trim() });
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400;
  const payload = `${TOKEN_VERSION}.${user.id}.${expires}`;
  return { token: `${payload}.${sign(db, payload)}`, user: toSessionUser(user) };
}

export function userForToken(db: DB, token: string): SessionUser | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;
  const [version, id, expires, signature] = parts as [string, string, string, string];
  if (!/^\d+$/.test(id) || !/^\d+$/.test(expires)) return null;
  const expected = Buffer.from(sign(db, `${version}.${id}.${expires}`));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  if (Number(expires) * 1000 < Date.now()) return null;
  const user = get<UserRow>(db, 'SELECT * FROM users WHERE id = :id', { id: Number(id) });
  return user ? toSessionUser(user) : null;
}

function toSessionUser(user: UserRow): SessionUser {
  return { id: user.id, name: user.name, initials: initials(user.name), email: user.email, title: user.title, role: user.role };
}

/** Admins see every company; analysts see the companies they are members of. */
export function scopeFor(db: DB, user: SessionUser): Scope {
  const companyIds =
    user.role === 'admin'
      ? all<{ id: number }>(db, 'SELECT id FROM companies ORDER BY id').map((r) => r.id)
      : all<{ company_id: number }>(db, 'SELECT company_id FROM memberships WHERE user_id = :id ORDER BY company_id', { id: user.id }).map(
          (r) => r.company_id,
        );
  return { userId: user.id, role: user.role, companyIds, canSeeUnassigned: user.role === 'admin' };
}

export function sessionInfo(db: DB, user: SessionUser, scope: Scope): SessionInfo {
  const companies = all<{ id: number; name: string; slug: string; default_currency: string; erp_system: string | null; is_active: number }>(
    db,
    `SELECT * FROM companies WHERE id IN (${scope.companyIds.map((_, i) => `:c${i}`).join(', ') || 'NULL'}) ORDER BY is_active DESC, name`,
    Object.fromEntries(scope.companyIds.map((id, i) => [`c${i}`, id])),
  ).map(
    (c): CompanyRef => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      currency: c.default_currency,
      erpSystem: c.erp_system,
      isActive: c.is_active === 1,
    }),
  );
  return { user, companies, canSeeUnassigned: scope.canSeeUnassigned };
}
