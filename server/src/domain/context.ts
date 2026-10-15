import type { Role } from '../../../shared/api';
import { inList, type Params } from '../db/connection';

/** Thrown for anything the caller did wrong; the HTTP layer maps `status` straight through. */
export class DomainError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Deduction') => new DomainError(404, `${what} not found.`);
export const conflict = (message: string) => new DomainError(409, message);
export const invalid = (message: string) => new DomainError(400, message);

/**
 * What one person may see. Every query that touches deductions goes through
 * `scopeSql`, so a record outside someone's companies is indistinguishable
 * from one that does not exist.
 */
export interface Scope {
  userId: number;
  role: Role;
  companyIds: number[];
  /** Admins can also see records whose company could not be resolved. */
  canSeeUnassigned: boolean;
}

export function scopeSql(scope: Scope, alias = 'd', opts: { includeUnassigned?: boolean } = {}): { sql: string; params: Params } {
  const list = inList('scope', scope.companyIds);
  const unassigned = opts.includeUnassigned && scope.canSeeUnassigned ? ` OR ${alias}.company_id IS NULL` : '';
  return { sql: `(${alias}.company_id IN ${list.sql}${unassigned})`, params: list.params };
}

/** Narrows a scope to a single company, refusing companies the person cannot see. */
export function narrowScope(scope: Scope, companyId: number | undefined): Scope {
  if (companyId === undefined) return scope;
  if (!scope.companyIds.includes(companyId)) throw new DomainError(403, 'You do not have access to that company.');
  return { ...scope, companyIds: [companyId] };
}

/** Who is acting and when. The demo seeder passes backdated clocks. */
export interface Actor {
  userId: number | null;
  /** ISO timestamp used for activity rows. */
  now: string;
  /** YYYY-MM-DD used for date validation and closing dates. */
  today: string;
  simulated?: boolean;
}

export function actorNow(userId: number | null): Actor {
  const now = new Date();
  return { userId, now: now.toISOString(), today: localDate(now) };
}

export function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .slice(0, 2)
    .join('');
}

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
