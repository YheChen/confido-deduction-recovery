/**
 * Rebuilds the database from data/*.json.
 *
 *   npm run db:reset              import + demo users + simulated analyst history
 *   npm run db:reset -- --no-demo import + demo users only (pristine export)
 */
import { config, today } from '../config';
import { createSchema, dropAllTables, openDatabase } from '../db/connection';
import { importExport } from '../import/importer';
import { simulateActivity } from '../seed/demo';
import { DEMO_PASSWORD, DEMO_USERS, seedUsers } from '../seed/users';

const withDemo = !process.argv.includes('--no-demo');

const db = openDatabase(config.dbFile);
dropAllTables(db);
createSchema(db);

const asOf = today();
const stats = importExport(db, { dataDir: config.dataDir, today: asOf });
seedUsers(db);

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${value}`);
console.log(`\nImported ${config.dataDir}/deductions.json (as of ${asOf})`);
line('rows read', stats.rowsRead);
line('exact duplicate rows dropped', `${stats.exactDuplicateRows.length} (ids ${stats.exactDuplicateRows.join(', ')})`);
line('unique deductions', stats.uniqueIds);
line('soft-deleted in source (hidden)', stats.softDeleted);
line('same deduction under a new id', stats.probableDuplicates.map((d) => `#${d.id}→#${d.of}`).join(', '));
line('empty rows', stats.empty.join(', '));
line('active deductions', stats.active);
line('unknown company (admin queue)', Object.entries(stats.unassigned).map(([k, v]) => `company_id ${k}: ${v}`).join(', '));

if (withDemo) {
  const sim = simulateActivity(db, { today: asOf });
  console.log(`\nSimulated analyst activity since ${sim.windowStart} (marked "Simulated" in the app)`);
  line('assigned', sim.assigned);
  line('reviewed / accepted / sent to ops', `${sim.reviewed} / ${sim.accepted} / ${sim.sentToOps}`);
  line('disputes opened / submitted', `${sim.opened} / ${sim.submitted}`);
  line('decisions / appeals', `${sim.decided} / ${sim.appealed}`);
  line('payments recorded / closed', `${sim.payments} / ${sim.closed}`);
} else {
  console.log('\nSkipped simulated activity (--no-demo).');
}

console.log(`\nDemo accounts (password: ${DEMO_PASSWORD})`);
for (const user of DEMO_USERS) {
  line(user.email, `${user.role}${user.companies.length ? ` · ${user.companies.join(', ')}` : ' · all companies'}`);
}
db.exec('VACUUM');
console.log(`\nDatabase written to ${config.dbFile}\n`);
db.close();
