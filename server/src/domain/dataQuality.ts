import type { DataQualityResponse } from '../../../shared/api';
import { ISSUE_CODES, ISSUE_META, statusDisplay } from '../../../shared/domain';
import { all, get, type DB } from '../db/connection';
import type { ImportStats } from '../import/importer';
import { mapStatus } from '../import/normalize';
import { scopeSql, type Scope } from './context';

/** How the raw export was cleaned, limited to the records this person may see. */
export function getDataQuality(db: DB, scope: Scope): DataQualityResponse {
  const s = scopeSql(scope, 'd', { includeUnassigned: true });
  const where = s.sql;
  const params = s.params;

  const states = new Map(
    all<{ record_state: string; n: number }>(db, `SELECT record_state, COUNT(*) AS n FROM deductions d WHERE ${where} GROUP BY record_state`, params).map(
      (r) => [r.record_state, r.n],
    ),
  );
  const totals = {
    records: [...states.values()].reduce((a, b) => a + b, 0),
    active: states.get('active') ?? 0,
    deleted: states.get('deleted') ?? 0,
    duplicates: states.get('duplicate') ?? 0,
    empty: states.get('empty') ?? 0,
    unassigned: scope.canSeeUnassigned
      ? get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM deductions WHERE record_state = 'active' AND company_id IS NULL")!.n
      : 0,
    withOpenIssues: get<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM deductions d WHERE ${where} AND d.record_state = 'active' AND EXISTS (
         SELECT 1 FROM deduction_issues i WHERE i.deduction_id = d.id AND i.resolved_at IS NULL AND i.severity IN ('error', 'warning'))`,
      params,
    )!.n,
  };

  let importRun: DataQualityResponse['importRun'] = null;
  if (scope.role === 'admin') {
    const run = get<{ started_at: string; source_file: string; stats_json: string }>(db, 'SELECT * FROM import_runs ORDER BY id DESC LIMIT 1');
    if (run) {
      const stats = JSON.parse(run.stats_json) as ImportStats;
      importRun = {
        startedAt: run.started_at,
        sourceFile: run.source_file,
        rowsRead: stats.rowsRead,
        exactDuplicateRows: stats.exactDuplicateRows.length,
        uniqueIds: stats.uniqueIds,
      };
    }
  }

  const issueCounts = new Map(
    all<{ code: string; open: number; resolved: number }>(
      db,
      `SELECT i.code, SUM(i.resolved_at IS NULL) AS open, SUM(i.resolved_at IS NOT NULL) AS resolved
       FROM deduction_issues i JOIN deductions d ON d.id = i.deduction_id
       WHERE ${where} AND d.record_state = 'active' GROUP BY i.code`,
      params,
    ).map((r) => [r.code, r]),
  );
  const severityOrder = { error: 0, warning: 1, info: 2 };
  const issues = ISSUE_CODES.map((code) => ({
    code,
    label: ISSUE_META[code].label,
    severity: ISSUE_META[code].severity,
    fix: ISSUE_META[code].fix,
    open: issueCounts.get(code)?.open ?? 0,
    resolved: issueCounts.get(code)?.resolved ?? 0,
  }))
    .filter((i) => i.open + i.resolved > 0)
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.open - a.open);

  const notEmpty = `${where} AND d.record_state != 'empty'`;
  const retailerVariants = all<{ raw: string | null; retailer: string | null; count: number }>(
    db,
    `SELECT d.retailer_raw AS raw, r.name AS retailer, COUNT(*) AS count
     FROM deductions d LEFT JOIN retailers r ON r.id = d.retailer_id
     WHERE ${notEmpty} GROUP BY d.retailer_raw, r.name ORDER BY r.name IS NULL, r.name, count DESC`,
    params,
  );
  const reasonVariants = all<{ raw: string | null; code: string | null; label: string | null; count: number }>(
    db,
    `SELECT d.reason_raw AS raw, d.reason_code AS code, rs.label, COUNT(*) AS count
     FROM deductions d LEFT JOIN reasons rs ON rs.code = d.reason_code
     WHERE ${notEmpty} GROUP BY d.reason_raw, d.reason_code ORDER BY rs.label IS NULL, rs.label, count DESC`,
    params,
  );
  const statusVariants = all<{ raw: string | null; count: number }>(
    db,
    `SELECT d.source_status AS raw, COUNT(*) AS count FROM deductions d WHERE ${notEmpty} GROUP BY d.source_status ORDER BY count DESC`,
    params,
  ).map((row) => {
    const mapped = mapStatus(row.raw === 'null' ? null : row.raw);
    return { ...row, mappedTo: statusDisplay(mapped.status, mapped.resolution, mapped.disputeStage).label };
  });
  const amountFormats = all<{ format: string; count: number; example: string | null }>(
    db,
    `SELECT d.amount_format AS format, COUNT(*) AS count, MIN(d.amount_raw) AS example
     FROM deductions d WHERE ${where} GROUP BY d.amount_format ORDER BY count DESC`,
    params,
  );
  const dateFormats = all<{ format: string; count: number; example: string | null }>(
    db,
    `SELECT d.date_format AS format, COUNT(*) AS count, MIN(d.deducted_raw) AS example
     FROM deductions d WHERE ${where} GROUP BY d.date_format ORDER BY count DESC`,
    params,
  );

  const aliasCounts = new Map<string, number>();
  for (const row of all<{ field_aliases: string }>(db, `SELECT d.field_aliases FROM deductions d WHERE ${where} AND d.field_aliases IS NOT NULL`, params)) {
    for (const alias of JSON.parse(row.field_aliases) as string[]) aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
  }

  const duplicates = all<{ id: number; duplicate_of: number; amount_cents: number | null; invoice_number: string | null }>(
    db,
    `SELECT d.id, d.duplicate_of, d.amount_cents, d.invoice_number FROM deductions d
     WHERE ${where} AND d.record_state = 'duplicate' ORDER BY d.id`,
    params,
  ).map((r) => ({ id: r.id, duplicateOf: r.duplicate_of, amountCents: r.amount_cents, invoiceNumber: r.invoice_number }));

  return {
    totals,
    importRun,
    issues,
    retailerVariants,
    reasonVariants,
    statusVariants,
    amountFormats,
    dateFormats,
    fieldAliases: [...aliasCounts].map(([alias, count]) => ({ alias, count })).sort((a, b) => b.count - a.count),
    duplicates,
  };
}
