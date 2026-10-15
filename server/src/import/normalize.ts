/**
 * Pure functions that turn one messy field from the export into a clean value
 * plus whatever an analyst should know about how we got there.
 *
 * Nothing here touches the database, so every rule is unit-tested in
 * test/normalize.test.ts.
 */
import type { DeductionStatus, DisputeStage, IssueCode, Resolution } from '../../../shared/domain';

export interface FieldIssue {
  code: IssueCode;
  message: string;
}

/** Values people type into a spreadsheet cell when they mean "nothing". */
const PLACEHOLDERS = new Set(['', '-', '--', 'n/a', 'na', 'null', 'none', 'nil', 'undefined', 'tbd', '?', '???']);

export function isPlaceholder(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return PLACEHOLDERS.has(value.trim().toLowerCase());
  return false;
}

/** Trims, collapses inner whitespace (tabs included) and maps placeholders to null. */
export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return isPlaceholder(text) ? null : text;
}

export function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ------------------------------------------------------------------- amounts

/**
 * JSON.parse loses the difference between `57` and `57.0`, and that difference
 * matters here: the export writes dollar amounts as decimals and a subset of
 * rows as whole numbers that are really cents. The importer parses with a
 * reviver that keeps the literal source text of amount fields in this shape.
 */
export interface NumberLiteral {
  kind: 'number';
  value: number;
  source: string;
}

export type RawAmount = NumberLiteral | string | number | boolean | null | undefined;

export interface AmountResult {
  cents: number | null;
  flag: 'ok' | 'missing' | 'suspect';
  /** Human-readable description of the shape the value arrived in. */
  format: string;
  /** Currency code spelled out in the value itself, e.g. "USD 12.00". */
  currency: string | null;
  issues: FieldIssue[];
}

/** Anything above this is far outside the export's distribution (max legit ≈ $41k). */
export const MAX_PLAUSIBLE_CENTS = 100_000_00;

function missingAmount(format: string, message: string): AmountResult {
  return { cents: null, flag: 'missing', format, currency: null, issues: [{ code: 'AMOUNT_MISSING', message }] };
}

export function parseAmount(raw: RawAmount): AmountResult {
  if (raw === undefined) return missingAmount('absent', 'The export has no amount field for this deduction.');
  if (raw === null) return missingAmount('null', 'The amount is empty in the export.');

  let dollars: number;
  let format: string;
  let currency: string | null = null;
  let exportedAsCents = false;
  let literal = '';

  if (typeof raw === 'object' && raw.kind === 'number') {
    literal = raw.source.trim();
    if (/^-?\d+$/.test(literal)) {
      exportedAsCents = true;
      format = 'number, whole (cents)';
      dollars = raw.value / 100;
    } else {
      format = /e/i.test(literal) ? 'number, scientific notation' : 'number (dollars)';
      dollars = raw.value;
    }
  } else if (typeof raw === 'number') {
    // Fallback when literal text was not captured: treat as dollars.
    format = 'number (dollars)';
    dollars = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (isPlaceholder(text)) {
      return missingAmount(
        text === '' ? 'blank string' : `placeholder "${text}"`,
        text === '' ? 'The amount is blank in the export.' : `The amount says "${text}" in the export.`,
      );
    }
    let t = text;
    let negative = false;
    const code = t.match(/^([A-Za-z]{3})\s+/);
    if (code) {
      currency = code[1]!.toUpperCase();
      t = t.slice(code[0].length);
    }
    if (/^\(.*\)$/.test(t)) {
      negative = true;
      t = t.slice(1, -1).trim();
    }
    if (t.startsWith('-')) {
      negative = !negative;
      t = t.slice(1).trim();
    }
    const hasSymbol = t.startsWith('$');
    if (hasSymbol) t = t.slice(1).trim();
    if (t.startsWith('-')) {
      negative = !negative;
      t = t.slice(1).trim();
    }
    const hasThousands = t.includes(',');
    t = t.replace(/,/g, '');
    if (!/^\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t)) {
      return missingAmount('unparseable string', `Could not read "${text}" as an amount.`);
    }
    dollars = Number(t) * (negative ? -1 : 1);
    if (currency) format = `string with currency ("${currency} 12.34")`;
    else if (/^\(.*\)$/.test(text)) format = 'string, accounting negative ("(12.34)")';
    else if (hasSymbol) format = hasThousands ? 'string with $ and commas ("$1,234.56")' : 'string with $ ("$12.34")';
    else if (hasThousands) format = 'string with commas ("1,234.56")';
    else if (/e/i.test(t)) format = 'string, scientific notation ("1.2E7")';
    else if (text !== raw) format = 'numeric string with padding ("  12.34  ")';
    else format = 'numeric string ("12.34")';
  } else {
    return missingAmount('unsupported type', `Unexpected amount value: ${JSON.stringify(raw)}.`);
  }

  if (!Number.isFinite(dollars)) return missingAmount('not a number', 'The amount is not a finite number.');

  const issues: FieldIssue[] = [];
  let cents = Math.round(dollars * 100);
  if (cents < 0) {
    cents = -cents;
    issues.push({
      code: 'AMOUNT_NEGATIVE',
      message: `Exported as a negative number; stored as a ${formatDollars(cents)} deduction.`,
    });
  }
  cents = cents === 0 ? 0 : cents; // normalise -0
  if (exportedAsCents && cents !== 0) {
    issues.push({
      code: 'AMOUNT_CENTS',
      message: `Exported as the whole number ${literal}. Every other amount has decimals, so this was read as cents: ${formatDollars(cents)}.`,
    });
  }

  let flag: AmountResult['flag'] = 'ok';
  if (cents === 0) {
    issues.push({ code: 'AMOUNT_ZERO', message: 'The amount is zero, so there is nothing to recover.' });
  } else if (cents > MAX_PLAUSIBLE_CENTS) {
    flag = 'suspect';
    const placeholder = /^9{6,}/.test(String(Math.trunc(cents / 100)));
    issues.push({
      code: 'AMOUNT_SUSPECT',
      message: placeholder
        ? `${formatDollars(cents)} looks like a placeholder value, not a real deduction.`
        : `${formatDollars(cents)} is far above every other deduction in the export (likely a unit or typing error).`,
    });
  }

  return { cents, flag, format, currency, issues };
}

// --------------------------------------------------------------------- dates

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

export interface DateResult {
  date: string | null;
  flag: 'ok' | 'missing' | 'suspect';
  format: string;
  issues: FieldIssue[];
}

/** Earliest date we consider plausible for this export. */
export const EARLIEST_PLAUSIBLE_DATE = '2020-01-01';

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function missingDate(format: string, message: string): DateResult {
  return { date: null, flag: 'missing', format, issues: [{ code: 'DATE_MISSING', message }] };
}

/**
 * Parses the ~20 date shapes in the export. Ambiguous numeric formats are read
 * the way the rest of that format reads: slash dates are US month-first (91 of
 * them have a day > 12), dash dates are day-first (45 have a day > 12).
 */
export function parseDate(raw: unknown, today: string): DateResult {
  if (raw === null || raw === undefined) return missingDate('null', 'No deduction date in the export.');

  let date: string | null = null;
  let format: string;

  if (typeof raw === 'number') {
    const ms = raw > 1e11 ? raw : raw * 1000;
    format = raw > 1e11 ? 'Unix timestamp (ms)' : 'Unix timestamp (seconds)';
    const dt = new Date(ms);
    date = Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (isPlaceholder(s)) {
      return missingDate(s === '' ? 'blank' : `placeholder "${s}"`, `The date says "${raw}" in the export.`);
    }
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
      format = 'YYYY-MM-DD';
      date = isoDate(+m[1]!, +m[2]!, +m[3]!);
    } else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?$/))) {
      format = 'ISO timestamp';
      date = isoDate(+m[1]!, +m[2]!, +m[3]!);
    } else if ((m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/))) {
      format = 'YYYY/MM/DD hh:mm:ss';
      date = isoDate(+m[1]!, +m[2]!, +m[3]!);
    } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
      format = 'MM/DD/YYYY';
      date = isoDate(+m[3]!, +m[1]!, +m[2]!) ?? isoDate(+m[3]!, +m[2]!, +m[1]!);
    } else if ((m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/))) {
      format = 'DD-MM-YYYY';
      date = isoDate(+m[3]!, +m[2]!, +m[1]!) ?? isoDate(+m[3]!, +m[1]!, +m[2]!);
    } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/))) {
      format = 'M/D/YY';
      date = isoDate(2000 + +m[3]!, +m[1]!, +m[2]!);
    } else if ((m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
      format = 'Month D, YYYY';
      const month = MONTHS[m[1]!.toLowerCase()];
      date = month ? isoDate(+m[3]!, month, +m[2]!) : null;
    } else {
      return missingDate('unrecognized', `Could not read "${s}" as a date.`);
    }
  } else {
    return missingDate('unsupported type', `Unexpected date value: ${JSON.stringify(raw)}.`);
  }

  if (!date) return missingDate(format, `"${String(raw)}" is not a real calendar date.`);

  if (date > today) {
    return {
      date,
      flag: 'suspect',
      format,
      issues: [{ code: 'DATE_FUTURE', message: `${date} is after today (${today}). A deduction cannot be dated in the future.` }],
    };
  }
  if (date < EARLIEST_PLAUSIBLE_DATE) {
    return {
      date,
      flag: 'suspect',
      format,
      issues: [{ code: 'DATE_IMPLAUSIBLE', message: `${date} is years before the rest of the export.` }],
    };
  }
  return { date, flag: 'ok', format, issues: [] };
}

// ----------------------------------------------------------------- retailers

/**
 * Canonical retailer name → spellings seen in the wild, written as
 * `retailerKey` output. Matching on keys (not raw strings) absorbs casing,
 * spacing, punctuation and corporate suffixes for free.
 */
export const RETAILER_ALIASES: Record<string, string[]> = {
  KeHE: ['kehe', 'kehedistributors', 'kehefooddistributors'],
  UNFI: ['unfi', 'unitednaturalfoods'],
  'Gordon Food Service': ['gordonfoodservice', 'gordonfoodsvc', 'gordonfoodservicegfc', 'gfs', 'gfc'],
  'Dot Foods': ['dotfoods'],
  Kroger: ['kroger'],
  Target: ['target', 'tgt'],
  Walmart: ['walmart'],
  Amazon: ['amazon', 'amazoncom', 'amazonvendor', 'amazonvendorcentral', 'amzn'],
  'WinCo Foods': ['wincofoods', 'winco'],
  Loblaw: ['loblaw', 'loblaws'],
  'Ahold Delhaize': ['aholddelhaize', 'ahold', 'delhaize'],
  "BJ's Wholesale Club": ['bjswholesaleclub', 'bjswholesale', 'bjs'],
  'H-E-B': ['heb'],
  CVS: ['cvs', 'cvspharmacy', 'cvshealth'],
};

const CORPORATE_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'companies']);

/** "The Kroger Co." → "kroger", "K e H E" → "kehe", "U.N.F.I." → "unfi". */
export function retailerKey(name: string): string {
  const tokens = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join('');
}

export interface RetailerIndex {
  byKey: Map<string, number>;
}

export function buildRetailerIndex(retailers: { id: number; name: string }[]): RetailerIndex {
  const byKey = new Map<string, number>();
  for (const r of retailers) {
    byKey.set(retailerKey(r.name), r.id);
    for (const alias of RETAILER_ALIASES[r.name] ?? []) byKey.set(alias, r.id);
  }
  return { byKey };
}

export interface RetailerResult {
  retailerId: number | null;
  raw: string | null;
  issues: FieldIssue[];
}

export function matchRetailer(raw: unknown, index: RetailerIndex): RetailerResult {
  const text = cleanText(raw);
  if (!text) {
    return {
      retailerId: null,
      raw: raw === undefined || raw === null ? null : String(raw),
      issues: [{ code: 'RETAILER_MISSING', message: 'No retailer name in the export.' }],
    };
  }
  const id = index.byKey.get(retailerKey(text));
  if (id !== undefined) return { retailerId: id, raw: String(raw), issues: [] };
  return {
    retailerId: null,
    raw: String(raw),
    issues: [{ code: 'RETAILER_UNMATCHED', message: `"${text}" does not match any retailer in retailers.json.` }],
  };
}

// ------------------------------------------------------------------- reasons

/** Reason code → spellings seen in the wild, written as `reasonKey` output. */
export const REASON_ALIASES: Record<string, string[]> = {
  SHORT: ['shortage', 'short', 'shortage in transit', 'shortage product', 'short ship', 'short shipment'],
  PRICE: ['pricing', 'price', 'price discrepancy', 'pricing discrepancy', 'price variance'],
  FREIGHT: ['freight', 'frieght', 'freight allowance', 'freight charge'],
  OSD: ['os d', 'osd', 'over short damaged', 'over short and damaged'],
  COMP: ['compliance fine', 'compliance', 'fine', 'fines', 'compliance chargeback'],
  SPOIL: ['spoilage', 'spoiled', 'spoils'],
  UNSAL: ['unsaleables', 'unsaleable', 'unsalables', 'unsalable', 'unsellable'],
  MCB: ['bill back', 'billback', 'bill back mcb', 'mcb', 'manufacturer chargeback'],
  PROMO: ['promotional allowance', 'promo', 'promotion', 'promotional'],
};

/** Labels that carry no information about the cause. */
const VAGUE_REASONS = new Set(['misc', 'miscellaneous', 'other', 'unknown', '']);

export function reasonKey(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface ReasonResult {
  code: string | null;
  raw: string | null;
  issues: FieldIssue[];
}

export function buildReasonIndex(reasons: { code: string; label: string }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const r of reasons) {
    index.set(reasonKey(r.code), r.code);
    index.set(reasonKey(r.label), r.code);
    for (const alias of REASON_ALIASES[r.code] ?? []) index.set(alias, r.code);
  }
  return index;
}

export function matchReason(raw: unknown, index: Map<string, string>): ReasonResult {
  const text = cleanText(raw);
  const rawText = raw === undefined || raw === null ? null : String(raw);
  if (!text || VAGUE_REASONS.has(reasonKey(text))) {
    return {
      code: null,
      raw: rawText,
      issues: [
        {
          code: 'REASON_UNCLASSIFIED',
          message: text ? `The retailer's reason was "${text}", which does not say what the deduction is for.` : 'No reason in the export.',
        },
      ],
    };
  }
  const code = index.get(reasonKey(text));
  if (code) return { code, raw: rawText, issues: [] };
  return {
    code: null,
    raw: rawText,
    issues: [{ code: 'REASON_UNCLASSIFIED', message: `"${text}" does not match a known reason code.` }],
  };
}

// ------------------------------------------------------------------ invoices

export interface InvoiceResult {
  value: string | null;
  format: string;
  issues: FieldIssue[];
}

/** "inv-38683", "INV 97464", "#39205", "0073822", "INV-87825/A " → "INV-38683" … "INV-87825/A". */
export function normalizeInvoice(raw: unknown): InvoiceResult {
  const text = cleanText(raw);
  if (!text) {
    return {
      value: null,
      format: raw === null || raw === undefined ? 'null' : `placeholder "${String(raw).trim()}"`,
      issues: [{ code: 'INVOICE_MISSING', message: 'No invoice number in the export.' }],
    };
  }
  const upper = text.toUpperCase();
  const m = upper.match(/^#?\s*(?:INV[\s-]*)?#?\s*0*(\d+)(?:\s*\/\s*([A-Z0-9]+))?$/);
  if (!m) return { value: upper, format: 'other', issues: [] };
  const value = `INV-${m[1]}${m[2] ? `/${m[2]}` : ''}`;
  let format: string;
  if (/^INV-\d+(\/[A-Z0-9]+)?$/.test(text)) format = m[2] ? 'INV-12345/A (split)' : 'INV-12345';
  else if (/^inv-/.test(text)) format = 'inv-12345 (lowercase)';
  else if (/^INV /i.test(text)) format = 'INV 12345 (space)';
  else if (text.startsWith('#')) format = '#12345';
  else if (/^0\d{6,}$/.test(text)) format = '0012345 (zero-padded)';
  else format = '12345 (bare number)';
  return { value, format, issues: [] };
}

// ------------------------------------------------------------------ statuses

export interface StatusResult {
  status: DeductionStatus;
  resolution: Resolution | null;
  disputeStage: DisputeStage | null;
  inferred: string | null;
}

/** Maps the spreadsheet's free-text status column onto the workflow. */
export function mapStatus(raw: unknown): StatusResult {
  const text = cleanText(raw)?.toLowerCase().replace(/[–—]/g, '-').replace(/\s*-\s*/g, ' - ') ?? null;
  switch (text) {
    case null:
    case 'open':
    case 'new':
      return { status: 'new', resolution: null, disputeStage: null, inferred: null };
    case 'in review':
    case 'review':
      return { status: 'in_review', resolution: null, disputeStage: null, inferred: null };
    case 'send to ops':
    case 'sent to ops':
      return { status: 'with_ops', resolution: null, disputeStage: null, inferred: null };
    case 'dispute - filing in progress':
      return { status: 'disputed', resolution: null, disputeStage: 'preparing', inferred: null };
    case 'dispute - filed':
      return { status: 'disputed', resolution: null, disputeStage: 'submitted', inferred: null };
    case 'dispute':
    case 'disputed':
      return {
        status: 'disputed',
        resolution: null,
        disputeStage: 'preparing',
        inferred: `The spreadsheet just said "${String(raw).trim()}", with no stage. Assumed it has not been filed yet (Preparing).`,
      };
    case 'complete':
    case 'completed':
    case 'closed':
      return {
        status: 'closed',
        resolution: 'legacy_unknown',
        disputeStage: null,
        inferred: `Marked "${String(raw).trim()}" in the spreadsheet with no outcome or recovered amount. Kept out of recovery rates until someone records what happened.`,
      };
    default:
      return {
        status: 'new',
        resolution: null,
        disputeStage: null,
        inferred: `Unrecognized status "${String(raw).trim()}". Treated as New.`,
      };
  }
}

// --------------------------------------------------------------------- misc

/** true / "true" / 1 / "1" / "yes" → true. Everything else (incl. null) → false. */
export function parseBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') return ['true', '1', 'yes', 'y', 't'].includes(raw.trim().toLowerCase());
  return false;
}

/** 1394 / "1394" / " 1394 " → 1394. Anything else → null. */
export function parseId(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) return Number(raw.trim());
  return null;
}

/** Returns the first key present on the record, so `retailer` stands in for `retailer_name` etc. */
export function pick(record: Record<string, unknown>, keys: string[]): { key: string | null; value: unknown } {
  for (const key of keys) if (key in record) return { key, value: record[key] };
  return { key: null, value: undefined };
}
