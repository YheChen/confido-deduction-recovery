import { describe, expect, it } from 'vitest';
import {
  buildReasonIndex,
  buildRetailerIndex,
  mapStatus,
  matchReason,
  matchRetailer,
  normalizeInvoice,
  parseAmount,
  parseBool,
  parseDate,
  parseId,
  retailerKey,
  type NumberLiteral,
} from '../src/import/normalize';

const num = (source: string): NumberLiteral => ({ kind: 'number', value: Number(source), source });
const TODAY = '2026-10-14';

describe('parseAmount', () => {
  it('reads decimal numbers as dollars and rounds float noise', () => {
    expect(parseAmount(num('166.9'))).toMatchObject({ cents: 16690, flag: 'ok' });
    expect(parseAmount(num('6.8199999992')).cents).toBe(682);
    expect(parseAmount(num('57.0'))).toMatchObject({ cents: 5700, format: 'number (dollars)' });
  });

  it('reads whole-number literals as cents and flags them for a spot check', () => {
    const result = parseAmount(num('69895'));
    expect(result.cents).toBe(69895);
    expect(result.issues.map((i) => i.code)).toContain('AMOUNT_CENTS');
  });

  it('parses formatted strings', () => {
    expect(parseAmount('$2,584.55').cents).toBe(258455);
    expect(parseAmount('USD 1798.98')).toMatchObject({ cents: 179898, currency: 'USD' });
    expect(parseAmount('  117.71  ').cents).toBe(11771);
    expect(parseAmount('1,146.71').cents).toBe(114671);
  });

  it('stores negatives and accounting negatives as positive deductions', () => {
    for (const raw of ['(102.78)', '-$3.28', '  -93.47  ']) {
      const result = parseAmount(raw);
      expect(result.cents).toBeGreaterThan(0);
      expect(result.issues.map((i) => i.code)).toContain('AMOUNT_NEGATIVE');
    }
    expect(parseAmount('(102.78)').cents).toBe(10278);
  });

  it('treats placeholders as missing', () => {
    for (const raw of ['TBD', '', null, undefined]) {
      expect(parseAmount(raw as string)).toMatchObject({ cents: null, flag: 'missing' });
    }
  });

  it('flags implausible values instead of trusting them', () => {
    expect(parseAmount(num('999999999.99')).flag).toBe('suspect');
    expect(parseAmount('1.2E7')).toMatchObject({ cents: 1_200_000_000, flag: 'suspect' });
    expect(parseAmount(num('-50500000')).flag).toBe('suspect');
  });

  it('flags zero amounts, including float dust', () => {
    expect(parseAmount('$0.00').issues.map((i) => i.code)).toEqual(['AMOUNT_ZERO']);
    expect(parseAmount(num('-2.65e-10')).cents).toBe(0);
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-01-05', '2026-01-05'],
    ['2026-09-15T00:00:00.000Z', '2026-09-15'],
    ['2026/02/01 00:00:00', '2026-02-01'],
    ['02/16/2026', '2026-02-16'], // slash dates are month-first
    ['18-05-2026', '2026-05-18'], // dash dates are day-first
    ['3/14/26', '2026-03-14'],
    ['July 20, 2026', '2026-07-20'],
    ['September 1, 2026', '2026-09-01'],
  ])('parses %s', (raw, expected) => {
    expect(parseDate(raw, TODAY)).toMatchObject({ date: expected, flag: 'ok' });
  });

  it('parses unix timestamps', () => {
    expect(parseDate(1773273600, TODAY).date).toBe('2026-03-12');
  });

  it('treats placeholders as missing', () => {
    for (const raw of ['null', 'n/a', 'N/A', '-', '', '  ', null]) {
      expect(parseDate(raw, TODAY)).toMatchObject({ date: null, flag: 'missing' });
    }
  });

  it('flags future dates', () => {
    const result = parseDate('2028-12-21', TODAY);
    expect(result).toMatchObject({ date: '2028-12-21', flag: 'suspect' });
    expect(result.issues[0]!.code).toBe('DATE_FUTURE');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseDate('02/30/2026', TODAY).flag).toBe('missing');
  });
});

describe('retailer matching', () => {
  const index = buildRetailerIndex([
    { id: 10, name: 'KeHE' },
    { id: 11, name: 'UNFI' },
    { id: 12, name: 'Gordon Food Service' },
    { id: 14, name: 'Kroger' },
    { id: 16, name: 'Walmart' },
    { id: 17, name: 'Amazon' },
    { id: 21, name: "BJ's Wholesale Club" },
    { id: 22, name: 'H-E-B' },
  ]);

  it.each([
    ['KEHE\t', 10],
    ['K e H E', 10],
    ['KeHE Distributors LLC', 10],
    ['Kehe Food Distributors', 10],
    ['U.N.F.I.', 11],
    ['Un fi', 11],
    ['United Natural Foods Inc', 11],
    ['Gordon Food Service (GFC)', 12],
    ['GFS', 12],
    ['The Kroger Co.', 14],
    ['kroger co', 14],
    ['Wal-Mart', 16],
    ['AMZN', 17],
    ['Amazon Vendor Central', 17],
    ['Bjs Wholesale', 21],
    ['H E B', 22],
  ])('maps %j to retailer %i', (raw, id) => {
    expect(matchRetailer(raw, index).retailerId).toBe(id);
  });

  it('treats placeholders as missing and unknown names as unmatched', () => {
    expect(matchRetailer('n/a', index).issues[0]!.code).toBe('RETAILER_MISSING');
    expect(matchRetailer('-', index).issues[0]!.code).toBe('RETAILER_MISSING');
    expect(matchRetailer('Costco', index).issues[0]!.code).toBe('RETAILER_UNMATCHED');
  });

  it('builds keys that ignore punctuation and corporate suffixes', () => {
    expect(retailerKey('Target Corporation')).toBe('target');
    expect(retailerKey("BJ's Wholesale Club")).toBe('bjswholesaleclub');
  });
});

describe('reason matching', () => {
  const index = buildReasonIndex([
    { code: 'SHORT', label: 'Shortage' },
    { code: 'PRICE', label: 'Pricing' },
    { code: 'FREIGHT', label: 'Freight' },
    { code: 'OSD', label: 'OS&D' },
    { code: 'COMP', label: 'Compliance Fine' },
    { code: 'SPOIL', label: 'Spoilage' },
    { code: 'UNSAL', label: 'Unsaleables' },
    { code: 'MCB', label: 'Bill Back / MCB' },
    { code: 'PROMO', label: 'Promotional Allowance' },
  ]);

  it.each([
    ['Shortage in Transit', 'SHORT'],
    ['Price Discrepancy', 'PRICE'],
    ['Frieght', 'FREIGHT'],
    ['OS&D', 'OSD'],
    ['Fine', 'COMP'],
    ['Spoiled', 'SPOIL'],
    ['Unsalables', 'UNSAL'],
    ['Billback', 'MCB'],
    ['Promo', 'PROMO'],
  ])('maps %j to %s', (raw, code) => {
    expect(matchReason(raw, index).code).toBe(code);
  });

  it('leaves vague reasons unclassified', () => {
    for (const raw of ['misc', '???', 'N/A', 'Other', '', null]) {
      expect(matchReason(raw, index)).toMatchObject({ code: null });
    }
  });
});

describe('normalizeInvoice', () => {
  it.each([
    ['INV-61043', 'INV-61043'],
    ['inv-38683', 'INV-38683'],
    ['INV 97464', 'INV-97464'],
    ['#39205', 'INV-39205'],
    ['0073822', 'INV-73822'],
    ['73909', 'INV-73909'],
    ['INV-87825/A', 'INV-87825/A'],
    ['INV-70658 ', 'INV-70658'],
  ])('normalizes %j', (raw, expected) => {
    expect(normalizeInvoice(raw).value).toBe(expected);
  });

  it('flags placeholders', () => {
    expect(normalizeInvoice('n/a').issues[0]!.code).toBe('INVOICE_MISSING');
  });
});

describe('mapStatus', () => {
  it.each([
    [null, 'new', null],
    ['', 'new', null],
    ['Open', 'new', null],
    [' In Review ', 'in_review', null],
    ['Send to Ops', 'with_ops', null],
    ['Dispute - Filing in progress', 'disputed', 'preparing'],
    ['Dispute - Filed', 'disputed', 'submitted'],
    ['dispute', 'disputed', 'preparing'],
    ['COMPLETE', 'closed', null],
  ])('maps %j', (raw, status, stage) => {
    const result = mapStatus(raw);
    expect(result.status).toBe(status);
    expect(result.disputeStage).toBe(stage);
  });

  it('records why ambiguous statuses were interpreted the way they were', () => {
    expect(mapStatus('dispute').inferred).toMatch(/Preparing/);
    expect(mapStatus('Complete').resolution).toBe('legacy_unknown');
  });
});

describe('scalars', () => {
  it('parses the many spellings of is_deleted', () => {
    expect([true, 'true', 1, '1'].map(parseBool)).toEqual([true, true, true, true]);
    expect([false, 'false', 0, null, undefined].map(parseBool)).toEqual([false, false, false, false, false]);
  });

  it('parses ids given as strings', () => {
    expect(parseId('1394')).toBe(1394);
    expect(parseId(1394)).toBe(1394);
    expect(parseId('abc')).toBeNull();
  });
});
