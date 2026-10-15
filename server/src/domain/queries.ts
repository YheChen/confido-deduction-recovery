import { z } from 'zod';
import type {
  ActivityEntry,
  BoardItem,
  BoardResponse,
  DeductionDetail,
  DeductionListItem,
  DeductionListResponse,
  DisputeDetail,
  Issue,
  MetaResponse,
  RecoveryPayment,
  UserRef,
} from '../../../shared/api';
import { ISSUE_CODES, STAGE_FILTERS, type DisputeOutcome, type DisputeStage, type StageFilter } from '../../../shared/domain';
import { all, get, type DB, type Params } from '../db/connection';
import { daysBetween, initials, invalid, scopeSql, type Scope } from './context';
import {
  deductionActions,
  disputeActions,
  disputeBlockers,
  isVerifiable,
  loadDeduction,
  loadDispute,
  recoveredCents,
  type DeductionRow,
} from './workflow';

const OPEN_STATUSES = `('new', 'in_review', 'with_ops')`;

/** Open, valid, and usually worth disputing: the analyst's best opportunities. */
export const RECOMMENDED_SQL = `d.status IN ${OPEN_STATUSES} AND rs.typically_disputable = 1 AND d.amount_flag = 'ok'
  AND d.amount_cents > 0 AND d.retailer_id IS NOT NULL AND d.company_id IS NOT NULL`;

export const listFiltersSchema = z.object({
  companyId: z.coerce.number().int().optional(),
  stage: z.enum(STAGE_FILTERS).optional(),
  view: z.enum(['all', 'recommended', 'attention', 'mine', 'unassigned']).optional(),
  retailerId: z.union([z.coerce.number().int(), z.literal('none')]).optional(),
  reasonCode: z.string().optional(),
  assigneeId: z.union([z.coerce.number().int(), z.literal('none'), z.literal('me')]).optional(),
  issue: z.enum(ISSUE_CODES).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['id', 'amount', 'date', 'retailer', 'status', 'issues']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListFilters = z.infer<typeof listFiltersSchema>;

const STAGE_SQL: Record<StageFilter, string> = {
  open: `d.status IN ${OPEN_STATUSES}`,
  new: `d.status = 'new'`,
  in_review: `d.status = 'in_review'`,
  with_ops: `d.status = 'with_ops'`,
  disputing: `d.status = 'disputed'`,
  preparing: `d.status = 'disputed' AND ds.stage = 'preparing'`,
  submitted: `d.status = 'disputed' AND ds.stage = 'submitted'`,
  approved: `d.status = 'disputed' AND ds.stage = 'approved'`,
  denied: `d.status = 'disputed' AND ds.stage = 'denied'`,
  closed: `d.status = 'closed'`,
};

const SORT_SQL: Record<ListFilters['sort'], string> = {
  id: 'd.id',
  amount: "CASE WHEN d.amount_flag = 'ok' THEN d.amount_cents END",
  date: 'd.deducted_on',
  retailer: 'r.name',
  status: 'd.status',
  issues: 'open_errors * 100 + open_warnings',
};

const LIST_SELECT = `
  SELECT d.*, c.name AS company_name, r.name AS retailer_name, rs.label AS reason_label,
         rs.typically_disputable AS disputable, u.name AS assignee_name,
         ds.id AS dispute_id, ds.stage AS dispute_stage, ds.claim_cents, ds.approved_cents, ds.outcome AS dispute_outcome,
         ds.stage_entered_at, ds.claim_reference, ds.submitted_on, ds.closed_on, ds.appeal_count,
         COALESCE((SELECT SUM(rc.amount_cents) FROM recoveries rc WHERE rc.dispute_id = ds.id), 0) AS recovered_cents,
         (SELECT COUNT(*) FROM deduction_issues i WHERE i.deduction_id = d.id AND i.resolved_at IS NULL AND i.severity = 'error') AS open_errors,
         (SELECT COUNT(*) FROM deduction_issues i WHERE i.deduction_id = d.id AND i.resolved_at IS NULL AND i.severity = 'warning') AS open_warnings,
         (${RECOMMENDED_SQL}) AS recommended
  FROM deductions d
  LEFT JOIN companies c ON c.id = d.company_id
  LEFT JOIN retailers r ON r.id = d.retailer_id
  LEFT JOIN reasons rs ON rs.code = d.reason_code
  LEFT JOIN users u ON u.id = d.assignee_id
  LEFT JOIN disputes ds ON ds.deduction_id = d.id`;

type ListRow = DeductionRow & {
  company_name: string | null;
  retailer_name: string | null;
  reason_label: string | null;
  disputable: number | null;
  assignee_name: string | null;
  dispute_id: number | null;
  dispute_stage: DisputeStage;
  claim_cents: number | null;
  approved_cents: number | null;
  dispute_outcome: DisputeOutcome | null;
  recovered_cents: number;
  stage_entered_at: string | null;
  claim_reference: string | null;
  submitted_on: string | null;
  closed_on: string | null;
  appeal_count: number | null;
  open_errors: number;
  open_warnings: number;
  recommended: number;
};

function toListItem(row: ListRow, today: string): DeductionListItem {
  const ageDays =
    row.deducted_on && row.date_flag !== 'missing' && row.deducted_on <= today ? daysBetween(row.deducted_on, today) : null;
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    sourceCompanyRef: row.source_company_ref,
    retailerId: row.retailer_id,
    retailerName: row.retailer_name,
    retailerRaw: row.retailer_raw,
    reasonCode: row.reason_code,
    reasonLabel: row.reason_label,
    reasonRaw: row.reason_raw,
    disputable: row.disputable === null ? null : row.disputable === 1,
    invoiceNumber: row.invoice_number,
    amountCents: row.amount_cents,
    amountFlag: row.amount_flag,
    currency: row.currency,
    deductedOn: row.deducted_on,
    ageDays,
    status: row.status,
    resolution: row.resolution,
    dispute:
      row.dispute_id === null
        ? null
        : {
            id: row.dispute_id,
            stage: row.dispute_stage,
            claimCents: row.claim_cents ?? 0,
            approvedCents: row.approved_cents,
            recoveredCents: row.recovered_cents,
            outcome: row.dispute_outcome,
          },
    assignee: row.assignee_id === null ? null : { id: row.assignee_id, name: row.assignee_name!, initials: initials(row.assignee_name!) },
    openErrors: row.open_errors,
    openWarnings: row.open_warnings,
    note: row.source_note,
    recommended: row.recommended === 1,
  };
}

function buildWhere(scope: Scope, f: ListFilters): { sql: string; params: Params } {
  const clauses = ["d.record_state = 'active'"];
  const params: Params = {};

  if (f.view === 'unassigned') {
    if (!scope.canSeeUnassigned) throw invalid('Only admins can see unassigned deductions.');
    clauses.push('d.company_id IS NULL');
  } else {
    const s = scopeSql(scope);
    clauses.push(s.sql);
    Object.assign(params, s.params);
  }

  if (f.stage) clauses.push(STAGE_SQL[f.stage]);
  if (f.view === 'recommended') clauses.push(RECOMMENDED_SQL);
  if (f.view === 'attention') {
    clauses.push(
      "EXISTS (SELECT 1 FROM deduction_issues i WHERE i.deduction_id = d.id AND i.resolved_at IS NULL AND i.severity IN ('error', 'warning'))",
    );
  }
  if (f.view === 'mine') {
    clauses.push('d.assignee_id = :me');
    params.me = scope.userId;
  }
  if (f.issue) {
    clauses.push('EXISTS (SELECT 1 FROM deduction_issues i WHERE i.deduction_id = d.id AND i.resolved_at IS NULL AND i.code = :issue)');
    params.issue = f.issue;
  }
  if (f.retailerId === 'none') clauses.push('d.retailer_id IS NULL');
  else if (f.retailerId !== undefined) {
    clauses.push('d.retailer_id = :retailerId');
    params.retailerId = f.retailerId;
  }
  if (f.reasonCode === 'none') clauses.push('d.reason_code IS NULL');
  else if (f.reasonCode) {
    clauses.push('d.reason_code = :reasonCode');
    params.reasonCode = f.reasonCode;
  }
  if (f.assigneeId === 'none') clauses.push('d.assignee_id IS NULL');
  else if (f.assigneeId === 'me') {
    clauses.push('d.assignee_id = :me');
    params.me = scope.userId;
  } else if (f.assigneeId !== undefined) {
    clauses.push('d.assignee_id = :assigneeId');
    params.assigneeId = f.assigneeId;
  }
  if (f.q) {
    const digits = f.q.replace(/\D/g, '');
    const parts = ['d.invoice_number LIKE :q', 'd.invoice_raw LIKE :q', 'r.name LIKE :q', 'd.retailer_raw LIKE :q', 'd.reason_raw LIKE :q'];
    params.q = `%${f.q}%`;
    if (digits) {
      parts.push('CAST(d.id AS TEXT) = :digits', 'd.invoice_number LIKE :digitsLike');
      params.digits = digits;
      params.digitsLike = `%${digits}%`;
    }
    clauses.push(`(${parts.join(' OR ')})`);
  }
  return { sql: clauses.join(' AND '), params };
}

export function listDeductions(db: DB, scope: Scope, filters: ListFilters, today: string): DeductionListResponse {
  const where = buildWhere(scope, filters);
  const from = `FROM deductions d
    LEFT JOIN retailers r ON r.id = d.retailer_id
    LEFT JOIN reasons rs ON rs.code = d.reason_code
    LEFT JOIN disputes ds ON ds.deduction_id = d.id`;
  const totals = get<{ total: number; cents: number | null; currencies: string | null }>(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN d.amount_flag = 'ok' THEN d.amount_cents END) AS cents,
            GROUP_CONCAT(DISTINCT d.currency) AS currencies
     ${from} WHERE ${where.sql}`,
    where.params,
  )!;
  const direction = filters.order === 'asc' ? 'ASC' : 'DESC';
  const rows = all<ListRow>(
    db,
    `${LIST_SELECT}
     WHERE ${where.sql}
     ORDER BY ${SORT_SQL[filters.sort]} IS NULL, ${SORT_SQL[filters.sort]} ${direction},
              CASE WHEN d.amount_flag = 'ok' THEN d.amount_cents END DESC, d.id DESC
     LIMIT :limit OFFSET :offset`,
    { ...where.params, limit: filters.pageSize, offset: (filters.page - 1) * filters.pageSize },
  );
  return {
    items: rows.map((row) => toListItem(row, today)),
    total: totals.total,
    page: filters.page,
    pageSize: filters.pageSize,
    totalCents: totals.cents ?? 0,
    currency: totals.currencies?.split(',')[0] ?? 'USD',
  };
}

export function getDeductionDetail(db: DB, scope: Scope, id: number, today: string): DeductionDetail {
  const base = loadDeduction(db, scope, id); // 404s outside scope
  const row = get<ListRow>(db, `${LIST_SELECT} WHERE d.id = :id`, { id })!;
  const item = toListItem(row, today);
  const dispute = loadDispute(db, id);

  const issues = all<{
    id: number;
    code: Issue['code'];
    severity: Issue['severity'];
    field: string;
    message: string;
    raw_value: string | null;
    resolved_at: string | null;
    resolver: string | null;
    resolution_note: string | null;
  }>(
    db,
    `SELECT i.*, u.name AS resolver FROM deduction_issues i LEFT JOIN users u ON u.id = i.resolved_by
     WHERE i.deduction_id = :id
     ORDER BY i.resolved_at IS NOT NULL, CASE i.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, i.id`,
    { id },
  ).map(
    (i): Issue => ({
      id: i.id,
      code: i.code,
      severity: i.severity,
      field: i.field,
      message: i.message,
      rawValue: i.raw_value,
      resolvedAt: i.resolved_at,
      resolvedBy: i.resolver,
      resolutionNote: i.resolution_note,
      verifiable: isVerifiable(i.code),
    }),
  );

  const activity = all<{
    id: number;
    kind: string;
    summary: string;
    note: string | null;
    actor_id: number | null;
    actor_name: string | null;
    created_at: string;
    simulated: number;
  }>(
    db,
    `SELECT a.*, u.name AS actor_name FROM activity a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.deduction_id = :id ORDER BY a.created_at DESC, a.id DESC`,
    { id },
  ).map(
    (a): ActivityEntry => ({
      id: a.id,
      kind: a.kind,
      summary: a.summary,
      note: a.note,
      actor: a.actor_id === null ? null : { id: a.actor_id, name: a.actor_name!, initials: initials(a.actor_name!) },
      createdAt: a.created_at,
      simulated: a.simulated === 1,
    }),
  );

  let disputeDetail: DisputeDetail | null = null;
  if (dispute) {
    const recovered = recoveredCents(db, dispute.id);
    const recoveries = all<{
      id: number;
      amount_cents: number;
      received_on: string;
      method: RecoveryPayment['method'];
      reference: string | null;
      recorder: string | null;
    }>(
      db,
      `SELECT r.*, u.name AS recorder FROM recoveries r LEFT JOIN users u ON u.id = r.recorded_by
       WHERE r.dispute_id = :id ORDER BY r.received_on, r.id`,
      { id: dispute.id },
    );
    const claim = dispute.claim_cents ?? 0;
    disputeDetail = {
      id: dispute.id,
      stage: dispute.stage,
      claimCents: claim,
      approvedCents: dispute.approved_cents,
      recoveredCents: recovered,
      outcome: dispute.outcome,
      outstandingCents: dispute.stage === 'approved' ? Math.max(0, (dispute.approved_cents ?? 0) - recovered) : 0,
      writtenOffCents: dispute.stage === 'closed' && dispute.outcome !== 'withdrawn' ? Math.max(0, claim - recovered) : 0,
      claimReference: dispute.claim_reference,
      submittedOn: dispute.submitted_on,
      decidedOn: dispute.decided_on,
      closedOn: dispute.closed_on,
      appealCount: dispute.appeal_count,
      stageEnteredAt: dispute.stage_entered_at,
      legacyStageInferred: dispute.legacy_stage_inferred === 1,
      recoveries: recoveries.map((r) => ({
        id: r.id,
        amountCents: r.amount_cents,
        receivedOn: r.received_on,
        method: r.method,
        reference: r.reference,
        recordedBy: r.recorder,
      })),
      availableActions: disputeActions(base, dispute),
    };
  }

  const duplicates = all<{ id: number }>(db, 'SELECT id FROM deductions WHERE duplicate_of = :id ORDER BY id', { id }).map((r) => r.id);

  return {
    ...item,
    sourceStatus: base.source_status,
    amountRaw: base.amount_raw,
    deductedRaw: base.deducted_raw,
    invoiceRaw: base.invoice_raw,
    ocrConfidence: base.ocr_confidence,
    recordState: base.record_state,
    duplicateOf: base.duplicate_of,
    duplicates,
    raw: JSON.parse(base.raw_json),
    issues,
    disputeDetail,
    activity,
    availableActions: deductionActions(base),
    disputeBlockers: base.record_state !== 'active' || base.status === 'closed' ? [] : disputeBlockers(base),
    assignableUsers: base.company_id === null ? [] : assignableUsers(db, base.company_id),
    editable: { amount: base.record_state === 'active' && (!dispute || dispute.stage === 'preparing') },
  };
}

export function assignableUsers(db: DB, companyId: number): UserRef[] {
  return all<{ id: number; name: string }>(
    db,
    `SELECT u.id, u.name FROM users u
     WHERE u.role = 'admin' OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.company_id = :company)
     ORDER BY u.role = 'admin', u.name`,
    { company: companyId },
  ).map((u) => ({ id: u.id, name: u.name, initials: initials(u.name) }));
}

export function getMeta(db: DB, scope: Scope): MetaResponse {
  const placeholders = scope.companyIds.map((_, i) => `:c${i}`).join(', ') || 'NULL';
  const companyParams = Object.fromEntries(scope.companyIds.map((id, i) => [`c${i}`, id]));
  return {
    retailers: all<{ id: number; name: string; type: string; region: string }>(db, 'SELECT * FROM retailers ORDER BY name'),
    reasons: all<{ code: string; label: string; category: string; typically_disputable: number }>(
      db,
      'SELECT * FROM reasons ORDER BY typically_disputable DESC, label',
    ).map((r) => ({ code: r.code, label: r.label, category: r.category, typicallyDisputable: r.typically_disputable === 1 })),
    users: all<{ id: number; name: string }>(
      db,
      `SELECT DISTINCT u.id, u.name FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       WHERE u.role = 'admin' OR m.company_id IN (${placeholders})
       ORDER BY u.name`,
      companyParams,
    ).map((u) => ({ id: u.id, name: u.name, initials: initials(u.name) })),
  };
}

/** Every dispute in scope, shaped for the board. */
export function listDisputes(db: DB, scope: Scope, today: string): BoardResponse {
  const s = scopeSql(scope);
  const rows = all<ListRow>(
    db,
    `${LIST_SELECT}
     WHERE d.record_state = 'active' AND ${s.sql} AND ds.id IS NOT NULL
     ORDER BY ds.stage_entered_at DESC, d.id DESC`,
    s.params,
  );
  const items = rows.map((row): BoardItem => {
    const item = toListItem(row, today);
    return {
      ...item,
      dispute: item.dispute!,
      stageEnteredAt: row.stage_entered_at!,
      daysInStage: Math.max(0, daysBetween(row.stage_entered_at!.slice(0, 10), today)),
      claimReference: row.claim_reference,
      submittedOn: row.submitted_on,
      closedOn: row.closed_on,
      appealCount: row.appeal_count ?? 0,
    };
  });
  return { items, currency: items[0]?.currency ?? 'USD' };
}
