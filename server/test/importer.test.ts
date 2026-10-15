import { describe, expect, it } from 'vitest';
import { all, get } from '../src/db/connection';
import { freshDb } from './helpers';

describe('importing the real export', () => {
  const db = freshDb();
  const stats = JSON.parse(get<{ stats_json: string }>(db, 'SELECT stats_json FROM import_runs')!.stats_json);

  it('accounts for every row', () => {
    expect(stats.rowsRead).toBe(1007);
    expect(stats.exactDuplicateRows.sort()).toEqual([1003, 1057]);
    expect(stats.uniqueIds).toBe(1005);
    const states = Object.fromEntries(
      all<{ record_state: string; n: number }>(db, 'SELECT record_state, COUNT(*) AS n FROM deductions GROUP BY 1').map((r) => [r.record_state, r.n]),
    );
    expect(states).toEqual({ active: 737, deleted: 263, duplicate: 3, empty: 2 });
  });

  it('links re-keyed copies back to the original', () => {
    expect(stats.probableDuplicates).toEqual(
      expect.arrayContaining([
        { id: 2001, of: 1088 },
        { id: 2000, of: 1010 },
        { id: 2002, of: 1140 },
      ]),
    );
  });

  it('quarantines deductions whose company is unknown', () => {
    const rows = all<{ ref: string; n: number }>(
      db,
      "SELECT source_company_ref AS ref, COUNT(*) AS n FROM deductions WHERE record_state = 'active' AND company_id IS NULL GROUP BY 1 ORDER BY 1",
    );
    expect(rows).toEqual([
      { ref: '0', n: 8 },
      { ref: '3', n: 14 },
      { ref: 'null', n: 12 },
    ]);
  });

  it('matches every non-blank retailer name to the canonical list', () => {
    const unmatched = get<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM deduction_issues WHERE code = 'RETAILER_UNMATCHED'",
    )!.n;
    expect(unmatched).toBe(0);
  });

  it('keeps the literal source of every record', () => {
    const raw = get<{ raw_json: string }>(db, 'SELECT raw_json FROM deductions WHERE id = 1317')!.raw_json;
    expect(raw).toContain('"amount":57.0');
  });

  it('creates disputes for spreadsheet rows already in dispute', () => {
    const stages = Object.fromEntries(
      all<{ stage: string; n: number }>(
        db,
        "SELECT ds.stage, COUNT(*) AS n FROM disputes ds JOIN deductions d ON d.id = ds.deduction_id WHERE d.record_state = 'active' GROUP BY 1",
      ).map((r) => [r.stage, r.n]),
    );
    expect(stages).toEqual({ preparing: 106, submitted: 46 });
  });
});
