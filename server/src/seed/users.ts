import type { DemoAccount, Role } from '../../../shared/api';
import { all, get, run, transaction, type DB } from '../db/connection';
import { hashPassword } from '../domain/auth';

/** Shared password for the seeded demo accounts (shown on the login screen in dev). */
export const DEMO_PASSWORD = 'recover-2026';

interface SeedUser {
  name: string;
  email: string;
  title: string;
  role: Role;
  /** Company slugs from companies.json. Admins see every company regardless. */
  companies: string[];
}

export const DEMO_USERS: SeedUser[] = [
  { name: 'Maya Patel', email: 'maya@example.com', title: 'Deductions Analyst', role: 'analyst', companies: ['cascade-snacks'] },
  { name: 'Jordan Lee', email: 'jordan@example.com', title: 'Deductions Analyst', role: 'analyst', companies: ['northfield-bev'] },
  {
    name: 'Sam Rivera',
    email: 'sam@example.com',
    title: 'Senior Analyst',
    role: 'analyst',
    companies: ['cascade-snacks', 'northfield-bev', 'harbor-vine'],
  },
  { name: 'Avery Chen', email: 'avery@example.com', title: 'Recovery Ops Lead', role: 'admin', companies: [] },
];

export function seedUsers(db: DB): void {
  transaction(db, () => {
    for (const user of DEMO_USERS) {
      const { lastId } = run(db, 'INSERT INTO users (name, email, title, role, password_hash) VALUES (:name, :email, :title, :role, :hash)', {
        name: user.name,
        email: user.email,
        title: user.title,
        role: user.role,
        hash: hashPassword(DEMO_PASSWORD),
      });
      for (const slug of user.companies) {
        const company = get<{ id: number }>(db, 'SELECT id FROM companies WHERE slug = :slug', { slug });
        if (!company) throw new Error(`Seed user ${user.email} references unknown company ${slug}`);
        run(db, 'INSERT INTO memberships (user_id, company_id) VALUES (:user, :company)', { user: lastId, company: company.id });
      }
    }
  });
}

export function demoAccounts(db: DB): DemoAccount[] {
  return all<{ id: number; name: string; email: string; title: string | null; role: Role }>(
    db,
    'SELECT id, name, email, title, role FROM users ORDER BY role DESC, id',
  ).map((u) => ({
    email: u.email,
    name: u.name,
    title: u.title,
    role: u.role,
    companies:
      u.role === 'admin'
        ? ['All companies', 'Unassigned records']
        : all<{ name: string }>(
            db,
            'SELECT c.name FROM memberships m JOIN companies c ON c.id = m.company_id WHERE m.user_id = :id ORDER BY c.name',
            { id: u.id },
          ).map((c) => c.name),
  }));
}
