import { beforeEach, describe, expect, it } from 'vitest';
import { get, type DB } from '../src/db/connection';
import { DomainError } from '../src/domain/context';
import { getDashboard } from '../src/domain/metrics';
import { getDeductionDetail } from '../src/domain/queries';
import { applyDeductionAction, applyDisputeAction, editDeduction, verifyIssue } from '../src/domain/workflow';
import { actor, cascadeScope, freshDb, TODAY } from './helpers';

let db: DB;
beforeEach(() => {
  db = freshDb();
});

/** A clean, disputable Cascade deduction that is still untouched. */
function pickNewDeduction(extra = ''): { id: number; amount: number } {
  const row = get<{ id: number; amount_cents: number }>(
    db,
    `SELECT id, amount_cents FROM deductions
     WHERE record_state = 'active' AND company_id = 1 AND status = 'new' AND amount_flag = 'ok'
       AND amount_cents > 10000 AND retailer_id IS NOT NULL ${extra}
     ORDER BY id LIMIT 1`,
  )!;
  return { id: row.id, amount: row.amount_cents };
}

const expectError = (fn: () => void, status: number, message?: RegExp) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(status);
    if (message) expect((err as DomainError).message).toMatch(message);
    return;
  }
  throw new Error('expected an error');
};

describe('dispute lifecycle', () => {
  it('tracks a partial approval paid in two installments', () => {
    const maya = actor(db, 'maya@example.com');
    const scope = cascadeScope(db);
    const { id, amount } = pickNewDeduction();

    applyDeductionAction(db, maya, scope, id, 'start_review', {});
    applyDeductionAction(db, maya, scope, id, 'open_dispute', { note: 'POD shows full delivery' });
    applyDisputeAction(db, maya, scope, id, 'submit', { submittedOn: '2026-09-01', claimReference: 'KR-1001' });

    const approved = Math.round(amount * 0.6);
    applyDisputeAction(db, maya, scope, id, 'record_decision', { decision: 'partial', approvedCents: approved, decidedOn: '2026-09-20' });

    const first = Math.round(approved / 2);
    applyDisputeAction(db, maya, scope, id, 'record_payment', { amountCents: first, receivedOn: '2026-10-01', method: 'check' });
    let detail = getDeductionDetail(db, scope, id, TODAY);
    expect(detail.disputeDetail).toMatchObject({ stage: 'approved', recoveredCents: first, outstandingCents: approved - first });

    // Can't record more than is still owed on the approval
    expectError(
      () => applyDisputeAction(db, maya, scope, id, 'record_payment', { amountCents: approved, receivedOn: '2026-10-02', method: 'check' }),
      400,
      /still outstanding/,
    );

    applyDisputeAction(db, maya, scope, id, 'record_payment', { amountCents: approved - first, receivedOn: '2026-10-05', method: 'offset' });
    detail = getDeductionDetail(db, scope, id, TODAY);
    expect(detail.status).toBe('closed');
    expect(detail.resolution).toBe('partially_recovered');
    expect(detail.disputeDetail).toMatchObject({ stage: 'closed', recoveredCents: approved, writtenOffCents: amount - approved });
    expect(detail.activity.map((a) => a.summary)).toEqual(expect.arrayContaining([expect.stringMatching(/^Closed: recovered/)]));
  });

  it('counts only cash received as recovered', () => {
    const maya = actor(db, 'maya@example.com');
    const scope = cascadeScope(db);
    const { id, amount } = pickNewDeduction();
    const before = getDashboard(db, scope, TODAY).kpis.recovered.cents;

    applyDeductionAction(db, maya, scope, id, 'open_dispute', {});
    applyDisputeAction(db, maya, scope, id, 'submit', { submittedOn: '2026-09-01' });
    applyDisputeAction(db, maya, scope, id, 'record_decision', { decision: 'approved', decidedOn: '2026-09-10' });

    let kpis = getDashboard(db, scope, TODAY).kpis;
    expect(kpis.recovered.cents).toBe(before); // approved is not recovered
    expect(kpis.outstanding.cents).toBeGreaterThanOrEqual(amount);

    applyDisputeAction(db, maya, scope, id, 'record_payment', { amountCents: amount, receivedOn: '2026-10-01', method: 'credit_memo' });
    kpis = getDashboard(db, scope, TODAY).kpis;
    expect(kpis.recovered.cents).toBe(before + amount);
    expect(kpis.recoveryRate).toBe(1);
  });

  it('lets a denied dispute be appealed and won', () => {
    const maya = actor(db, 'maya@example.com');
    const scope = cascadeScope(db);
    const { id, amount } = pickNewDeduction();

    applyDeductionAction(db, maya, scope, id, 'open_dispute', {});
    applyDisputeAction(db, maya, scope, id, 'submit', { submittedOn: '2026-08-01' });
    expectError(() => applyDisputeAction(db, maya, scope, id, 'record_decision', { decision: 'denied', decidedOn: '2026-08-20' }), 400, /reason/);
    applyDisputeAction(db, maya, scope, id, 'record_decision', { decision: 'denied', decidedOn: '2026-08-20', note: 'POD dispute' });
    applyDisputeAction(db, maya, scope, id, 'appeal', { note: 'Attached carrier photos' });

    let detail = getDeductionDetail(db, scope, id, TODAY);
    expect(detail.disputeDetail).toMatchObject({ stage: 'preparing', appealCount: 1, approvedCents: null });

    applyDisputeAction(db, maya, scope, id, 'submit', { submittedOn: '2026-08-25' });
    applyDisputeAction(db, maya, scope, id, 'record_decision', { decision: 'approved', decidedOn: '2026-09-15' });
    applyDisputeAction(db, maya, scope, id, 'record_payment', { amountCents: amount, receivedOn: '2026-10-01', method: 'ach' });
    detail = getDeductionDetail(db, scope, id, TODAY);
    expect(detail.resolution).toBe('recovered');
  });

  it('rejects moves that are not legal from the current stage', () => {
    const maya = actor(db, 'maya@example.com');
    const scope = cascadeScope(db);
    const { id } = pickNewDeduction();

    expectError(() => applyDisputeAction(db, maya, scope, id, 'submit', { submittedOn: '2026-09-01' }), 409, /not being disputed/);
    applyDeductionAction(db, maya, scope, id, 'open_dispute', {});
    expectError(() => applyDeductionAction(db, maya, scope, id, 'accept', { note: 'valid' }), 409);
    expectError(
      () => applyDisputeAction(db, maya, scope, id, 'record_payment', { amountCents: 100, receivedOn: '2026-09-01', method: 'check' }),
      409,
      /preparing/,
    );
    expectError(() => applyDisputeAction(db, maya, scope, id, 'submit', { submittedOn: '2030-01-01' }), 400, /future/);
  });

  it('requires a reason to accept a deduction, and allows reopening it', () => {
    const maya = actor(db, 'maya@example.com');
    const scope = cascadeScope(db);
    const { id } = pickNewDeduction();

    expectError(() => applyDeductionAction(db, maya, scope, id, 'accept', {}), 400);
    applyDeductionAction(db, maya, scope, id, 'accept', { note: 'Promo agreed in the Q2 plan' });
    expect(getDeductionDetail(db, scope, id, TODAY)).toMatchObject({ status: 'closed', resolution: 'accepted', availableActions: ['reopen'] });
    applyDeductionAction(db, maya, scope, id, 'reopen', {});
    expect(getDeductionDetail(db, scope, id, TODAY).status).toBe('in_review');
  });

  it('withdrawn disputes stay out of the recovery rate', () => {
    const maya = actor(db, 'maya@example.com');
    const scope = cascadeScope(db);
    const { id } = pickNewDeduction();
    applyDeductionAction(db, maya, scope, id, 'open_dispute', {});
    applyDisputeAction(db, maya, scope, id, 'withdraw', { note: 'Ops found the shortage was real' });
    const detail = getDeductionDetail(db, scope, id, TODAY);
    expect(detail.resolution).toBe('withdrawn');
    expect(getDashboard(db, scope, TODAY).kpis.recoveryRate).toBeNull();
  });
});

describe('data problems block disputes until fixed', () => {
  it('needs an amount before a dispute can be opened', () => {
    const maya = actor(db, 'maya@example.com');
    const scope = cascadeScope(db);
    const row = get<{ id: number }>(
      db,
      "SELECT id FROM deductions WHERE record_state = 'active' AND company_id = 1 AND amount_flag = 'missing' AND status = 'new' AND retailer_id IS NOT NULL LIMIT 1",
    )!;

    expectError(() => applyDeductionAction(db, maya, scope, row.id, 'open_dispute', {}), 409, /amount/);
    editDeduction(db, maya, scope, row.id, { amountCents: 12345, note: 'From the remittance PDF' });
    const detail = getDeductionDetail(db, scope, row.id, TODAY);
    expect(detail.amountFlag).toBe('ok');
    expect(detail.issues.find((i) => i.code === 'AMOUNT_MISSING')?.resolvedAt).not.toBeNull();
    applyDeductionAction(db, maya, scope, row.id, 'open_dispute', {});
  });

  it('lets an analyst confirm a suspicious amount', () => {
    const avery = actor(db, 'avery@example.com');
    const scope = { ...cascadeScope(db), userId: avery.userId! };
    const issue = get<{ id: number; deduction_id: number }>(
      db,
      "SELECT i.id, i.deduction_id FROM deduction_issues i JOIN deductions d ON d.id = i.deduction_id WHERE i.code = 'AMOUNT_SUSPECT' AND d.company_id = 1 AND d.record_state = 'active' LIMIT 1",
    )!;
    verifyIssue(db, avery, scope, issue.deduction_id, issue.id, { note: 'Confirmed with the retailer' });
    expect(getDeductionDetail(db, scope, issue.deduction_id, TODAY).amountFlag).toBe('ok');
  });
});

describe('scope', () => {
  it("can't touch another company's deduction", () => {
    const maya = actor(db, 'maya@example.com');
    const northfield = get<{ id: number }>(db, "SELECT id FROM deductions WHERE company_id = 2 AND record_state = 'active' LIMIT 1")!;
    expectError(() => applyDeductionAction(db, maya, cascadeScope(db), northfield.id, 'start_review', {}), 404);
    expectError(() => getDeductionDetail(db, cascadeScope(db), northfield.id, TODAY), 404);
  });
});
