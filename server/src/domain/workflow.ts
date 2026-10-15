/**
 * Every state change goes through this module. Each function:
 *   1. loads the record through the caller's scope (404 if they cannot see it),
 *   2. checks the move is allowed from the current state (409 otherwise),
 *   3. validates the payload the new state needs (400 otherwise),
 *   4. writes the change and an activity row in one transaction.
 */
import { z } from 'zod';
import {
  DECISIONS,
  DEDUCTION_ACTION_LABELS,
  DEDUCTION_TRANSITIONS,
  DISPUTE_ACTION_LABELS,
  DISPUTE_STAGE_LABELS,
  DISPUTE_TRANSITIONS,
  ISSUE_META,
  PAYMENT_METHODS,
  PAYMENT_METHOD_PHRASES,
  REOPENABLE_RESOLUTIONS,
  statusDisplay,
  type DeductionAction,
  type DeductionStatus,
  type DisputeAction,
  type DisputeOutcome,
  type DisputeStage,
  type IssueCode,
  type Resolution,
} from '../../../shared/domain';
import type { BulkResult } from '../../../shared/api';
import { all, get, run, transaction, type DB } from '../db/connection';
import { normalizeInvoice } from '../import/normalize';
import { conflict, DomainError, invalid, money, notFound, scopeSql, type Actor, type Scope } from './context';

export interface DeductionRow {
  id: number;
  company_id: number | null;
  source_company_ref: string | null;
  retailer_id: number | null;
  retailer_raw: string | null;
  reason_code: string | null;
  reason_raw: string | null;
  invoice_number: string | null;
  invoice_raw: string | null;
  amount_cents: number | null;
  amount_flag: 'ok' | 'missing' | 'suspect';
  amount_raw: string | null;
  currency: string;
  deducted_on: string | null;
  date_flag: 'ok' | 'missing' | 'suspect';
  deducted_raw: string | null;
  status: DeductionStatus;
  resolution: Resolution | null;
  source_status: string | null;
  record_state: 'active' | 'deleted' | 'duplicate' | 'empty';
  duplicate_of: number | null;
  assignee_id: number | null;
  source_note: string | null;
  ocr_confidence: number | null;
  raw_json: string;
}

export interface DisputeRow {
  id: number;
  deduction_id: number;
  stage: DisputeStage;
  claim_cents: number | null;
  approved_cents: number | null;
  claim_reference: string | null;
  submitted_on: string | null;
  decided_on: string | null;
  closed_on: string | null;
  outcome: DisputeOutcome | null;
  appeal_count: number;
  stage_entered_at: string;
  legacy_stage_inferred: number;
}

// ------------------------------------------------------------------ loading

/** Any record the scope can see, whatever its record_state (read-only views use this). */
export function loadDeduction(db: DB, scope: Scope, id: number): DeductionRow {
  const s = scopeSql(scope, 'd', { includeUnassigned: true });
  const row = get<DeductionRow>(db, `SELECT d.* FROM deductions d WHERE d.id = :id AND ${s.sql}`, { id, ...s.params });
  if (!row) throw notFound();
  return row;
}

function loadActive(db: DB, scope: Scope, id: number): DeductionRow {
  const row = loadDeduction(db, scope, id);
  if (row.record_state !== 'active') {
    throw conflict(`Deduction #${id} is ${row.record_state === 'deleted' ? 'deleted in the source' : `a ${row.record_state} record`} and is read-only.`);
  }
  return row;
}

export function loadDispute(db: DB, deductionId: number): DisputeRow | undefined {
  return get<DisputeRow>(db, 'SELECT * FROM disputes WHERE deduction_id = :id', { id: deductionId });
}

export function recoveredCents(db: DB, disputeId: number): number {
  return get<{ total: number }>(db, 'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM recoveries WHERE dispute_id = :id', {
    id: disputeId,
  })!.total;
}

function retailerName(db: DB, d: DeductionRow): string {
  if (d.retailer_id === null) return 'the retailer';
  return get<{ name: string }>(db, 'SELECT name FROM retailers WHERE id = :id', { id: d.retailer_id })?.name ?? 'the retailer';
}

// ------------------------------------------------------------- what's legal

export function deductionActions(d: DeductionRow): DeductionAction[] {
  if (d.record_state !== 'active') return [];
  if (d.status === 'closed') return d.resolution && REOPENABLE_RESOLUTIONS.includes(d.resolution) ? ['reopen'] : [];
  return [...DEDUCTION_TRANSITIONS[d.status]];
}

export function disputeActions(d: DeductionRow, dispute: DisputeRow | undefined): DisputeAction[] {
  if (!dispute || d.record_state !== 'active') return [];
  return [...DISPUTE_TRANSITIONS[dispute.stage]];
}

/** Reasons a deduction cannot be disputed yet. Empty means it can. */
export function disputeBlockers(d: Pick<DeductionRow, 'company_id' | 'amount_flag' | 'amount_cents' | 'retailer_id'>): string[] {
  const blockers: string[] = [];
  if (d.company_id === null) blockers.push('Assign it to a company first.');
  if (d.amount_flag === 'missing') blockers.push('Enter the deduction amount first.');
  else if (d.amount_flag === 'suspect') blockers.push('Correct or confirm the amount first.');
  else if (!d.amount_cents) blockers.push('The amount is $0, so there is nothing to dispute.');
  if (d.retailer_id === null) blockers.push('Pick the retailer first.');
  return blockers;
}

function describe(d: DeductionRow, dispute?: DisputeRow): string {
  return statusDisplay(d.status, d.resolution, dispute?.stage ?? null).label;
}

// ------------------------------------------------------------------ payloads

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must look like YYYY-MM-DD.');
const positiveCents = z.number().int('Amounts must be whole cents.').positive('Amounts must be more than $0.');
const note = z.string().trim().max(2000, 'Notes are limited to 2,000 characters.');
const optionalNote = note.optional().transform((v) => (v ? v : null));
const requiredNote = (message: string) => note.min(3, message);
const shortText = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v ? v : null));

export const deductionActionSchemas = {
  start_review: z.object({ note: optionalNote }),
  send_to_ops: z.object({ note: optionalNote }),
  ops_returned: z.object({ note: optionalNote }),
  accept: z.object({ note: requiredNote('Say why the deduction is valid (e.g. "Promo agreed in Q2 plan").') }),
  reopen: z.object({ note: optionalNote }),
  open_dispute: z.object({ claimCents: positiveCents.optional(), note: optionalNote }),
} satisfies Record<DeductionAction, z.ZodType>;

export const disputeActionSchemas = {
  submit: z.object({ submittedOn: isoDate, claimReference: shortText, claimCents: positiveCents.optional(), note: optionalNote }),
  record_decision: z.object({
    decision: z.enum(DECISIONS),
    approvedCents: positiveCents.optional(),
    decidedOn: isoDate,
    note: optionalNote,
  }),
  record_payment: z.object({
    amountCents: positiveCents,
    receivedOn: isoDate,
    method: z.enum(PAYMENT_METHODS),
    reference: shortText,
    note: optionalNote,
  }),
  appeal: z.object({ note: requiredNote('Say what is different about the appeal (new backup, escalation contact…).') }),
  withdraw: z.object({ note: requiredNote('Say why the dispute is being dropped.') }),
  close: z.object({ note: optionalNote }),
} satisfies Record<DisputeAction, z.ZodType>;

function parse<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
  const result = schema.safeParse(payload ?? {});
  if (!result.success) throw invalid(result.error.issues.map((i) => i.message).join(' '));
  return result.data;
}

function notInFuture(date: string, actor: Actor, label: string): void {
  if (date > actor.today) throw invalid(`${label} cannot be in the future.`);
}

// ------------------------------------------------------------------ writing

function log(
  db: DB,
  actor: Actor,
  deductionId: number,
  kind: string,
  summary: string,
  note: string | null = null,
  detail?: Record<string, unknown>,
): void {
  run(
    db,
    `INSERT INTO activity (deduction_id, actor_id, kind, summary, note, detail_json, simulated, created_at)
     VALUES (:id, :actor, :kind, :summary, :note, :detail, :simulated, :now)`,
    {
      id: deductionId,
      actor: actor.userId,
      kind,
      summary,
      note,
      detail: detail ? JSON.stringify(detail) : null,
      simulated: actor.simulated ?? false,
      now: actor.now,
    },
  );
}

function setStatus(db: DB, actor: Actor, id: number, status: DeductionStatus, resolution: Resolution | null = null): void {
  run(db, 'UPDATE deductions SET status = :status, resolution = :resolution, updated_at = :now WHERE id = :id', {
    id,
    status,
    resolution,
    now: actor.now,
  });
}

function updateDispute(db: DB, actor: Actor, id: number, fields: Partial<Omit<DisputeRow, 'id' | 'deduction_id'>>): void {
  const entries = Object.entries(fields);
  const sets = entries.map(([key]) => `${key} = :${key}`);
  if ('stage' in fields) sets.push('stage_entered_at = :now');
  sets.push('updated_at = :now');
  run(db, `UPDATE disputes SET ${sets.join(', ')} WHERE id = :id`, { ...Object.fromEntries(entries), id, now: actor.now });
}

function resolveIssues(db: DB, actor: Actor, deductionId: number, codes: IssueCode[], resolution: string): void {
  if (codes.length === 0) return;
  const placeholders = codes.map((_, i) => `:c${i}`).join(', ');
  run(
    db,
    `UPDATE deduction_issues SET resolved_at = :now, resolved_by = :actor, resolution_note = :resolution
     WHERE deduction_id = :id AND resolved_at IS NULL AND code IN (${placeholders})`,
    { id: deductionId, now: actor.now, actor: actor.userId, resolution, ...Object.fromEntries(codes.map((c, i) => [`c${i}`, c])) },
  );
}

// ------------------------------------------------------------ triage moves

export function applyDeductionAction(
  db: DB,
  actor: Actor,
  scope: Scope,
  id: number,
  action: DeductionAction,
  payload: unknown,
): void {
  transaction(db, () => {
    const d = loadActive(db, scope, id);
    if (!deductionActions(d).includes(action)) {
      throw conflict(`Can't "${DEDUCTION_ACTION_LABELS[action]}" a deduction that is ${describe(d, loadDispute(db, id)).toLowerCase()}.`);
    }

    switch (action) {
      case 'start_review': {
        const p = parse(deductionActionSchemas.start_review, payload);
        setStatus(db, actor, id, 'in_review');
        log(db, actor, id, 'status', 'Started review', p.note);
        break;
      }
      case 'send_to_ops': {
        const p = parse(deductionActionSchemas.send_to_ops, payload);
        setStatus(db, actor, id, 'with_ops');
        log(db, actor, id, 'status', 'Sent to ops for backup (POD / BOL / receiving records)', p.note);
        break;
      }
      case 'ops_returned': {
        const p = parse(deductionActionSchemas.ops_returned, payload);
        setStatus(db, actor, id, 'in_review');
        log(db, actor, id, 'status', 'Back from ops', p.note);
        break;
      }
      case 'accept': {
        const p = parse(deductionActionSchemas.accept, payload);
        setStatus(db, actor, id, 'closed', 'accepted');
        log(db, actor, id, 'status', 'Accepted as valid. No dispute.', p.note);
        break;
      }
      case 'reopen': {
        const p = parse(deductionActionSchemas.reopen, payload);
        setStatus(db, actor, id, 'in_review');
        log(db, actor, id, 'status', 'Reopened for review', p.note);
        break;
      }
      case 'open_dispute': {
        const p = parse(deductionActionSchemas.open_dispute, payload);
        const blockers = disputeBlockers(d);
        if (blockers.length) throw conflict(blockers.join(' '));
        const amount = d.amount_cents!;
        const claim = p.claimCents ?? amount;
        if (claim > amount) throw invalid(`The claim can't be more than the deduction (${money(amount)}).`);
        run(
          db,
          `INSERT INTO disputes (deduction_id, stage, claim_cents, stage_entered_at, created_at, updated_at)
           VALUES (:id, 'preparing', :claim, :now, :now, :now)`,
          { id, claim, now: actor.now },
        );
        setStatus(db, actor, id, 'disputed');
        log(
          db,
          actor,
          id,
          'dispute',
          claim === amount ? `Opened a dispute for the full ${money(claim)}` : `Opened a dispute for ${money(claim)} of ${money(amount)}`,
          p.note,
        );
        break;
      }
    }
  });
}

// -------------------------------------------------------------- dispute moves

export function applyDisputeAction(
  db: DB,
  actor: Actor,
  scope: Scope,
  deductionId: number,
  action: DisputeAction,
  payload: unknown,
): void {
  transaction(db, () => {
    const d = loadActive(db, scope, deductionId);
    const dispute = loadDispute(db, deductionId);
    if (!dispute) throw conflict('This deduction is not being disputed.');
    if (!DISPUTE_TRANSITIONS[dispute.stage].includes(action)) {
      throw conflict(`Can't "${DISPUTE_ACTION_LABELS[action]}" while the dispute is ${DISPUTE_STAGE_LABELS[dispute.stage].toLowerCase()}.`);
    }
    const recovered = recoveredCents(db, dispute.id);

    switch (action) {
      case 'submit': {
        const p = parse(disputeActionSchemas.submit, payload);
        const blockers = disputeBlockers(d);
        if (blockers.length) throw conflict(`Before filing: ${blockers.join(' ')}`);
        notInFuture(p.submittedOn, actor, 'The submitted date');
        const claim = p.claimCents ?? dispute.claim_cents;
        if (!claim) throw invalid('Enter the claim amount.');
        if (d.amount_cents !== null && d.amount_flag === 'ok' && claim > d.amount_cents) {
          throw invalid(`The claim can't be more than the deduction (${money(d.amount_cents)}).`);
        }
        updateDispute(db, actor, dispute.id, {
          stage: 'submitted',
          submitted_on: p.submittedOn,
          claim_cents: claim,
          claim_reference: p.claimReference ?? dispute.claim_reference,
        });
        const ref = p.claimReference ?? dispute.claim_reference;
        log(db, actor, deductionId, 'dispute', `Submitted to ${retailerName(db, d)} for ${money(claim)}${ref ? ` (claim ${ref})` : ''}`, p.note);
        break;
      }

      case 'record_decision': {
        const p = parse(disputeActionSchemas.record_decision, payload);
        notInFuture(p.decidedOn, actor, 'The decision date');
        if (dispute.submitted_on && p.decidedOn < dispute.submitted_on) {
          throw invalid(`The decision date is before the claim was submitted (${dispute.submitted_on}).`);
        }
        const claim = dispute.claim_cents;
        if (!claim) throw invalid('This dispute has no claim amount yet. Fix the deduction amount first.');
        if (p.decision === 'denied') {
          if (!p.note) throw invalid('Add the reason the retailer gave for denying the claim.');
          updateDispute(db, actor, dispute.id, { stage: 'denied', approved_cents: 0, decided_on: p.decidedOn });
          log(db, actor, deductionId, 'dispute', `${retailerName(db, d)} denied the claim`, p.note);
          break;
        }
        const approved = p.decision === 'approved' ? claim : p.approvedCents;
        if (!approved) throw invalid('Enter how much the retailer approved.');
        if (approved > claim) throw invalid(`The approved amount can't exceed the claim (${money(claim)}).`);
        if (p.decision === 'partial' && approved === claim) throw invalid('That is the full claim. Choose "Approved in full" instead.');
        updateDispute(db, actor, dispute.id, { stage: 'approved', approved_cents: approved, decided_on: p.decidedOn });
        log(
          db,
          actor,
          deductionId,
          'dispute',
          approved === claim
            ? `${retailerName(db, d)} approved the full ${money(claim)}`
            : `${retailerName(db, d)} approved ${money(approved)} of the ${money(claim)} claim`,
          p.note,
        );
        break;
      }

      case 'record_payment': {
        const p = parse(disputeActionSchemas.record_payment, payload);
        notInFuture(p.receivedOn, actor, 'The received date');
        const approved = dispute.approved_cents ?? 0;
        const remaining = approved - recovered;
        if (p.amountCents > remaining) {
          throw invalid(`Only ${money(remaining)} of the ${money(approved)} approval is still outstanding.`);
        }
        run(
          db,
          `INSERT INTO recoveries (dispute_id, amount_cents, received_on, method, reference, recorded_by, created_at)
           VALUES (:dispute, :amount, :received, :method, :reference, :actor, :now)`,
          {
            dispute: dispute.id,
            amount: p.amountCents,
            received: p.receivedOn,
            method: p.method,
            reference: p.reference,
            actor: actor.userId,
            now: actor.now,
          },
        );
        log(
          db,
          actor,
          deductionId,
          'payment',
          `Received ${money(p.amountCents)} ${PAYMENT_METHOD_PHRASES[p.method]}${p.reference ? ` (${p.reference})` : ''}`,
          p.note,
        );
        const total = recovered + p.amountCents;
        if (total === approved) closeDispute(db, actor, d, dispute, total, p.receivedOn, null);
        break;
      }

      case 'close': {
        const p = parse(disputeActionSchemas.close, payload);
        if (dispute.stage === 'approved') {
          const remaining = (dispute.approved_cents ?? 0) - recovered;
          if (remaining > 0 && !p.note) {
            throw invalid(`Say why the remaining ${money(remaining)} is being written off.`);
          }
        }
        closeDispute(db, actor, d, dispute, recovered, actor.today, p.note);
        break;
      }

      case 'appeal': {
        const p = parse(disputeActionSchemas.appeal, payload);
        updateDispute(db, actor, dispute.id, {
          stage: 'preparing',
          appeal_count: dispute.appeal_count + 1,
          approved_cents: null,
          decided_on: null,
        });
        log(db, actor, deductionId, 'dispute', `Appealed the denial (appeal #${dispute.appeal_count + 1})`, p.note);
        break;
      }

      case 'withdraw': {
        const p = parse(disputeActionSchemas.withdraw, payload);
        closeDispute(db, actor, d, dispute, recovered, actor.today, p.note, 'withdrawn');
        break;
      }
    }
  });
}

/**
 * Settles a dispute. The outcome is derived from money actually received, so
 * "recovered" can never mean "approved but not yet paid".
 */
function closeDispute(
  db: DB,
  actor: Actor,
  d: DeductionRow,
  dispute: DisputeRow,
  recovered: number,
  closedOn: string,
  note: string | null,
  forced?: DisputeOutcome,
): void {
  const claim = dispute.claim_cents ?? 0;
  const outcome: DisputeOutcome =
    forced ??
    (recovered === 0
      ? dispute.stage === 'denied'
        ? 'denied'
        : 'written_off'
      : recovered >= claim
        ? 'recovered'
        : 'partially_recovered');

  updateDispute(db, actor, dispute.id, { stage: 'closed', outcome, closed_on: closedOn });
  setStatus(db, actor, d.id, 'closed', outcome);

  const summaries: Record<DisputeOutcome, string> = {
    recovered: `Closed: recovered the full ${money(recovered)}`,
    partially_recovered: `Closed: recovered ${money(recovered)} of ${money(claim)}, wrote off ${money(claim - recovered)}`,
    written_off: `Closed: nothing received, wrote off ${money(claim)}`,
    denied: `Closed as denied. Wrote off ${money(claim)}`,
    withdrawn: recovered > 0 ? `Withdrew the dispute after recovering ${money(recovered)}` : 'Withdrew the dispute',
  };
  log(db, actor, d.id, 'dispute', summaries[outcome], note);
}

// ---------------------------------------------------------------- edits

export const editSchema = z
  .object({
    retailerId: z.number().int().optional(),
    reasonCode: z.string().optional(),
    invoiceNumber: z.string().trim().max(60).optional(),
    amountCents: positiveCents.optional(),
    deductedOn: isoDate.optional(),
    note: optionalNote,
  })
  .refine((p) => Object.entries(p).some(([key, value]) => key !== 'note' && value !== undefined), 'Nothing to change.');

/** Corrections to the cleaned values. Each one closes the issues it fixes. */
export function editDeduction(db: DB, actor: Actor, scope: Scope, id: number, payload: unknown): void {
  transaction(db, () => {
    const d = loadActive(db, scope, id);
    const p = parse(editSchema, payload);
    const changes: string[] = [];
    const resolved = (what: string) => `Corrected by hand (${what}).`;

    if (p.retailerId !== undefined && p.retailerId !== d.retailer_id) {
      const retailer = get<{ name: string }>(db, 'SELECT name FROM retailers WHERE id = :id', { id: p.retailerId });
      if (!retailer) throw invalid('Unknown retailer.');
      run(db, 'UPDATE deductions SET retailer_id = :value, updated_at = :now WHERE id = :id', { id, value: p.retailerId, now: actor.now });
      resolveIssues(db, actor, id, ['RETAILER_MISSING', 'RETAILER_UNMATCHED'], resolved(`retailer set to ${retailer.name}`));
      changes.push(`retailer to ${retailer.name}`);
    }

    if (p.reasonCode !== undefined && p.reasonCode !== d.reason_code) {
      const reason = get<{ label: string }>(db, 'SELECT label FROM reasons WHERE code = :code', { code: p.reasonCode });
      if (!reason) throw invalid('Unknown reason code.');
      run(db, 'UPDATE deductions SET reason_code = :value, updated_at = :now WHERE id = :id', { id, value: p.reasonCode, now: actor.now });
      resolveIssues(db, actor, id, ['REASON_UNCLASSIFIED'], resolved(`reason set to ${reason.label}`));
      changes.push(`reason to ${reason.label}`);
    }

    if (p.invoiceNumber !== undefined) {
      const invoice = normalizeInvoice(p.invoiceNumber).value;
      if (!invoice) throw invalid('Enter an invoice number.');
      if (invoice !== d.invoice_number) {
        run(db, 'UPDATE deductions SET invoice_number = :value, updated_at = :now WHERE id = :id', { id, value: invoice, now: actor.now });
        resolveIssues(db, actor, id, ['INVOICE_MISSING'], resolved(`invoice set to ${invoice}`));
        changes.push(`invoice # to ${invoice}`);
      }
    }

    if (p.amountCents !== undefined && (p.amountCents !== d.amount_cents || d.amount_flag !== 'ok')) {
      const dispute = loadDispute(db, id);
      if (dispute && dispute.stage !== 'preparing') {
        throw conflict("The amount can't change once the claim has been submitted to the retailer.");
      }
      run(db, "UPDATE deductions SET amount_cents = :value, amount_flag = 'ok', updated_at = :now WHERE id = :id", {
        id,
        value: p.amountCents,
        now: actor.now,
      });
      if (dispute && (dispute.claim_cents === null || dispute.claim_cents === d.amount_cents || dispute.claim_cents > p.amountCents)) {
        updateDispute(db, actor, dispute.id, { claim_cents: p.amountCents });
      }
      resolveIssues(
        db,
        actor,
        id,
        ['AMOUNT_MISSING', 'AMOUNT_SUSPECT', 'AMOUNT_ZERO', 'AMOUNT_CENTS', 'AMOUNT_NEGATIVE'],
        resolved(`amount set to ${money(p.amountCents)}`),
      );
      changes.push(d.amount_cents === null ? `amount to ${money(p.amountCents)}` : `amount from ${money(d.amount_cents)} to ${money(p.amountCents)}`);
    }

    if (p.deductedOn !== undefined && (p.deductedOn !== d.deducted_on || d.date_flag !== 'ok')) {
      notInFuture(p.deductedOn, actor, 'The deduction date');
      run(db, "UPDATE deductions SET deducted_on = :value, date_flag = 'ok', updated_at = :now WHERE id = :id", {
        id,
        value: p.deductedOn,
        now: actor.now,
      });
      resolveIssues(db, actor, id, ['DATE_MISSING', 'DATE_FUTURE', 'DATE_IMPLAUSIBLE'], resolved(`date set to ${p.deductedOn}`));
      changes.push(`date to ${p.deductedOn}`);
    }

    if (changes.length === 0) return;
    log(db, actor, id, 'edit', `Corrected ${changes.join(', ')}`, p.note);
  });
}

/** Issues that can be signed off without changing the value. */
const VERIFIABLE: IssueCode[] = [
  'AMOUNT_SUSPECT',
  'AMOUNT_CENTS',
  'AMOUNT_NEGATIVE',
  'AMOUNT_ZERO',
  'DATE_MISSING',
  'DATE_FUTURE',
  'DATE_IMPLAUSIBLE',
  'INVOICE_MISSING',
  'LOW_OCR_CONFIDENCE',
  'STATUS_INFERRED',
];

export function isVerifiable(code: IssueCode): boolean {
  return VERIFIABLE.includes(code);
}

export function verifyIssue(db: DB, actor: Actor, scope: Scope, deductionId: number, issueId: number, payload: unknown): void {
  transaction(db, () => {
    const d = loadActive(db, scope, deductionId);
    const p = parse(z.object({ note: optionalNote }), payload);
    const issue = get<{ id: number; code: IssueCode }>(
      db,
      'SELECT id, code FROM deduction_issues WHERE id = :issueId AND deduction_id = :id AND resolved_at IS NULL',
      { issueId, id: d.id },
    );
    if (!issue) throw notFound('Open issue');
    if (!isVerifiable(issue.code)) throw conflict(ISSUE_META[issue.code].fix);

    run(
      db,
      `UPDATE deduction_issues SET resolved_at = :now, resolved_by = :actor, resolution_note = :note WHERE id = :issueId`,
      { issueId, now: actor.now, actor: actor.userId, note: p.note ?? 'Checked and confirmed.' },
    );
    if (issue.code === 'AMOUNT_SUSPECT' && d.amount_cents !== null) {
      run(db, "UPDATE deductions SET amount_flag = 'ok', updated_at = :now WHERE id = :id", { id: d.id, now: actor.now });
      const dispute = loadDispute(db, d.id);
      if (dispute && dispute.claim_cents === null) updateDispute(db, actor, dispute.id, { claim_cents: d.amount_cents });
    }
    if ((issue.code === 'DATE_FUTURE' || issue.code === 'DATE_IMPLAUSIBLE') && d.deducted_on) {
      run(db, "UPDATE deductions SET date_flag = 'ok', updated_at = :now WHERE id = :id", { id: d.id, now: actor.now });
    }
    log(db, actor, d.id, 'issue', `Verified: ${ISSUE_META[issue.code].label.toLowerCase()}`, p.note);
  });
}

// ------------------------------------------------------- ownership & notes

export function assignDeduction(db: DB, actor: Actor, scope: Scope, id: number, assigneeId: number | null): void {
  transaction(db, () => {
    const d = loadActive(db, scope, id);
    if (assigneeId === d.assignee_id) return;
    let name = '';
    if (assigneeId !== null) {
      const user = get<{ name: string; role: string; member: number }>(
        db,
        `SELECT u.name, u.role,
                EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.company_id = :company) AS member
         FROM users u WHERE u.id = :user`,
        { user: assigneeId, company: d.company_id },
      );
      if (!user) throw invalid('Unknown user.');
      if (user.role !== 'admin' && !user.member) throw invalid(`${user.name} doesn't have access to this company.`);
      name = user.name;
    }
    run(db, 'UPDATE deductions SET assignee_id = :assignee, updated_at = :now WHERE id = :id', { id, assignee: assigneeId, now: actor.now });
    const summary = assigneeId === null ? 'Unassigned' : assigneeId === actor.userId ? 'Took ownership' : `Assigned to ${name}`;
    log(db, actor, id, 'assign', summary);
  });
}

export function addComment(db: DB, actor: Actor, scope: Scope, id: number, payload: unknown): void {
  const p = parse(z.object({ body: note.min(1, 'Write something first.') }), payload);
  loadDeduction(db, scope, id);
  log(db, actor, id, 'comment', 'Commented', p.body);
}

/** Admin-only: give an orphaned deduction (company 0 / 3 / null in the export) a home. */
export function assignCompany(db: DB, actor: Actor, scope: Scope, id: number, payload: unknown): void {
  if (scope.role !== 'admin') throw new DomainError(403, 'Only admins can assign deductions to a company.');
  const p = parse(z.object({ companyId: z.number().int(), note: optionalNote }), payload);
  transaction(db, () => {
    const d = loadActive(db, scope, id);
    if (d.company_id !== null) throw conflict('This deduction already belongs to a company.');
    const company = get<{ name: string; default_currency: string }>(db, 'SELECT name, default_currency FROM companies WHERE id = :id', {
      id: p.companyId,
    });
    if (!company) throw invalid('Unknown company.');
    const explicitCurrency = d.amount_raw !== null && /^[A-Za-z]{3}\s/.test(d.amount_raw.trim());
    run(db, 'UPDATE deductions SET company_id = :company, currency = :currency, updated_at = :now WHERE id = :id', {
      id,
      company: p.companyId,
      currency: explicitCurrency ? d.currency : company.default_currency,
      now: actor.now,
    });
    resolveIssues(db, actor, id, ['COMPANY_UNKNOWN'], `Assigned to ${company.name}.`);
    log(
      db,
      actor,
      id,
      'edit',
      `Assigned to ${company.name} (export said company_id ${d.source_company_ref ?? 'missing'})`,
      p.note,
    );
  });
}

// --------------------------------------------------------------------- bulk

export type BulkAction = DeductionAction | 'assign';

export function bulkApply(db: DB, actor: Actor, scope: Scope, ids: number[], action: BulkAction, payload: unknown): BulkResult {
  const result: BulkResult = { ok: [], failed: [] };
  for (const id of ids) {
    try {
      if (action === 'assign') {
        const p = parse(z.object({ assigneeId: z.number().int().nullable() }), payload);
        assignDeduction(db, actor, scope, id, p.assigneeId);
      } else {
        applyDeductionAction(db, actor, scope, id, action, payload);
      }
      result.ok.push(id);
    } catch (err) {
      result.failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Ids of active deductions in scope; used by tests and the demo seeder. */
export function activeIds(db: DB, scope: Scope, where = '1 = 1'): number[] {
  const s = scopeSql(scope);
  return all<{ id: number }>(db, `SELECT d.id FROM deductions d WHERE d.record_state = 'active' AND ${s.sql} AND ${where} ORDER BY d.id`, s.params).map(
    (r) => r.id,
  );
}
