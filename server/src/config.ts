import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate } from './domain/context';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(SERVER_ROOT, '..');

export const config = {
  /** Not PORT: dev tooling often sets PORT for the web server, and the Vite proxy expects the API on 3001. */
  port: Number(process.env.API_PORT ?? 3001),
  dataDir: process.env.DATA_DIR ?? resolve(REPO_ROOT, 'data'),
  dbFile: process.env.DB_FILE ?? resolve(SERVER_ROOT, 'var', 'confido.db'),
  webDist: resolve(REPO_ROOT, 'web', 'dist'),
  production: process.env.NODE_ENV === 'production',
  /** Lists the seeded accounts on the sign-in screen. Turn off anywhere real. */
  showDemoAccounts: process.env.SHOW_DEMO_ACCOUNTS !== 'false',
};

/** "Today" for date checks and aging. AS_OF=YYYY-MM-DD pins it for reproducible demos. */
export function today(): string {
  return process.env.AS_OF ?? localDate(new Date());
}
