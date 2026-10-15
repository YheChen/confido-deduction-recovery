import { existsSync } from 'node:fs';
import { config, today } from './config';
import { openDatabase } from './db/connection';
import { createApp } from './http/app';

if (!existsSync(config.dbFile)) {
  console.error(`No database at ${config.dbFile}. Run "npm run db:reset" first.`);
  process.exit(1);
}

const db = openDatabase(config.dbFile);
const app = createApp(db, {
  today,
  showDemoAccounts: config.showDemoAccounts,
  staticDir: config.production ? config.webDist : undefined,
  secureCookies: false,
});

app.listen(config.port, () => {
  const where = config.production ? `http://localhost:${config.port}` : `http://localhost:${config.port} (API; web on :5173)`;
  console.log(`Deduction Recovery API listening on ${where}`);
});
