import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DeductionDetail, DeductionListResponse } from '../../shared/api';
import { get, type DB } from '../src/db/connection';
import { createApp } from '../src/http/app';
import { DEMO_PASSWORD } from '../src/seed/users';
import { freshDb, TODAY } from './helpers';

let db: DB;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = freshDb();
  app = createApp(db, { today: () => TODAY, showDemoAccounts: true });
});

async function signIn(email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: DEMO_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe('auth', () => {
  it('rejects anonymous requests and bad passwords', async () => {
    expect((await request(app).get('/api/deductions')).status).toBe(401);
    const res = await request(app).post('/api/auth/login').send({ email: 'maya@example.com', password: 'nope' });
    expect(res.status).toBe(401);
  });

  it('signs out', async () => {
    const agent = await signIn('maya@example.com');
    await agent.post('/api/auth/logout').expect(204);
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('rejects session cookies that were tampered with or forged', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'maya@example.com', password: DEMO_PASSWORD });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!; // recovery_session=v1.<id>.<exp>.<sig>
    const [name, token] = cookie.split('=') as [string, string];
    const [version, id, expires, signature] = token.split('.');
    expect((await request(app).get('/api/me').set('Cookie', cookie)).status).toBe(200);

    // Same signature, different user (try to become the admin)
    const admin = `${name}=${version}.4.${expires}.${signature}`;
    expect((await request(app).get('/api/me').set('Cookie', admin)).status).toBe(401);
    // Pushed-out expiry
    const longer = `${name}=${version}.${id}.${Number(expires) + 86_400}.${signature}`;
    expect((await request(app).get('/api/me').set('Cookie', longer)).status).toBe(401);
    // Garbage
    expect((await request(app).get('/api/me').set('Cookie', `${name}=not-a-token`)).status).toBe(401);
  });

  it('keeps a session valid across app instances that share the signing key', async () => {
    process.env.SESSION_SECRET = 'shared-test-secret';
    try {
      const first = createApp(freshDb(), { today: () => TODAY });
      const second = createApp(freshDb(), { today: () => TODAY });
      const res = await request(first).post('/api/auth/login').send({ email: 'jordan@example.com', password: DEMO_PASSWORD });
      const cookie = String(res.headers['set-cookie']).split(';')[0]!;
      const me = await request(second).get('/api/me').set('Cookie', cookie);
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe('jordan@example.com');
    } finally {
      delete process.env.SESSION_SECRET;
    }
  });
});

describe('what each person can see', () => {
  it('limits an analyst to their company', async () => {
    const agent = await signIn('maya@example.com');
    const list = (await agent.get('/api/deductions?pageSize=200')).body as DeductionListResponse;
    expect(list.total).toBeGreaterThan(0);
    expect(new Set(list.items.map((i) => i.companyId))).toEqual(new Set([1]));

    const other = get<{ id: number }>(db, "SELECT id FROM deductions WHERE company_id = 2 AND record_state = 'active' LIMIT 1")!;
    expect((await agent.get(`/api/deductions/${other.id}`)).status).toBe(404);
    expect((await agent.post(`/api/deductions/${other.id}/actions/start_review`).send({})).status).toBe(404);
    expect((await agent.get('/api/deductions?companyId=2')).status).toBe(403);
    expect((await agent.get('/api/dashboard?companyId=2')).status).toBe(403);
    expect((await agent.get('/api/deductions?view=unassigned')).status).toBe(400);
  });

  it('gives a multi-company analyst a combined view they can narrow', async () => {
    const agent = await signIn('sam@example.com');
    const me = (await agent.get('/api/me')).body;
    expect(me.companies.map((c: { slug: string }) => c.slug).sort()).toEqual(['cascade-snacks', 'harbor-vine', 'northfield-bev']);
    const all = (await agent.get('/api/deductions?pageSize=1')).body as DeductionListResponse;
    const cascade = (await agent.get('/api/deductions?pageSize=1&companyId=1')).body as DeductionListResponse;
    const northfield = (await agent.get('/api/deductions?pageSize=1&companyId=2')).body as DeductionListResponse;
    expect(all.total).toBe(cascade.total + northfield.total);
  });

  it('keeps orphaned deductions in an admin-only queue until assigned', async () => {
    const admin = await signIn('avery@example.com');
    const queue = (await admin.get('/api/deductions?view=unassigned&pageSize=200')).body as DeductionListResponse;
    expect(queue.total).toBe(34);

    const orphan = queue.items[0]!;
    const maya = await signIn('maya@example.com');
    expect((await maya.get(`/api/deductions/${orphan.id}`)).status).toBe(404);

    const res = await admin.post(`/api/deductions/${orphan.id}/company`).send({ companyId: 1, note: 'Cascade invoice series' });
    expect(res.status).toBe(200);
    expect((res.body as DeductionDetail).companyId).toBe(1);
    expect((await maya.get(`/api/deductions/${orphan.id}`)).status).toBe(200);
    expect((await maya.post(`/api/deductions/${orphan.id}/company`).send({ companyId: 2 })).status).toBe(403);
  });
});

describe('moving a deduction through the workflow over HTTP', () => {
  it('returns the updated record and the next legal moves', async () => {
    const agent = await signIn('maya@example.com');
    const target = get<{ id: number }>(
      db,
      "SELECT id FROM deductions WHERE company_id = 1 AND status = 'new' AND record_state = 'active' AND amount_flag = 'ok' AND amount_cents > 0 AND retailer_id IS NOT NULL LIMIT 1",
    )!;

    let res = await agent.post(`/api/deductions/${target.id}/actions/open_dispute`).send({});
    expect(res.status).toBe(200);
    let detail = res.body as DeductionDetail;
    expect(detail.disputeDetail?.stage).toBe('preparing');
    expect(detail.disputeDetail?.availableActions).toEqual(['submit', 'withdraw']);

    res = await agent.post(`/api/deductions/${target.id}/dispute/record_payment`).send({ amountCents: 1, receivedOn: TODAY, method: 'check' });
    expect(res.status).toBe(409);

    res = await agent.post(`/api/deductions/${target.id}/dispute/submit`).send({ submittedOn: TODAY, claimReference: 'KR-1' });
    detail = res.body as DeductionDetail;
    expect(detail.disputeDetail).toMatchObject({ stage: 'submitted', claimReference: 'KR-1' });
    expect(detail.activity[0]!.actor?.name).toBe('Maya Patel');
  });

  it('applies bulk actions row by row', async () => {
    const agent = await signIn('maya@example.com');
    const ids = (
      (await agent.get('/api/deductions?stage=new&pageSize=3')).body as DeductionListResponse
    ).items.map((i) => i.id);
    const other = get<{ id: number }>(db, "SELECT id FROM deductions WHERE company_id = 2 AND status = 'new' AND record_state = 'active' LIMIT 1")!;
    const res = await agent.post('/api/deductions/bulk').send({ ids: [...ids, other.id], action: 'start_review' });
    expect(res.body.ok).toEqual(ids);
    expect(res.body.failed).toEqual([{ id: other.id, error: 'Deduction not found.' }]);
  });
});
