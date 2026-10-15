/**
 * Recovery metrics. Definitions (also shown in the UI):
 *
 *   Claimed    what we asked the retailer to pay back (open + settled disputes, minus withdrawn)
 *   Approved   what the retailer agreed to pay back
 *   Recovered  cash actually received: the sum of recorded payments. Nothing else counts.
 *   Outstanding approved but not yet received
 *   Recovery rate   recovered / claimed, on settled disputes only (withdrawn excluded),
 *                   so open disputes don't drag the rate down before they've had a chance.
 *
 * Amounts flagged missing/suspect are left out of every sum.
 */
import type { CountCents, DashboardResponse } from '../../../shared/api';
import { DISPUTE_STAGES, type DisputeOutcome, type DisputeStage } from '../../../shared/domain';
import { all, get, type DB } from '../db/connection';
import { daysBetween, scopeSql, type Scope } from './context';
import { RECOMMENDED_SQL } from './queries';

const OPEN = `('new', 'in_review', 'with_ops')`;
const VALID = `d.amount_flag = 'ok'`;

interface DisputeAgg {
  stage: DisputeStage;
  outcome: DisputeOutcome | null;
  claim_cents: number | null;
  approved_cents: number | null;
  submitted_on: string | null;
  retailer_id: number | null;
  recovered: number;
  last_payment: string | null;
}

const AGING = [
  { bucket: '0-30', label: '0–30 days', max: 30 },
  { bucket: '31-60', label: '31–60 days', max: 60 },
  { bucket: '61-90', label: '61–90 days', max: 90 },
  { bucket: '91-180', label: '91–180 days', max: 180 },
  { bucket: '180+', label: '180+ days', max: Infinity },
] as const;

function monthsEnding(today: string, count: number): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const months: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(date.toISOString().slice(0, 7));
  }
  return months;
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

export function getDashboard(db: DB, scope: Scope, today: string): DashboardResponse {
  const s = scopeSql(scope);
  const base = `d.record_state = 'active' AND ${s.sql}`;

  const currencies = all<{ currency: string; n: number }>(
    db,
    `SELECT d.currency, COUNT(*) AS n FROM deductions d WHERE ${base} GROUP BY d.currency ORDER BY n DESC`,
    s.params,
  );
  // With no deductions yet, fall back to the company's own currency (Harbor & Vine is CAD).
  const fallback =
    scope.companyIds.length === 1
      ? get<{ c: string }>(db, 'SELECT default_currency AS c FROM companies WHERE id = :id', { id: scope.companyIds[0]! })?.c
      : undefined;
  const currency = currencies[0]?.currency ?? fallback ?? 'USD';
  const where = `${base} AND d.currency = :currency`;
  const params = { ...s.params, currency };
  const count = (sql: string): CountCents => {
    const row = get<{ count: number; cents: number | null }>(db, sql, params)!;
    return { count: row.count, cents: row.cents ?? 0 };
  };

  // --------------------------------------------------------- deductions
  const open = count(
    `SELECT COUNT(*) AS count, SUM(CASE WHEN ${VALID} THEN d.amount_cents END) AS cents
     FROM deductions d WHERE ${where} AND d.status IN ${OPEN}`,
  );
  const opportunity = count(
    `SELECT COUNT(*) AS count, SUM(d.amount_cents) AS cents
     FROM deductions d LEFT JOIN reasons rs ON rs.code = d.reason_code
     WHERE ${where} AND ${RECOMMENDED_SQL}`,
  );
  const legacyClosed = count(
    `SELECT COUNT(*) AS count, SUM(CASE WHEN ${VALID} THEN d.amount_cents END) AS cents
     FROM deductions d WHERE ${where} AND d.resolution = 'legacy_unknown'`,
  );
  const deducted = count(`SELECT COUNT(*) AS count, SUM(d.amount_cents) AS cents FROM deductions d WHERE ${where} AND ${VALID}`);
  const disputable = count(
    `SELECT COUNT(*) AS count, SUM(d.amount_cents) AS cents
     FROM deductions d JOIN reasons rs ON rs.code = d.reason_code
     WHERE ${where} AND ${VALID} AND rs.typically_disputable = 1`,
  );
  const needsAttention = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM deductions d WHERE ${where} AND EXISTS (
       SELECT 1 FROM deduction_issues i WHERE i.deduction_id = d.id AND i.resolved_at IS NULL AND i.severity IN ('error', 'warning'))`,
    params,
  )!.n;
  const excluded = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM deductions d WHERE ${where} AND NOT (${VALID})`, params)!.n;

  // ----------------------------------------------------------- disputes
  const disputes = all<DisputeAgg>(
    db,
    `SELECT ds.stage, ds.outcome, ds.claim_cents, ds.approved_cents, ds.submitted_on, d.retailer_id,
            COALESCE((SELECT SUM(rc.amount_cents) FROM recoveries rc WHERE rc.dispute_id = ds.id), 0) AS recovered,
            (SELECT MAX(rc.received_on) FROM recoveries rc WHERE rc.dispute_id = ds.id) AS last_payment
     FROM disputes ds JOIN deductions d ON d.id = ds.deduction_id
     WHERE ${where}`,
    params,
  );
  const sum = (rows: DisputeAgg[], pick: (r: DisputeAgg) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
  const active = disputes.filter((r) => r.stage !== 'closed');
  const counted = disputes.filter((r) => r.outcome !== 'withdrawn');
  const settled = disputes.filter((r) => r.stage === 'closed' && r.outcome !== 'withdrawn');
  const approvedStage = disputes.filter((r) => r.stage === 'approved');
  const decided = disputes.filter((r) => r.approved_cents !== null);
  const paid = disputes.filter((r) => r.recovered > 0);
  const recoveredTotal = sum(disputes, (r) => r.recovered);

  const daysToRecover = settled
    .filter((r) => r.recovered > 0 && r.submitted_on && r.last_payment)
    .map((r) => daysBetween(r.submitted_on!, r.last_payment!));

  // ------------------------------------------------------------ retailers
  const retailerRows = all<{ retailer_id: number | null; name: string; deducted: number; open: number }>(
    db,
    `SELECT d.retailer_id, COALESCE(r.name, 'Unknown retailer') AS name,
            COALESCE(SUM(CASE WHEN ${VALID} THEN d.amount_cents END), 0) AS deducted,
            COALESCE(SUM(CASE WHEN ${VALID} AND d.status IN ${OPEN} THEN d.amount_cents END), 0) AS open
     FROM deductions d LEFT JOIN retailers r ON r.id = d.retailer_id
     WHERE ${where} GROUP BY d.retailer_id ORDER BY deducted DESC`,
    params,
  );
  const byRetailer = retailerRows.map((row) => {
    const mine = counted.filter((r) => r.retailer_id === row.retailer_id);
    const mineSettled = settled.filter((r) => r.retailer_id === row.retailer_id);
    return {
      retailerId: row.retailer_id,
      name: row.name,
      deductedCents: row.deducted,
      openCents: row.open,
      claimedCents: sum(mine, (r) => r.claim_cents ?? 0),
      approvedCents: sum(mine, (r) => r.approved_cents ?? 0),
      recoveredCents: sum(disputes.filter((r) => r.retailer_id === row.retailer_id), (r) => r.recovered),
      recoveryRate: ratio(sum(mineSettled, (r) => r.recovered), sum(mineSettled, (r) => r.claim_cents ?? 0)),
    };
  });

  // -------------------------------------------------------------- reasons
  const byReason = all<{ code: string | null; label: string; disputable: number | null; count: number; cents: number | null }>(
    db,
    `SELECT d.reason_code AS code, COALESCE(rs.label, 'Unclassified') AS label, rs.typically_disputable AS disputable,
            COUNT(*) AS count, SUM(CASE WHEN ${VALID} THEN d.amount_cents END) AS cents
     FROM deductions d LEFT JOIN reasons rs ON rs.code = d.reason_code
     WHERE ${where} AND d.status IN ${OPEN}
     GROUP BY d.reason_code ORDER BY cents DESC`,
    params,
  ).map((r) => ({ code: r.code, label: r.label, disputable: r.disputable === null ? null : r.disputable === 1, count: r.count, cents: r.cents ?? 0 }));

  // ---------------------------------------------------------------- aging
  const openRows = all<{ deducted_on: string | null; date_flag: string; cents: number | null }>(
    db,
    `SELECT d.deducted_on, d.date_flag, CASE WHEN ${VALID} THEN d.amount_cents END AS cents
     FROM deductions d WHERE ${where} AND d.status IN ${OPEN}`,
    params,
  );
  const aging = [...AGING.map((a) => ({ bucket: a.bucket, label: a.label, count: 0, cents: 0 })), { bucket: 'unknown', label: 'No usable date', count: 0, cents: 0 }];
  for (const row of openRows) {
    const usable = row.deducted_on && row.date_flag === 'ok' && row.deducted_on <= today;
    const days = usable ? daysBetween(row.deducted_on!, today) : null;
    const index = days === null ? aging.length - 1 : AGING.findIndex((a) => days <= a.max);
    aging[index]!.count++;
    aging[index]!.cents += row.cents ?? 0;
  }

  // -------------------------------------------------------------- monthly
  const months = monthsEnding(today, 12);
  const deductedByMonth = new Map(
    all<{ month: string; cents: number }>(
      db,
      `SELECT substr(d.deducted_on, 1, 7) AS month, SUM(d.amount_cents) AS cents
       FROM deductions d WHERE ${where} AND ${VALID} AND d.date_flag = 'ok' AND d.deducted_on >= :from
       GROUP BY month`,
      { ...params, from: `${months[0]}-01` },
    ).map((r) => [r.month, r.cents]),
  );
  const recoveredByMonth = new Map(
    all<{ month: string; cents: number }>(
      db,
      `SELECT substr(rc.received_on, 1, 7) AS month, SUM(rc.amount_cents) AS cents
       FROM recoveries rc JOIN disputes ds ON ds.id = rc.dispute_id JOIN deductions d ON d.id = ds.deduction_id
       WHERE ${where} AND rc.received_on >= :from GROUP BY month`,
      { ...params, from: `${months[0]}-01` },
    ).map((r) => [r.month, r.cents]),
  );

  const simulatedEvents = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM activity a JOIN deductions d ON d.id = a.deduction_id WHERE ${where} AND a.simulated = 1`,
    params,
  )!.n;

  return {
    currency,
    otherCurrencies: currencies.slice(1).map((c) => c.currency),
    kpis: {
      open,
      opportunity,
      inDispute: { count: active.length, cents: sum(active, (r) => r.claim_cents ?? 0) },
      outstanding: {
        count: approvedStage.length,
        cents: sum(approvedStage, (r) => Math.max(0, (r.approved_cents ?? 0) - r.recovered)),
      },
      recovered: { count: paid.length, cents: recoveredTotal },
      recoveryRate: ratio(sum(settled, (r) => r.recovered), sum(settled, (r) => r.claim_cents ?? 0)),
      winRate: ratio(decided.filter((r) => (r.approved_cents ?? 0) > 0).length, decided.length),
      avgDaysToRecover: daysToRecover.length ? Math.round(daysToRecover.reduce((a, b) => a + b, 0) / daysToRecover.length) : null,
      needsAttention,
      legacyClosed,
      excluded,
    },
    funnel: [
      { key: 'deducted', label: 'Deducted', ...deducted, hint: 'Everything retailers held back (valid amounts only).' },
      { key: 'disputable', label: 'Usually disputable', ...disputable, hint: 'Reason codes that are typically worth fighting.' },
      {
        key: 'claimed',
        label: 'Claimed',
        count: counted.length,
        cents: sum(counted, (r) => r.claim_cents ?? 0),
        hint: 'Disputes being prepared, filed, or settled (withdrawn excluded).',
      },
      {
        key: 'approved',
        label: 'Approved',
        count: disputes.filter((r) => (r.approved_cents ?? 0) > 0).length,
        cents: sum(disputes, (r) => r.approved_cents ?? 0),
        hint: 'What retailers agreed to pay back.',
      },
      { key: 'recovered', label: 'Recovered', count: paid.length, cents: recoveredTotal, hint: 'Cash actually received: checks, ACH, credit memos, remittance offsets.' },
    ],
    pipeline: DISPUTE_STAGES.map((stage) => {
      const rows = disputes.filter((r) => r.stage === stage);
      return {
        stage,
        count: rows.length,
        claimCents: sum(rows, (r) => r.claim_cents ?? 0),
        approvedCents: sum(rows, (r) => r.approved_cents ?? 0),
        recoveredCents: sum(rows, (r) => r.recovered),
      };
    }),
    byRetailer,
    byReason,
    aging,
    monthly: months.map((month) => ({
      month,
      deductedCents: deductedByMonth.get(month) ?? 0,
      recoveredCents: recoveredByMonth.get(month) ?? 0,
    })),
    simulatedEvents,
  };
}
