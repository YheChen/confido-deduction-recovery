/** JSON shapes returned by the API. Money is always integer cents. */
import type {
  DeductionAction,
  DeductionStatus,
  DisputeAction,
  DisputeOutcome,
  DisputeStage,
  IssueCode,
  IssueSeverity,
  PaymentMethod,
  Resolution,
} from './domain';

export type Role = 'admin' | 'analyst';
export type AmountFlag = 'ok' | 'missing' | 'suspect';
export type RecordState = 'active' | 'deleted' | 'duplicate' | 'empty';

export interface CompanyRef {
  id: number;
  name: string;
  slug: string;
  currency: string;
  erpSystem: string | null;
  isActive: boolean;
}

export interface RetailerRef {
  id: number;
  name: string;
  type: string;
  region: string;
}

export interface ReasonRef {
  code: string;
  label: string;
  category: string;
  typicallyDisputable: boolean;
}

export interface UserRef {
  id: number;
  name: string;
  initials: string;
}

export interface SessionUser extends UserRef {
  email: string;
  title: string | null;
  role: Role;
}

export interface SessionInfo {
  user: SessionUser;
  companies: CompanyRef[];
  canSeeUnassigned: boolean;
}

export interface DemoAccount {
  email: string;
  name: string;
  title: string | null;
  role: Role;
  companies: string[];
}

export interface MetaResponse {
  retailers: RetailerRef[];
  reasons: ReasonRef[];
  users: UserRef[];
}

export interface DisputeSummary {
  id: number;
  stage: DisputeStage;
  claimCents: number;
  approvedCents: number | null;
  recoveredCents: number;
  outcome: DisputeOutcome | null;
}

export interface DeductionListItem {
  id: number;
  companyId: number | null;
  companyName: string | null;
  /** company_id exactly as the export had it. */
  sourceCompanyRef: string | null;
  retailerId: number | null;
  retailerName: string | null;
  retailerRaw: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  reasonRaw: string | null;
  disputable: boolean | null;
  invoiceNumber: string | null;
  amountCents: number | null;
  amountFlag: AmountFlag;
  currency: string;
  deductedOn: string | null;
  ageDays: number | null;
  status: DeductionStatus;
  resolution: Resolution | null;
  dispute: DisputeSummary | null;
  assignee: UserRef | null;
  openErrors: number;
  openWarnings: number;
  note: string | null;
  recommended: boolean;
}

export interface DeductionListResponse {
  items: DeductionListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalCents: number;
  currency: string;
}

export interface Issue {
  id: number;
  code: IssueCode;
  severity: IssueSeverity;
  field: string;
  message: string;
  rawValue: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  /** Can be signed off without changing the value. */
  verifiable: boolean;
}

export interface ActivityEntry {
  id: number;
  kind: string;
  summary: string;
  note: string | null;
  actor: UserRef | null;
  createdAt: string;
  simulated: boolean;
}

export interface RecoveryPayment {
  id: number;
  amountCents: number;
  receivedOn: string;
  method: PaymentMethod;
  reference: string | null;
  recordedBy: string | null;
}

export interface DisputeDetail extends DisputeSummary {
  outstandingCents: number;
  writtenOffCents: number;
  claimReference: string | null;
  submittedOn: string | null;
  decidedOn: string | null;
  closedOn: string | null;
  appealCount: number;
  stageEnteredAt: string;
  legacyStageInferred: boolean;
  recoveries: RecoveryPayment[];
  availableActions: DisputeAction[];
}

export interface DeductionDetail extends DeductionListItem {
  sourceStatus: string | null;
  amountRaw: string | null;
  deductedRaw: string | null;
  invoiceRaw: string | null;
  ocrConfidence: number | null;
  recordState: RecordState;
  duplicateOf: number | null;
  duplicates: number[];
  raw: unknown;
  issues: Issue[];
  disputeDetail: DisputeDetail | null;
  activity: ActivityEntry[];
  availableActions: DeductionAction[];
  /** Why "Open dispute" is unavailable, if it is. */
  disputeBlockers: string[];
  assignableUsers: UserRef[];
  editable: { amount: boolean };
}

export interface BoardItem extends DeductionListItem {
  dispute: DisputeSummary;
  stageEnteredAt: string;
  daysInStage: number;
  claimReference: string | null;
  submittedOn: string | null;
  closedOn: string | null;
  appealCount: number;
}

export interface BoardResponse {
  items: BoardItem[];
  currency: string;
}

export interface BulkResult {
  ok: number[];
  failed: { id: number; error: string }[];
}

export interface CountCents {
  count: number;
  cents: number;
}

export interface DashboardResponse {
  currency: string;
  otherCurrencies: string[];
  kpis: {
    open: CountCents;
    opportunity: CountCents;
    inDispute: CountCents;
    outstanding: CountCents;
    recovered: CountCents;
    recoveryRate: number | null;
    winRate: number | null;
    avgDaysToRecover: number | null;
    needsAttention: number;
    legacyClosed: CountCents;
    excluded: number;
  };
  funnel: { key: string; label: string; cents: number; count: number; hint: string }[];
  pipeline: { stage: DisputeStage; count: number; claimCents: number; approvedCents: number; recoveredCents: number }[];
  byRetailer: {
    retailerId: number | null;
    name: string;
    deductedCents: number;
    openCents: number;
    claimedCents: number;
    approvedCents: number;
    recoveredCents: number;
    recoveryRate: number | null;
  }[];
  byReason: { code: string | null; label: string; disputable: boolean | null; count: number; cents: number }[];
  aging: { bucket: string; label: string; count: number; cents: number }[];
  monthly: { month: string; deductedCents: number; recoveredCents: number }[];
  simulatedEvents: number;
}

export interface DataQualityResponse {
  totals: {
    records: number;
    active: number;
    deleted: number;
    duplicates: number;
    empty: number;
    unassigned: number;
    withOpenIssues: number;
  };
  importRun: {
    startedAt: string;
    rowsRead: number;
    exactDuplicateRows: number;
    uniqueIds: number;
    sourceFile: string;
  } | null;
  issues: {
    code: IssueCode;
    label: string;
    severity: IssueSeverity;
    fix: string;
    open: number;
    resolved: number;
  }[];
  retailerVariants: { raw: string | null; retailer: string | null; count: number }[];
  reasonVariants: { raw: string | null; code: string | null; label: string | null; count: number }[];
  statusVariants: { raw: string | null; mappedTo: string; count: number }[];
  amountFormats: { format: string; count: number; example: string | null }[];
  dateFormats: { format: string; count: number; example: string | null }[];
  fieldAliases: { alias: string; count: number }[];
  duplicates: { id: number; duplicateOf: number; amountCents: number | null; invoiceNumber: string | null }[];
}
