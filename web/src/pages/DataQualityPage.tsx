import type { DataQualityResponse } from '@shared/api';
import { cn } from 'cn';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { PageHeader, SEVERITY_META, SeverityIcon } from '@/components/common';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatMoney, formatNumber, showWhitespace } from '@/lib/format';
import { useDataQuality, useDeductionDrawer } from '@/lib/queries';
import { useSession } from '@/lib/session';

function Step({ value, label, tone, to }: { value: number; label: string; tone?: string; to?: string }) {
  const body = (
    <div className={cn('rounded-lg border bg-card px-3 py-2', to && 'hover:border-foreground/20')}>
      <div className={cn('text-lg font-semibold tabular-nums', tone)}>{formatNumber(value)}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function Arrow() {
  return <ArrowRight className="size-4 shrink-0 text-muted-foreground/60" />;
}

function ImportSummary({ data, isAdmin }: { data: DataQualityResponse; isAdmin: boolean }) {
  const t = data.totals;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{isAdmin && data.importRun ? `What happened to the ${formatNumber(data.importRun.rowsRead)} rows in ${data.importRun.sourceFile}` : 'Records for your companies'}</CardTitle>
        <CardDescription>
          Nothing is thrown away: every row is kept with its original JSON, and only <span className="font-medium text-foreground">active</span> rows
          reach lists and totals.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {isAdmin && data.importRun && (
          <>
            <Step value={data.importRun.rowsRead} label="rows in the export" />
            <Arrow />
            <Step value={data.importRun.exactDuplicateRows} label="exact repeats dropped" tone="text-muted-foreground" />
            <Arrow />
          </>
        )}
        <Step value={t.records} label="unique deductions" />
        <Arrow />
        <div className="flex flex-wrap gap-2">
          <Step value={t.deleted} label="deleted in source" tone="text-muted-foreground" />
          <Step value={t.duplicates} label="same deduction, new id" tone="text-muted-foreground" />
          <Step value={t.empty} label="empty rows" tone="text-muted-foreground" />
        </div>
        <Arrow />
        <Step value={t.active} label="active" tone="text-emerald-700" to="/deductions?view=all" />
        <Arrow />
        <Step value={t.withOpenIssues} label="still need a check" tone="text-amber-700" to="/deductions?view=attention" />
        {isAdmin && t.unassigned > 0 && (
          <>
            <span className="mx-1 text-xs text-muted-foreground">and</span>
            <Step value={t.unassigned} label="unknown company (admin queue)" tone="text-rose-600" to="/unassigned" />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Variants<T extends { count: number }>({
  rows,
  groupOf,
  rawOf,
  missingLabel,
}: {
  rows: T[];
  groupOf: (row: T) => string | null;
  rawOf: (row: T) => string | null;
  missingLabel: string;
}) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = groupOf(row) ?? missingLabel;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const ordered = [...groups.entries()].sort(([a, ar], [b, br]) => {
    if (a === missingLabel) return 1;
    if (b === missingLabel) return -1;
    return br.reduce((s, r) => s + r.count, 0) - ar.reduce((s, r) => s + r.count, 0);
  });
  return (
    <div className="grid gap-3">
      {ordered.map(([group, items]) => (
        <div key={group} className="grid grid-cols-[11rem_1fr] items-start gap-4 border-b pb-3 last:border-0">
          <div>
            <div className={cn('text-sm font-medium', group === missingLabel && 'text-rose-600')}>{group}</div>
            <div className="text-xs text-muted-foreground">
              {items.length} spelling{items.length === 1 ? '' : 's'} · {formatNumber(items.reduce((s, r) => s + r.count, 0))} rows
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {items
              .sort((a, b) => b.count - a.count)
              .map((row, i) => {
                const raw = rawOf(row);
                return (
                  <span key={i} className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">
                    {raw === null ? <span className="text-muted-foreground italic">null</span> : raw === '' ? '""' : `"${showWhitespace(raw)}"`}
                    <span className="font-sans text-muted-foreground">×{row.count}</span>
                  </span>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SimpleTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {head.map((h, i) => (
            <TableHead key={h} className={cn(i === head.length - 1 && 'text-right')}>
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

export function DataQualityPage() {
  const { data } = useDataQuality();
  const { session, companyId } = useSession();
  const drawer = useDeductionDrawer();
  const isAdmin = session.canSeeUnassigned && companyId === undefined;

  if (!data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const spellings = data.retailerVariants.length;
  const canonical = new Set(data.retailerVariants.map((r) => r.retailer).filter(Boolean)).size;

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Data quality"
        description="How the raw export was cleaned, and what still needs a person. Fixing a record in its drawer resolves the issue here."
      />

      <ImportSummary data={data} isAdmin={isAdmin} />

      <Card>
        <CardHeader>
          <CardTitle>Issues found</CardTitle>
          <CardDescription>
            <span className={SEVERITY_META.error.className}>Blocking</span> issues keep a deduction out of disputes (and out of totals for amounts).{' '}
            <span className={SEVERITY_META.warning.className}>Check</span> issues need a human to confirm or correct.{' '}
            <span className={SEVERITY_META.info.className}>FYI</span> issues explain an assumption.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Issue</TableHead>
                <TableHead>What to do</TableHead>
                <TableHead className="text-right">Resolved</TableHead>
                <TableHead className="pr-4 text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.issues.map((issue) => (
                <TableRow key={issue.code}>
                  <TableCell className="pl-4">
                    <span className="flex items-center gap-2 font-medium">
                      <SeverityIcon severity={issue.severity} />
                      {issue.label}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-md text-sm whitespace-normal text-muted-foreground">{issue.fix}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {issue.resolved > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <CheckCircle2 className="size-3.5 text-emerald-600" />
                        {issue.resolved}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
                    {issue.open > 0 ? (
                      <Link
                        className="font-semibold underline-offset-2 hover:underline"
                        to={issue.code === 'COMPANY_UNKNOWN' ? '/unassigned' : `/deductions?view=all&issue=${issue.code}&sort=amount`}
                      >
                        {formatNumber(issue.open)}
                      </Link>
                    ) : (
                      <span className="text-emerald-700">0</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How values were normalized</CardTitle>
          <CardDescription>
            {spellings} retailer spellings matched to {canonical} retailers from retailers.json. Quotes show the export's exact text (⇥ = tab, ␣ =
            stray space).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="retailers">
            <TabsList className="mb-4">
              <TabsTrigger value="retailers">Retailers</TabsTrigger>
              <TabsTrigger value="reasons">Reasons</TabsTrigger>
              <TabsTrigger value="statuses">Statuses</TabsTrigger>
              <TabsTrigger value="amounts">Amounts</TabsTrigger>
              <TabsTrigger value="dates">Dates</TabsTrigger>
              <TabsTrigger value="fields">Field names</TabsTrigger>
              <TabsTrigger value="duplicates">Duplicates</TabsTrigger>
            </TabsList>
            <TabsContent value="retailers">
              <Variants rows={data.retailerVariants} groupOf={(r) => r.retailer} rawOf={(r) => r.raw} missingLabel="No retailer (needs a person)" />
            </TabsContent>
            <TabsContent value="reasons">
              <Variants
                rows={data.reasonVariants}
                groupOf={(r) => (r.label ? `${r.label} (${r.code})` : null)}
                rawOf={(r) => r.raw}
                missingLabel="Unclassified (needs a person)"
              />
            </TabsContent>
            <TabsContent value="statuses">
              <SimpleTable head={['Spreadsheet status', 'Mapped to', 'Rows']}>
                {data.statusVariants.map((s) => (
                  <TableRow key={String(s.raw)}>
                    <TableCell className="font-mono text-xs">{s.raw === null || s.raw === 'null' ? 'null' : `"${showWhitespace(s.raw)}"`}</TableCell>
                    <TableCell>{s.mappedTo}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.count}</TableCell>
                  </TableRow>
                ))}
              </SimpleTable>
              <p className="mt-3 text-xs text-muted-foreground">
                A bare "dispute" is assumed not filed yet. "Complete" carries no outcome or amount, so it's kept out of recovery rates until someone
                records what happened.
              </p>
            </TabsContent>
            <TabsContent value="amounts">
              <SimpleTable head={['Shape in the export', 'Example', 'Rows']}>
                {data.amountFormats.map((f) => (
                  <TableRow key={f.format}>
                    <TableCell>{f.format}</TableCell>
                    <TableCell className="font-mono text-xs">{f.example ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.count}</TableCell>
                  </TableRow>
                ))}
              </SimpleTable>
              <p className="mt-3 text-xs text-muted-foreground">
                Decimals (even <span className="font-mono">57.0</span>) are dollars. Bare whole numbers like{' '}
                <span className="font-mono">69895</span> only make sense as cents, so they're read as{' '}
                {formatMoney(69895)} and flagged for a spot check. Anything over $100k is treated as a placeholder or typo.
              </p>
            </TabsContent>
            <TabsContent value="dates">
              <SimpleTable head={['Format', 'Example', 'Rows']}>
                {data.dateFormats.map((f) => (
                  <TableRow key={f.format}>
                    <TableCell>{f.format}</TableCell>
                    <TableCell className="font-mono text-xs">{f.example ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.count}</TableCell>
                  </TableRow>
                ))}
              </SimpleTable>
              <p className="mt-3 text-xs text-muted-foreground">
                Slash dates are month-first (91 have a day above 12); dash dates are day-first (45 have a day above 12). Dates after today are flagged.
              </p>
            </TabsContent>
            <TabsContent value="fields">
              <SimpleTable head={['Field in the export', 'Rows']}>
                {data.fieldAliases.map((f) => (
                  <TableRow key={f.alias}>
                    <TableCell className="font-mono text-xs">{f.alias}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.count}</TableCell>
                  </TableRow>
                ))}
              </SimpleTable>
            </TabsContent>
            <TabsContent value="duplicates">
              <SimpleTable head={['Hidden row', 'Same deduction as', 'Invoice', 'Amount']}>
                {data.duplicates.map((d) => (
                  <TableRow key={d.id} className="cursor-pointer" onClick={() => drawer.open(d.id)}>
                    <TableCell className="font-mono text-xs">#{d.id}</TableCell>
                    <TableCell className="font-mono text-xs">#{d.duplicateOf}</TableCell>
                    <TableCell className="font-mono text-xs">{d.invoiceNumber}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(d.amountCents)}</TableCell>
                  </TableRow>
                ))}
              </SimpleTable>
              <p className="mt-3 text-xs text-muted-foreground">
                Same company, retailer, invoice, date and reason, with amounts within a cent. The lowest id is kept. Rows that repeat an id verbatim are
                dropped before this step.
              </p>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
