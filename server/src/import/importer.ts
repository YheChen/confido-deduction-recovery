/**
 * Loads the four JSON files from Confido's export into SQLite.
 *
 * Every deduction row is kept (deleted, duplicate and empty rows included) so
 * the Data Quality page can account for all 1,007 lines, but only rows in
 * record_state 'active' ever reach an analyst's queue or a metric.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISSUE_META, type IssueCode } from '../../../shared/domain';
import { run, transaction, type DB } from '../db/connection';
import {
  buildReasonIndex,
  buildRetailerIndex,
  cleanText,
  mapStatus,
  matchReason,
  matchRetailer,
  normalizeInvoice,
  parseAmount,
  parseBool,
  parseDate,
  parseId,
  pick,
  type AmountResult,
  type DateResult,
  type InvoiceResult,
  type NumberLiteral,
  type RawAmount,
  type ReasonResult,
  type RetailerResult,
  type StatusResult,
} from './normalize';

interface RawCompany {
  id: number;
  name: string;
  slug: string;
  erp_system: string | null;
  default_currency: string;
  is_active: boolean;
}

interface RawRetailer {
  id: number;
  name: string;
  type: string;
  region: string;
}

interface RawReason {
  code: string;
  label: string;
  category: string;
  typically_disputable: boolean;
}

type RawRecord = Record<string, unknown>;

const AMOUNT_KEYS = ['amount', 'total_amount'];
const RETAILER_KEYS = ['retailer_name', 'retailer'];
const REASON_KEYS = ['reason', 'deduction_reason'];
const KNOWN_KEYS = new Set([
  'id', 'company_id', 'invoice_number', 'deducted_at', 'status', 'is_deleted', 'notes', 'raw',
  ...AMOUNT_KEYS, ...RETAILER_KEYS, ...REASON_KEYS,
]);

/** OCR captures below this confidence get a "verify against the source" flag. */
export const LOW_OCR_CONFIDENCE = 0.5;

const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

function isNumberLiteral(value: unknown): value is NumberLiteral {
  return typeof value === 'object' && value !== null && (value as NumberLiteral).kind === 'number';
}

/**
 * Parses deductions.json keeping the literal text of amount fields, because
 * `57` (cents) and `57.0` (dollars) mean different things in this export.
 */
export function parseDeductionsJson(text: string): RawRecord[] {
  const probe = JSON.parse('1.0', (_key, _value, context?: { source?: string }) => context?.source);
  if (probe !== '1.0') {
    throw new Error('This Node version cannot read JSON number literals. Use Node 22 or newer.');
  }
  const parsed: unknown = JSON.parse(text, (key, value, context?: { source?: string }) => {
    if (typeof value === 'number' && AMOUNT_KEYS.includes(key)) {
      return { kind: 'number', value, source: context?.source ?? String(value) } satisfies NumberLiteral;
    }
    return value;
  });
  if (!Array.isArray(parsed)) throw new Error('deductions.json must contain a JSON array');
  return parsed as RawRecord[];
}

/** Serialises a raw record back to JSON exactly as it appeared (57.0 stays 57.0). */
function rawRecordJson(record: RawRecord): string {
  return JSON.stringify(record, (_key, value) => {
    if (isNumberLiteral(value)) return rawJSON ? rawJSON(value.source) : value.value;
    return value;
  });
}

function rawText(value: unknown): string | null {
  if (value === undefined || value === null) return value === null ? 'null' : null;
  if (isNumberLiteral(value)) return value.source;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

interface PreparedIssue {
  code: IssueCode;
  message: string;
  rawValue: string | null;
}

interface Prepared {
  id: number;
  rawJson: string;
  companyId: number | null;
  sourceCompanyRef: string | null;
  currency: string;
  retailer: RetailerResult;
  reason: ReasonResult;
  invoice: InvoiceResult;
  invoiceRaw: string | null;
  amount: AmountResult;
  amountRaw: string | null;
  date: DateResult;
  deductedRaw: string | null;
  status: StatusResult;
  sourceStatus: string | null;
  isDeleted: boolean;
  note: string | null;
  ocrConfidence: number | null;
  fieldAliases: string[];
  recordState: 'active' | 'deleted' | 'duplicate' | 'empty';
  duplicateOf: number | null;
  issues: PreparedIssue[];
}

export interface ImportStats {
  sourceFile: string;
  startedAt: string;
  rowsRead: number;
  invalidIdRows: number;
  exactDuplicateRows: number[];
  conflictingIdRows: number[];
  uniqueIds: number;
  active: number;
  softDeleted: number;
  empty: number[];
  probableDuplicates: { id: number; of: number }[];
  unassigned: Record<string, number>;
  issueCounts: Record<string, number>;
}

export interface ImportOptions {
  dataDir: string;
  /** YYYY-MM-DD used to flag future dates. */
  today: string;
  now?: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function importExport(db: DB, opts: ImportOptions): ImportStats {
  const now = opts.now ?? new Date().toISOString();
  const companies = readJson<RawCompany[]>(join(opts.dataDir, 'companies.json'));
  const retailers = readJson<RawRetailer[]>(join(opts.dataDir, 'retailers.json'));
  const reasons = readJson<RawReason[]>(join(opts.dataDir, 'dispute_reasons.json'));
  const records = parseDeductionsJson(readFileSync(join(opts.dataDir, 'deductions.json'), 'utf8'));

  const companiesById = new Map(companies.map((c) => [c.id, c]));
  const retailerIndex = buildRetailerIndex(retailers);
  const reasonIndex = buildReasonIndex(reasons);

  const stats: ImportStats = {
    sourceFile: 'deductions.json',
    startedAt: now,
    rowsRead: records.length,
    invalidIdRows: 0,
    exactDuplicateRows: [],
    conflictingIdRows: [],
    uniqueIds: 0,
    active: 0,
    softDeleted: 0,
    empty: [],
    probableDuplicates: [],
    unassigned: {},
    issueCounts: {},
  };

  // 1. Normalise every row, dropping verbatim repeats of the same id.
  const prepared: Prepared[] = [];
  const seen = new Map<number, string>();
  for (const record of records) {
    const id = parseId(record.id);
    if (id === null) {
      stats.invalidIdRows++;
      continue;
    }
    const json = rawRecordJson(record);
    const previous = seen.get(id);
    if (previous !== undefined) {
      (previous === json ? stats.exactDuplicateRows : stats.conflictingIdRows).push(id);
      continue;
    }
    seen.set(id, json);
    prepared.push(prepareRecord(id, record, json));
  }
  stats.uniqueIds = prepared.length;

  // 2. Rows with nothing usable in them.
  for (const p of prepared) {
    const blank =
      p.amount.flag === 'missing' &&
      p.retailer.retailerId === null &&
      p.invoice.value === null &&
      p.date.date === null &&
      p.reason.code === null &&
      cleanText(p.reason.raw) === null;
    if (blank) {
      p.recordState = 'empty';
      stats.empty.push(p.id);
    }
  }

  // 3. The same deduction exported twice under different ids (sometimes a
  //    cent apart). The lowest id is kept; later copies point back to it.
  const groups = new Map<string, Prepared[]>();
  for (const p of prepared) {
    if (p.recordState === 'empty' || p.invoice.value === null || p.amount.cents === null) continue;
    const key = [p.sourceCompanyRef, p.retailer.retailerId, p.invoice.value, p.date.date, p.reason.code].join('|');
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.id - b.id);
    for (let i = 1; i < group.length; i++) {
      const copy = group[i]!;
      const original = group
        .slice(0, i)
        .find(
          (o) =>
            o.recordState !== 'duplicate' &&
            Math.abs(o.amount.cents! - copy.amount.cents!) <= 1 &&
            // A live re-issue of a deleted row is not a duplicate.
            (!o.isDeleted || copy.isDeleted),
        );
      if (original) {
        copy.recordState = 'duplicate';
        copy.duplicateOf = original.id;
        stats.probableDuplicates.push({ id: copy.id, of: original.id });
      }
    }
  }

  for (const p of prepared) {
    if (p.recordState === 'active' && p.isDeleted) p.recordState = 'deleted';
    if (p.recordState === 'deleted') stats.softDeleted++;
    if (p.recordState === 'active') {
      stats.active++;
      if (p.companyId === null) {
        const ref = p.sourceCompanyRef ?? 'missing';
        stats.unassigned[ref] = (stats.unassigned[ref] ?? 0) + 1;
      }
      for (const issue of p.issues) stats.issueCounts[issue.code] = (stats.issueCounts[issue.code] ?? 0) + 1;
    }
  }

  // 4. Write everything in one transaction.
  transaction(db, () => {
    for (const c of companies) {
      run(
        db,
        `INSERT INTO companies (id, name, slug, erp_system, default_currency, is_active)
         VALUES (:id, :name, :slug, :erp, :currency, :active)`,
        { id: c.id, name: c.name, slug: c.slug, erp: c.erp_system, currency: c.default_currency, active: c.is_active },
      );
    }
    for (const r of retailers) {
      run(db, 'INSERT INTO retailers (id, name, type, region) VALUES (:id, :name, :type, :region)', { ...r });
    }
    for (const r of reasons) {
      run(
        db,
        `INSERT INTO reasons (code, label, category, typically_disputable)
         VALUES (:code, :label, :category, :disputable)`,
        { code: r.code, label: r.label, category: r.category, disputable: r.typically_disputable },
      );
    }
    for (const p of prepared) insertPrepared(db, p, now);
    run(db, 'INSERT INTO import_runs (started_at, source_file, stats_json) VALUES (:at, :file, :stats)', {
      at: now,
      file: stats.sourceFile,
      stats: JSON.stringify(stats),
    });
  });

  return stats;

  function prepareRecord(id: number, record: RawRecord, json: string): Prepared {
    const issues: PreparedIssue[] = [];
    const fieldAliases: string[] = [];
    const add = (list: { code: IssueCode; message: string }[], rawValue: string | null) => {
      for (const issue of list) issues.push({ ...issue, rawValue });
    };

    // Company
    const companyRaw = record.company_id;
    const companyNum = parseId(companyRaw);
    const company = companyNum !== null ? companiesById.get(companyNum) : undefined;
    const sourceCompanyRef = companyRaw === undefined ? null : String(companyRaw);
    if (!company) {
      add(
        [
          {
            code: 'COMPANY_UNKNOWN',
            message:
              companyRaw === null || companyRaw === undefined
                ? 'The export does not say which company this deduction belongs to.'
                : `company_id ${JSON.stringify(companyRaw)} does not match any company in companies.json.`,
          },
        ],
        sourceCompanyRef,
      );
    }

    // Retailer, reason, amount (each has an alternate key in some rows)
    const retailerField = pick(record, RETAILER_KEYS);
    if (retailerField.key && retailerField.key !== 'retailer_name') fieldAliases.push(`${retailerField.key} → retailer_name`);
    const retailer = matchRetailer(retailerField.value, retailerIndex);
    add(retailer.issues, rawText(retailerField.value));

    const reasonField = pick(record, REASON_KEYS);
    if (reasonField.key && reasonField.key !== 'reason') fieldAliases.push(`${reasonField.key} → reason`);
    const reason = matchReason(reasonField.value, reasonIndex);
    add(reason.issues, rawText(reasonField.value));

    const amountField = pick(record, AMOUNT_KEYS);
    if (amountField.key && amountField.key !== 'amount') fieldAliases.push(`${amountField.key} → amount`);
    const amount = parseAmount(amountField.value as RawAmount);
    const amountRaw = rawText(amountField.value);
    add(amount.issues, amountRaw);

    const invoice = normalizeInvoice(record.invoice_number);
    add(invoice.issues, rawText(record.invoice_number));

    const date = parseDate(record.deducted_at, opts.today);
    const deductedRaw = rawText(record.deducted_at);
    add(date.issues, deductedRaw);

    const status = mapStatus(record.status);
    const sourceStatus = record.status === undefined ? null : record.status === null ? 'null' : String(record.status);
    if (status.inferred) add([{ code: 'STATUS_INFERRED', message: status.inferred }], sourceStatus);

    let ocrConfidence: number | null = null;
    const ocr = record.raw as { src?: unknown; conf?: unknown } | undefined;
    if (ocr && typeof ocr === 'object' && typeof ocr.conf === 'number') {
      ocrConfidence = ocr.conf;
      if (ocr.conf < LOW_OCR_CONFIDENCE) {
        add(
          [
            {
              code: 'LOW_OCR_CONFIDENCE',
              message: `Read from a scanned document by ${String(ocr.src ?? 'OCR')} with ${Math.round(ocr.conf * 100)}% confidence. Check the amount and invoice # against the original.`,
            },
          ],
          JSON.stringify(ocr),
        );
      }
    }

    for (const key of Object.keys(record)) if (!KNOWN_KEYS.has(key)) fieldAliases.push(`${key} (ignored)`);

    return {
      id,
      rawJson: json,
      companyId: company?.id ?? null,
      sourceCompanyRef,
      currency: amount.currency ?? company?.default_currency ?? 'USD',
      retailer,
      reason,
      invoice,
      invoiceRaw: rawText(record.invoice_number),
      amount,
      amountRaw,
      date,
      deductedRaw,
      status,
      sourceStatus,
      isDeleted: parseBool(record.is_deleted),
      note: cleanText(record.notes),
      ocrConfidence,
      fieldAliases,
      recordState: 'active',
      duplicateOf: null,
      issues,
    };
  }
}

function insertPrepared(db: DB, p: Prepared, now: string): void {
  run(
    db,
    `INSERT INTO deductions (
       id, company_id, source_company_ref, retailer_id, retailer_raw, reason_code, reason_raw,
       invoice_number, invoice_raw, invoice_format, amount_cents, amount_flag, amount_raw, amount_format,
       currency, deducted_on, date_flag, deducted_raw, date_format, status, resolution, source_status,
       record_state, duplicate_of, source_note, ocr_confidence, field_aliases, raw_json, created_at, updated_at
     ) VALUES (
       :id, :companyId, :companyRef, :retailerId, :retailerRaw, :reasonCode, :reasonRaw,
       :invoice, :invoiceRaw, :invoiceFormat, :cents, :amountFlag, :amountRaw, :amountFormat,
       :currency, :date, :dateFlag, :dateRaw, :dateFormat, :status, :resolution, :sourceStatus,
       :state, :duplicateOf, :note, :ocr, :aliases, :raw, :now, :now
     )`,
    {
      id: p.id,
      companyId: p.companyId,
      companyRef: p.sourceCompanyRef,
      retailerId: p.retailer.retailerId,
      retailerRaw: p.retailer.raw,
      reasonCode: p.reason.code,
      reasonRaw: p.reason.raw,
      invoice: p.invoice.value,
      invoiceRaw: p.invoiceRaw,
      invoiceFormat: p.invoice.format,
      cents: p.amount.cents,
      amountFlag: p.amount.flag,
      amountRaw: p.amountRaw,
      amountFormat: p.amount.format,
      currency: p.currency,
      date: p.date.date,
      dateFlag: p.date.flag,
      dateRaw: p.deductedRaw,
      dateFormat: p.date.format,
      status: p.status.status,
      resolution: p.status.resolution,
      sourceStatus: p.sourceStatus,
      state: p.recordState,
      duplicateOf: p.duplicateOf,
      note: p.note,
      ocr: p.ocrConfidence,
      aliases: p.fieldAliases.length ? JSON.stringify(p.fieldAliases) : null,
      raw: p.rawJson,
      now,
    },
  );

  for (const issue of p.issues) {
    const meta = ISSUE_META[issue.code];
    run(
      db,
      `INSERT INTO deduction_issues (deduction_id, code, severity, field, message, raw_value)
       VALUES (:id, :code, :severity, :field, :message, :raw)`,
      { id: p.id, code: issue.code, severity: meta.severity, field: meta.field, message: issue.message, raw: issue.rawValue },
    );
  }

  if (p.status.status === 'disputed' && p.status.disputeStage) {
    const claim = p.amount.flag === 'ok' && p.amount.cents ? p.amount.cents : null;
    run(
      db,
      `INSERT INTO disputes (deduction_id, stage, claim_cents, stage_entered_at, legacy_stage_inferred, created_at, updated_at)
       VALUES (:id, :stage, :claim, :now, :inferred, :now, :now)`,
      { id: p.id, stage: p.status.disputeStage, claim, now, inferred: p.status.inferred !== null },
    );
  }

  const blankStatus = p.sourceStatus === null || p.sourceStatus === 'null' || p.sourceStatus.trim() === '';
  const noteParts = [`Spreadsheet status: ${blankStatus ? '(blank)' : `"${p.sourceStatus!.trim()}"`}.`];
  if (p.note) noteParts.push(`Spreadsheet note: "${p.note}".`);
  run(
    db,
    `INSERT INTO activity (deduction_id, actor_id, kind, summary, note, created_at)
     VALUES (:id, NULL, 'import', 'Imported from deductions.json', :note, :now)`,
    { id: p.id, note: noteParts.join(' '), now },
  );
}
