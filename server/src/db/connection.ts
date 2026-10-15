import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SCHEMA } from './schema';

export type DB = DatabaseSync;
export type Params = Record<string, SQLInputValue | boolean | undefined>;
type Row = Record<string, unknown>;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return db;
}

export function createSchema(db: DB): void {
  db.exec(SCHEMA);
}

/**
 * Drops every table in place (rather than deleting the file) so a dev server
 * that already has the database open sees the rebuilt data immediately.
 */
export function dropAllTables(db: DB): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  db.exec('PRAGMA foreign_keys = OFF');
  for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
  db.exec('PRAGMA foreign_keys = ON');
}

/** node:sqlite rejects booleans and undefined; normalise them before binding. */
function bind(params: Params = {}): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return out;
}

export function all<T = Row>(db: DB, sql: string, params?: Params): T[] {
  return db.prepare(sql).all(bind(params)) as T[];
}

export function get<T = Row>(db: DB, sql: string, params?: Params): T | undefined {
  return db.prepare(sql).get(bind(params)) as T | undefined;
}

export function run(db: DB, sql: string, params?: Params): { changes: number; lastId: number } {
  const result = db.prepare(sql).run(bind(params));
  return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
}

let depth = 0;

/** Runs `fn` atomically. Nested calls become savepoints. */
export function transaction<T>(db: DB, fn: () => T): T {
  const name = `sp_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (err) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  }
}

/** Builds `IN (:p0, :p1, …)` placeholders for a list of values. */
export function inList(prefix: string, values: (string | number)[]): { sql: string; params: Params } {
  if (values.length === 0) return { sql: '(NULL)', params: {} };
  const params: Params = {};
  const names = values.map((value, i) => {
    params[`${prefix}${i}`] = value;
    return `:${prefix}${i}`;
  });
  return { sql: `(${names.join(', ')})`, params };
}
