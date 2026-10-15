/**
 * Domain vocabulary shared by the API and the web app.
 *
 * A deduction is the fact ("Kroger short-paid invoice INV-123 by $X for a
 * shortage"). Triage decides what to do with it. If we decide to fight it, a
 * dispute is opened and moves through its own stages until it is closed.
 * Money only counts as recovered when a payment is actually recorded.
 */

// ---------------------------------------------------------------- deductions

export const DEDUCTION_STATUSES = ['new', 'in_review', 'with_ops', 'disputed', 'closed'] as const;
export type DeductionStatus = (typeof DEDUCTION_STATUSES)[number];

export const DEDUCTION_STATUS_LABELS: Record<DeductionStatus, string> = {
  new: 'New',
  in_review: 'In review',
  with_ops: 'With ops',
  disputed: 'Disputing',
  closed: 'Closed',
};

/** Why a closed deduction is closed. */
export const RESOLUTIONS = [
  'accepted',
  'recovered',
  'partially_recovered',
  'denied',
  'withdrawn',
  'written_off',
  'legacy_unknown',
] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  accepted: 'Accepted as valid',
  recovered: 'Recovered',
  partially_recovered: 'Partially recovered',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
  written_off: 'Written off',
  legacy_unknown: 'Closed (legacy, no outcome)',
};

export const DEDUCTION_ACTIONS = [
  'start_review',
  'send_to_ops',
  'ops_returned',
  'open_dispute',
  'accept',
  'reopen',
] as const;
export type DeductionAction = (typeof DEDUCTION_ACTIONS)[number];

export const DEDUCTION_ACTION_LABELS: Record<DeductionAction, string> = {
  start_review: 'Start review',
  send_to_ops: 'Send to ops',
  ops_returned: 'Back from ops',
  open_dispute: 'Open dispute',
  accept: 'Accept as valid',
  reopen: 'Reopen',
};

/** Triage transitions. `disputed` deductions are driven by their dispute. */
export const DEDUCTION_TRANSITIONS: Record<DeductionStatus, readonly DeductionAction[]> = {
  new: ['start_review', 'send_to_ops', 'open_dispute', 'accept'],
  in_review: ['send_to_ops', 'open_dispute', 'accept'],
  with_ops: ['ops_returned', 'open_dispute', 'accept'],
  disputed: [],
  closed: ['reopen'],
};

/** Closed deductions that can be reopened (nothing financial was recorded). */
export const REOPENABLE_RESOLUTIONS: readonly Resolution[] = ['accepted', 'legacy_unknown'];

// ------------------------------------------------------------------ disputes

export const DISPUTE_STAGES = ['preparing', 'submitted', 'approved', 'denied', 'closed'] as const;
export type DisputeStage = (typeof DISPUTE_STAGES)[number];

export const DISPUTE_STAGE_LABELS: Record<DisputeStage, string> = {
  preparing: 'Preparing',
  submitted: 'Submitted',
  approved: 'Approved',
  denied: 'Denied',
  closed: 'Closed',
};

export const DISPUTE_STAGE_DESCRIPTIONS: Record<DisputeStage, string> = {
  preparing: 'Gathering backup (POD, BOL, pricing agreement) before filing with the retailer.',
  submitted: 'Filed with the retailer. Waiting on their decision.',
  approved: 'Retailer agreed to pay back some or all of the claim. Waiting on the money.',
  denied: 'Retailer rejected the claim. Appeal it or close it out.',
  closed: 'Settled. Whatever was received is final; the rest is written off.',
};

export const DISPUTE_OUTCOMES = ['recovered', 'partially_recovered', 'denied', 'withdrawn', 'written_off'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export const DISPUTE_ACTIONS = ['submit', 'record_decision', 'record_payment', 'appeal', 'withdraw', 'close'] as const;
export type DisputeAction = (typeof DISPUTE_ACTIONS)[number];

export const DISPUTE_ACTION_LABELS: Record<DisputeAction, string> = {
  submit: 'Mark as submitted',
  record_decision: 'Record retailer decision',
  record_payment: 'Record payment',
  appeal: 'Appeal',
  withdraw: 'Withdraw dispute',
  close: 'Close dispute',
};

export const DISPUTE_TRANSITIONS: Record<DisputeStage, readonly DisputeAction[]> = {
  preparing: ['submit', 'withdraw'],
  submitted: ['record_decision', 'withdraw'],
  approved: ['record_payment', 'close'],
  denied: ['appeal', 'close'],
  closed: [],
};

export const DECISIONS = ['approved', 'partial', 'denied'] as const;
export type Decision = (typeof DECISIONS)[number];

export const PAYMENT_METHODS = ['check', 'ach', 'credit_memo', 'offset'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  check: 'Check',
  ach: 'ACH / wire',
  credit_memo: 'Credit memo',
  offset: 'Repaid on a remittance',
};

/** "Received $500 <phrase>" in the activity log. */
export const PAYMENT_METHOD_PHRASES: Record<PaymentMethod, string> = {
  check: 'by check',
  ach: 'by ACH',
  credit_memo: 'as a credit memo',
  offset: 'as a repayment on a remittance',
};

/** Which dispute action moves a card from one board column to another. */
export function actionForStageMove(from: DisputeStage, to: DisputeStage): DisputeAction | null {
  if (from === to) return null;
  if (from === 'preparing' && to === 'submitted') return 'submit';
  if (from === 'submitted' && (to === 'approved' || to === 'denied')) return 'record_decision';
  if (from === 'denied' && to === 'preparing') return 'appeal';
  if (to === 'closed') {
    if (from === 'preparing' || from === 'submitted') return 'withdraw';
    return 'close';
  }
  return null;
}

// -------------------------------------------------------------- data quality

export const ISSUE_SEVERITIES = ['error', 'warning', 'info'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const ISSUE_CODES = [
  'COMPANY_UNKNOWN',
  'AMOUNT_MISSING',
  'AMOUNT_SUSPECT',
  'AMOUNT_ZERO',
  'AMOUNT_CENTS',
  'AMOUNT_NEGATIVE',
  'DATE_MISSING',
  'DATE_FUTURE',
  'DATE_IMPLAUSIBLE',
  'RETAILER_MISSING',
  'RETAILER_UNMATCHED',
  'REASON_UNCLASSIFIED',
  'INVOICE_MISSING',
  'LOW_OCR_CONFIDENCE',
  'STATUS_INFERRED',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export const ISSUE_META: Record<IssueCode, { label: string; severity: IssueSeverity; field: string; fix: string }> = {
  COMPANY_UNKNOWN: {
    label: 'Unknown company',
    severity: 'error',
    field: 'company',
    fix: 'An admin assigns it to the right company. Until then only admins can see it.',
  },
  AMOUNT_MISSING: {
    label: 'Missing amount',
    severity: 'error',
    field: 'amount',
    fix: 'Enter the amount from the remittance. Excluded from totals until then.',
  },
  AMOUNT_SUSPECT: {
    label: 'Implausible amount',
    severity: 'error',
    field: 'amount',
    fix: 'Correct it or confirm it is real. Excluded from totals until then.',
  },
  AMOUNT_ZERO: {
    label: 'Zero amount',
    severity: 'warning',
    field: 'amount',
    fix: 'Nothing to recover unless the amount is wrong.',
  },
  AMOUNT_CENTS: {
    label: 'Amount read as cents',
    severity: 'warning',
    field: 'amount',
    fix: 'Whole-number amounts were exported in cents. Spot-check against the remittance.',
  },
  AMOUNT_NEGATIVE: {
    label: 'Negative amount',
    severity: 'info',
    field: 'amount',
    fix: 'Stored as a positive deduction; the source used a negative sign.',
  },
  DATE_MISSING: {
    label: 'Missing date',
    severity: 'warning',
    field: 'date',
    fix: 'Enter the deduction date so aging and dispute windows are accurate.',
  },
  DATE_FUTURE: {
    label: 'Date in the future',
    severity: 'warning',
    field: 'date',
    fix: 'Likely a typo. Correct it or confirm it.',
  },
  DATE_IMPLAUSIBLE: {
    label: 'Implausible date',
    severity: 'warning',
    field: 'date',
    fix: 'Date is far outside the export period. Correct it or confirm it.',
  },
  RETAILER_MISSING: {
    label: 'Missing retailer',
    severity: 'error',
    field: 'retailer',
    fix: 'Pick the retailer. A dispute cannot be filed without one.',
  },
  RETAILER_UNMATCHED: {
    label: 'Unrecognized retailer',
    severity: 'error',
    field: 'retailer',
    fix: 'Map it to a retailer from the canonical list.',
  },
  REASON_UNCLASSIFIED: {
    label: 'Unclassified reason',
    severity: 'warning',
    field: 'reason',
    fix: 'Pick a reason code so we know whether it is worth disputing.',
  },
  INVOICE_MISSING: {
    label: 'Missing invoice #',
    severity: 'warning',
    field: 'invoice',
    fix: 'Retailers usually require the invoice number on a claim.',
  },
  LOW_OCR_CONFIDENCE: {
    label: 'Low OCR confidence',
    severity: 'warning',
    field: 'source',
    fix: 'Extracted from a scanned document with low confidence. Verify against the original.',
  },
  STATUS_INFERRED: {
    label: 'Status inferred',
    severity: 'info',
    field: 'status',
    fix: 'The spreadsheet status was ambiguous; check the stage is right.',
  },
};

// ------------------------------------------------------------------- display

export type StatusTone = 'neutral' | 'blue' | 'amber' | 'violet' | 'green' | 'red' | 'muted';

export function statusDisplay(
  status: DeductionStatus,
  resolution: Resolution | null,
  stage: DisputeStage | null,
): { label: string; tone: StatusTone } {
  if (status === 'disputed' && stage) {
    const tone: StatusTone = stage === 'approved' ? 'green' : stage === 'denied' ? 'red' : 'violet';
    return { label: `Dispute · ${DISPUTE_STAGE_LABELS[stage]}`, tone };
  }
  if (status === 'closed') {
    const r = resolution ?? 'legacy_unknown';
    const tone: StatusTone =
      r === 'recovered' || r === 'partially_recovered' ? 'green' : r === 'denied' || r === 'written_off' ? 'red' : 'muted';
    return { label: RESOLUTION_LABELS[r], tone };
  }
  const tones: Record<DeductionStatus, StatusTone> = {
    new: 'blue',
    in_review: 'amber',
    with_ops: 'amber',
    disputed: 'violet',
    closed: 'muted',
  };
  return { label: DEDUCTION_STATUS_LABELS[status], tone: tones[status] };
}

/** Filters exposed in the deductions list ("Stage" dropdown). */
export const STAGE_FILTERS = [
  'open',
  'new',
  'in_review',
  'with_ops',
  'disputing',
  'preparing',
  'submitted',
  'approved',
  'denied',
  'closed',
] as const;
export type StageFilter = (typeof STAGE_FILTERS)[number];

export const STAGE_FILTER_LABELS: Record<StageFilter, string> = {
  open: 'All open (not yet decided)',
  new: 'New',
  in_review: 'In review',
  with_ops: 'With ops',
  disputing: 'All active disputes',
  preparing: 'Dispute · Preparing',
  submitted: 'Dispute · Submitted',
  approved: 'Dispute · Approved',
  denied: 'Dispute · Denied',
  closed: 'Closed',
};
