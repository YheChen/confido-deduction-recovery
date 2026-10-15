/**
 * Vercel entry point, bundled into a single file by scripts/build-vercel.mjs.
 *
 * Vercel functions have no persistent disk, so each instance builds its own
 * in-memory copy of the demo when it starts: the export, the demo users and
 * the simulated history (about a second). Changes made in the app last as
 * long as that instance stays warm, which is why the UI labels it a sandbox.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createSchema, openDatabase } from './db/connection';
import { localDate } from './domain/context';
import { createApp } from './http/app';
import { importExport } from './import/importer';
import { simulateActivity } from './seed/demo';
import { seedUsers } from './seed/users';

const today = () => process.env.AS_OF ?? localDate(new Date());
// The build copies data/*.json next to the bundle.
const dataDir = process.env.DATA_DIR ?? fileURLToPath(new URL('./data/', import.meta.url));

const started = Date.now();
const db = openDatabase(':memory:');
createSchema(db);
importExport(db, { dataDir, today: today() });
seedUsers(db);
simulateActivity(db, { today: today() });
console.log(`Sandbox database ready in ${Date.now() - started} ms`);

const app = createApp(db, {
  today,
  showDemoAccounts: true,
  sandbox: true,
  secureCookies: process.env.VERCEL === '1',
});

/**
 * Requests arrive through a rewrite to this one function. As SvelteKit's
 * Vercel adapter does, the route passes the original path as `__pathname`;
 * restore it so Express routes match whichever URL Vercel hands us.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.searchParams.get('__pathname');
  if (pathname !== null) {
    url.searchParams.delete('__pathname');
    if (!url.pathname.startsWith('/api/')) url.pathname = pathname;
    req.url = `${url.pathname}${url.search}`;
  }
  app(req, res);
}
