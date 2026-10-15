import { resolve } from 'node:path';
import { createSchema, get, openDatabase, type DB } from '../src/db/connection';
import type { Actor, Scope } from '../src/domain/context';
import { importExport } from '../src/import/importer';
import { seedUsers } from '../src/seed/users';

export const TODAY = '2026-10-14';
export const DATA_DIR = resolve(__dirname, '../../data');

/** In-memory database with the real export imported and demo users seeded (no simulated history). */
export function freshDb(): DB {
  const db = openDatabase(':memory:');
  createSchema(db);
  importExport(db, { dataDir: DATA_DIR, today: TODAY, now: `${TODAY}T12:00:00.000Z` });
  seedUsers(db);
  return db;
}

export function userId(db: DB, email: string): number {
  return get<{ id: number }>(db, 'SELECT id FROM users WHERE email = :email', { email })!.id;
}

export function actor(db: DB, email: string, today = TODAY): Actor {
  return { userId: userId(db, email), now: `${today}T15:00:00.000Z`, today };
}

export const cascadeScope = (db: DB): Scope => ({
  userId: userId(db, 'maya@example.com'),
  role: 'analyst',
  companyIds: [1],
  canSeeUnassigned: false,
});

export const adminScope = (db: DB): Scope => ({
  userId: userId(db, 'avery@example.com'),
  role: 'admin',
  companyIds: [1, 2, 4, 5],
  canSeeUnassigned: true,
});
