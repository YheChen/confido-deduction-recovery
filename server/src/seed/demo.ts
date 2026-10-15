/**
 * Optional demo history. The export is a snapshot with no dispute outcomes or
 * payments, so on its own every recovery chart is empty. This replays ~4
 * months of plausible analyst work *through the same workflow functions the
 * API uses* (so every rule is enforced), with a fixed random seed.
 *
 * Every row it writes is marked simulated = 1 and shown with a "Simulated"
 * badge in the activity timeline. `npm run db:reset -- --no-demo` skips it.
 */
import { DISPUTE_STAGES, type PaymentMethod } from '../../../shared/domain';
import { all, run, transaction, type DB } from '../db/connection';
import type { Actor, Scope } from '../domain/context';
import { applyDeductionAction, applyDisputeAction, assignDeduction, disputeBlockers, loadDispute, recoveredCents } from '../domain/workflow';

/**
 * Left exactly as imported so a live demo always starts from the same examples:
 *   1734  $11,868.53 pricing deduction whose retailer is "n/a" (blocked until fixed)
 *   1298  $7,120.05 KeHE pricing dispute still being prepared
 *   1134  $1,328.13 KeHE freight dispute already filed ("K e H E" in the export)
 */
export const RESERVED_FOR_LIVE_DEMO = new Set<number>([1734, 1298, 1134]);

export interface SimulationSummary {
  windowStart: string;
  assigned: number;
  reviewed: number;
  accepted: number;
  sentToOps: number;
  opened: number;
  submitted: number;
  decided: number;
  payments: number;
  closed: number;
  appealed: number;
}

interface Candidate {
  id: number;
  company_id: number;
  retailer_id: number | null;
  retailer: string | null;
  amount_cents: number | null;
  amount_flag: 'ok' | 'missing' | 'suspect';
  deducted_on: string | null;
  date_flag: string;
  status: string;
  disputable: number | null;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CLAIM_PREFIX: Record<string, string> = {
  Kroger: 'KR',
  Target: 'TGT',
  Walmart: 'WM',
  Amazon: 'AMZ',
  KeHE: 'KEHE',
  UNFI: 'UNFI',
  'Dot Foods': 'DOT',
  'Gordon Food Service': 'GFS',
  'WinCo Foods': 'WC',
  Loblaw: 'LOB',
  "BJ's Wholesale Club": 'BJ',
  'H-E-B': 'HEB',
  CVS: 'CVS',
  'Ahold Delhaize': 'AD',
};

const ACCEPT_NOTES = [
  'Matches the promo agreed in the Q2 trade plan.',
  'Within the 2% unsaleables allowance in the vendor agreement.',
  'Bill-back matches the signed MCB agreement.',
  'Retailer backup checks out; deduction is valid.',
  'Too small to be worth a claim after fees.',
];
const OPS_NOTES = [
  'Need POD and signed BOL from the 3PL.',
  'Asked warehouse to confirm pallet count shipped.',
  'Need the pricing sheet that was in effect on the ship date.',
];
const DENIAL_NOTES = [
  'Retailer says signed POD shows a clean delivery.',
  'Denied: filed outside the retailer’s dispute window.',
  'Retailer says the price matched the deal sheet on file.',
  'Retailer says the compliance fine follows their routing guide.',
];
const APPEAL_NOTES = [
  'Re-filed with the carrier’s delivery photos attached.',
  'Escalated to the category manager with the signed BOL.',
  'Found the price-protection email from the buyer; re-filing.',
];

export function simulateActivity(db: DB, opts: { today: string; seed?: number; days?: number }): SimulationSummary {
  const rand = mulberry32(opts.seed ?? 20261014);
  const chance = (p: number) => rand() < p;
  const between = (lo: number, hi: number) => Math.floor(lo + rand() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

  const lastDay = addDays(opts.today, -1);
  const windowStart = addDays(opts.today, -(opts.days ?? 120));
  const summary: SimulationSummary = {
    windowStart,
    assigned: 0,
    reviewed: 0,
    accepted: 0,
    sentToOps: 0,
    opened: 0,
    submitted: 0,
    decided: 0,
    payments: 0,
    closed: 0,
    appealed: 0,
  };

  const companyIds = all<{ id: number }>(db, 'SELECT id FROM companies').map((c) => c.id);
  const scope: Scope = { userId: 0, role: 'admin', companyIds, canSeeUnassigned: true };
  const analysts = new Map<number, number[]>();
  for (const m of all<{ user_id: number; company_id: number }>(
    db,
    "SELECT m.user_id, m.company_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.role = 'analyst' ORDER BY m.user_id",
  )) {
    analysts.set(m.company_id, [...(analysts.get(m.company_id) ?? []), m.user_id]);
  }

  const actorAt = (userId: number, date: string): Actor => {
    const hour = String(between(13, 21)).padStart(2, '0');
    const minute = String(between(0, 59)).padStart(2, '0');
    return { userId, now: `${date}T${hour}:${minute}:00.000Z`, today: date, simulated: true };
  };

  const candidates = all<Candidate>(
    db,
    `SELECT d.id, d.company_id, d.retailer_id, r.name AS retailer, d.amount_cents, d.amount_flag, d.deducted_on, d.date_flag,
            d.status, rs.typically_disputable AS disputable
     FROM deductions d
     LEFT JOIN retailers r ON r.id = d.retailer_id
     LEFT JOIN reasons rs ON rs.code = d.reason_code
     WHERE d.record_state = 'active' AND d.company_id IS NOT NULL
     ORDER BY d.id`,
  );

  transaction(db, () => {
    // The export arrives as a feed: each deduction "lands" on its date (or at
    // the start of the window). Import rows and untouched legacy disputes are
    // re-stamped so every timeline reads in order.
    const arrival = new Map<number, string>();
    for (const c of candidates) {
      const usable = c.deducted_on && c.date_flag === 'ok' && c.deducted_on <= lastDay;
      const day = usable && c.deducted_on! > windowStart ? c.deducted_on! : windowStart;
      arrival.set(c.id, day);
      run(db, "UPDATE activity SET created_at = :at WHERE deduction_id = :id AND kind = 'import'", { id: c.id, at: `${day}T11:00:00.000Z` });
      run(db, 'UPDATE disputes SET stage_entered_at = :at WHERE deduction_id = :id', { id: c.id, at: `${day}T11:00:00.000Z` });
    }
    for (const id of all<{ id: number }>(db, 'SELECT id FROM deductions WHERE company_id IS NULL').map((r) => r.id)) {
      run(db, "UPDATE activity SET created_at = :at WHERE deduction_id = :id AND kind = 'import'", { id, at: `${windowStart}T11:00:00.000Z` });
    }

    for (const c of candidates) {
      if (RESERVED_FOR_LIVE_DEMO.has(c.id) || c.status === 'closed') continue;
      const team = analysts.get(c.company_id);
      if (!team?.length) continue;
      let day = arrival.get(c.id)!;
      const owner = team.length > 1 && chance(0.3) ? team[team.length - 1]! : team[0]!;
      const step = (lo: number, hi: number): boolean => {
        const next = addDays(day, between(lo, hi));
        if (next > lastDay) return false;
        day = next;
        return true;
      };

      // Ownership
      if (chance(0.75) && step(0, 2)) {
        assignDeduction(db, actorAt(owner, day), scope, c.id, owner);
        summary.assigned++;
      }

      // Triage
      let status = c.status;
      if (status === 'with_ops') {
        if (!(chance(0.55) && step(3, 15))) continue;
        applyDeductionAction(db, actorAt(owner, day), scope, c.id, 'ops_returned', { note: 'Ops sent the signed BOL and POD.' });
        status = 'in_review';
      }
      if (status === 'new') {
        if (!(chance(0.5) && step(1, 10))) continue;
        applyDeductionAction(db, actorAt(owner, day), scope, c.id, 'start_review', {});
        summary.reviewed++;
        status = 'in_review';
      }
      if (status === 'in_review') {
        const canDispute = disputeBlockers(c).length === 0;
        if (canDispute && c.disputable === 1 && chance(0.6) && step(1, 6)) {
          applyDeductionAction(db, actorAt(owner, day), scope, c.id, 'open_dispute', {});
          summary.opened++;
          status = 'disputed';
        } else if (c.disputable !== 1 && chance(0.4) && step(1, 8)) {
          applyDeductionAction(db, actorAt(owner, day), scope, c.id, 'accept', { note: pick(ACCEPT_NOTES) });
          summary.accepted++;
          continue;
        } else if (chance(0.15) && step(1, 4)) {
          applyDeductionAction(db, actorAt(owner, day), scope, c.id, 'send_to_ops', { note: pick(OPS_NOTES) });
          summary.sentToOps++;
          continue;
        } else {
          continue;
        }
      }
      if (status !== 'disputed') continue;

      // Dispute lifecycle (legacy disputes with bad data wait for a human)
      if (disputeBlockers(c).length) continue;
      for (let round = 0; round < 2; round++) {
        let dispute = loadDispute(db, c.id);
        if (!dispute || dispute.claim_cents === null) break;

        if (dispute.stage === 'preparing') {
          if (!(chance(round === 0 ? 0.7 : 0.9) && step(3, 14))) break;
          const prefix = CLAIM_PREFIX[c.retailer ?? ''] ?? 'CLM';
          applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'submit', {
            submittedOn: day,
            claimReference: `${prefix}-${between(10000, 99999)}`,
          });
          summary.submitted++;
          dispute = loadDispute(db, c.id)!;
        }

        if (dispute.stage === 'submitted') {
          if (!(chance(0.75) && step(14, 55))) break;
          const roll = rand();
          const claim = dispute.claim_cents!;
          if (roll < (round === 0 ? 0.5 : 0.35)) {
            applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'record_decision', { decision: 'approved', decidedOn: day });
          } else if (roll < (round === 0 ? 0.75 : 0.6) && claim >= 200) {
            const approvedCents = Math.max(1, Math.round((claim * between(40, 90)) / 100));
            applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'record_decision', {
              decision: approvedCents >= claim ? 'approved' : 'partial',
              approvedCents: approvedCents >= claim ? undefined : approvedCents,
              decidedOn: day,
              note: 'Retailer accepted part of the shortage based on the receiving log.',
            });
          } else {
            applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'record_decision', {
              decision: 'denied',
              decidedOn: day,
              note: pick(DENIAL_NOTES),
            });
          }
          summary.decided++;
          dispute = loadDispute(db, c.id)!;
        }

        if (dispute.stage === 'approved') {
          if (!(chance(0.85) && step(7, 40))) break;
          const approved = dispute.approved_cents!;
          const method = pick<PaymentMethod>(['offset', 'offset', 'check', 'check', 'credit_memo', 'credit_memo', 'ach']);
          const reference = paymentReference(method, day, between);
          if (chance(0.75) || approved < 200) {
            applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'record_payment', {
              amountCents: approved,
              receivedOn: day,
              method,
              reference,
            });
            summary.payments++;
            summary.closed++;
          } else {
            const partial = Math.round((approved * between(40, 80)) / 100);
            applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'record_payment', {
              amountCents: partial,
              receivedOn: day,
              method,
              reference,
            });
            summary.payments++;
            const rest = approved - recoveredCents(db, dispute.id);
            if (chance(0.5) && step(10, 30)) {
              applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'record_payment', {
                amountCents: rest,
                receivedOn: day,
                method: 'offset',
                reference: paymentReference('offset', day, between),
              });
              summary.payments++;
              summary.closed++;
            } else if (chance(0.5) && step(10, 30)) {
              applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'close', {
                note: 'Retailer will not pay the rest of the approval; not worth chasing further.',
              });
              summary.closed++;
            }
          }
          break;
        }

        if (dispute.stage === 'denied') {
          if (round === 0 && chance(0.35) && step(3, 10)) {
            applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'appeal', { note: pick(APPEAL_NOTES) });
            summary.appealed++;
            continue; // second round: resubmit and decide again
          }
          if (chance(0.6) && step(2, 7)) {
            applyDisputeAction(db, actorAt(owner, day), scope, c.id, 'close', { note: 'Not enough backup to keep fighting it.' });
            summary.closed++;
          }
          break;
        }
        break;
      }
    }
  });

  // Sanity check: the simulation must never leave a dispute in an unknown stage.
  const stages = all<{ stage: string }>(db, 'SELECT DISTINCT stage FROM disputes').map((r) => r.stage);
  for (const stage of stages) if (!DISPUTE_STAGES.includes(stage as never)) throw new Error(`Unexpected stage ${stage}`);
  return summary;
}

function paymentReference(method: PaymentMethod, day: string, between: (lo: number, hi: number) => number): string {
  switch (method) {
    case 'check':
      return `Check #${between(100000, 999999)}`;
    case 'ach':
      return `ACH ${between(10000000, 99999999)}`;
    case 'credit_memo':
      return `CM-${between(10000, 99999)}`;
    case 'offset':
      return `Remittance ${day}`;
  }
}
