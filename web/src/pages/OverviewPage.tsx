import type { DashboardResponse } from '@shared/api';
import { DISPUTE_STAGE_LABELS } from '@shared/domain';
import { cn } from 'cn';
import { ArrowRight, CircleDollarSign, Clock, HandCoins, HelpCircle, Scale, Sparkles, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { PageHeader } from '@/components/common';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMoney, formatMonth, formatNumber, formatPercent, todayISO, formatDate } from '@/lib/format';
import { useDashboard } from '@/lib/queries';
import { useSession } from '@/lib/session';

type Fmt = (cents: number, compact?: boolean) => string;

function Kpi({
  label,
  value,
  sub,
  icon,
  accent,
  to,
}: {
  label: string;
  value: string;
  sub: ReactNode;
  icon: ReactNode;
  accent: string;
  to?: string;
}) {
  const body = (
    <Card className={cn('h-full gap-2 transition-shadow', to && 'hover:shadow-md')}>
      <CardHeader>
        <CardDescription className="flex items-center gap-2 font-medium text-foreground/70">
          <span className={cn('grid size-6 place-items-center rounded-md [&_svg]:size-3.5', accent)}>{icon}</span>
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

const FUNNEL_COLORS: Record<string, string> = {
  deducted: 'bg-zinc-300',
  disputable: 'bg-zinc-400',
  claimed: 'bg-violet-500',
  approved: 'bg-emerald-400',
  recovered: 'bg-emerald-600',
};

function Funnel({ data, fmt }: { data: DashboardResponse; fmt: Fmt }) {
  const max = Math.max(1, ...data.funnel.map((s) => s.cents));
  return (
    <div className="grid gap-3">
      {data.funnel.map((stage, i) => {
        const prev = i > 0 ? data.funnel[i - 1]! : null;
        return (
          <div key={stage.key} className="grid grid-cols-[9rem_1fr_7.5rem] items-center gap-3" title={stage.hint}>
            <div className="text-sm">
              <div className="font-medium">{stage.label}</div>
              <div className="text-xs text-muted-foreground">{formatNumber(stage.count)} items</div>
            </div>
            <div className="h-7 rounded-md bg-muted/60">
              <div
                className={cn('h-full rounded-md transition-all', FUNNEL_COLORS[stage.key])}
                style={{ width: `${Math.max(0.6, (stage.cents / max) * 100)}%` }}
              />
            </div>
            <div className="text-right">
              <div className="text-sm font-semibold tabular-nums">{fmt(stage.cents)}</div>
              {prev && prev.cents > 0 && (
                <div className="text-xs text-muted-foreground tabular-nums">{formatPercent(stage.cents / prev.cents)} of prev.</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Pipeline({ data, fmt }: { data: DashboardResponse; fmt: Fmt }) {
  const tones: Record<string, string> = {
    preparing: 'bg-violet-300',
    submitted: 'bg-violet-500',
    approved: 'bg-emerald-500',
    denied: 'bg-rose-400',
    closed: 'bg-zinc-400',
  };
  const max = Math.max(1, ...data.pipeline.map((s) => s.claimCents));
  return (
    <div className="grid gap-3">
      {data.pipeline.map((stage) => (
        <Link key={stage.stage} to={`/deductions?stage=${stage.stage === 'closed' ? 'closed' : stage.stage}`} className="group grid gap-1">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium group-hover:underline">
              {DISPUTE_STAGE_LABELS[stage.stage]} <span className="font-normal text-muted-foreground">· {stage.count}</span>
            </span>
            <span className="tabular-nums">
              {stage.stage === 'approved' ? (
                <>
                  {fmt(stage.approvedCents - stage.recoveredCents)} <span className="text-xs text-muted-foreground">owed</span>
                </>
              ) : stage.stage === 'closed' ? (
                <>
                  {fmt(stage.recoveredCents)} <span className="text-xs text-muted-foreground">recovered</span>
                </>
              ) : (
                <>
                  {fmt(stage.claimCents)} <span className="text-xs text-muted-foreground">claimed</span>
                </>
              )}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted">
            <div className={cn('h-full rounded-full', tones[stage.stage])} style={{ width: `${(stage.claimCents / max) * 100}%` }} />
          </div>
        </Link>
      ))}
    </div>
  );
}

const monthlyConfig = {
  deducted: { label: 'Deducted', color: 'oklch(0.82 0.01 260)' },
  recovered: { label: 'Recovered', color: 'oklch(0.6 0.15 160)' },
} satisfies ChartConfig;

function Monthly({ data, fmt }: { data: DashboardResponse; fmt: Fmt }) {
  const rows = data.monthly.map((m) => ({
    month: formatMonth(m.month),
    deducted: m.deductedCents / 100,
    recovered: m.recoveredCents / 100,
  }));
  return (
    <ChartContainer config={monthlyConfig} className="aspect-auto h-64 w-full">
      <BarChart data={rows} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmt(v * 100, true)} />
        <ChartTooltip content={<ChartTooltipContent formatter={(value, name) => `${monthlyConfig[name as keyof typeof monthlyConfig]?.label ?? name}: ${fmt(Number(value) * 100)}`} />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="deducted" fill="var(--color-deducted)" radius={[3, 3, 0, 0]} />
        <Bar dataKey="recovered" fill="var(--color-recovered)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function Aging({ data, fmt }: { data: DashboardResponse; fmt: Fmt }) {
  const max = Math.max(1, ...data.aging.map((a) => a.cents));
  return (
    <div className="grid gap-2.5">
      {data.aging.map((bucket) => (
        <div key={bucket.bucket} className="grid grid-cols-[7.5rem_1fr_6rem] items-center gap-3 text-sm">
          <span className={cn(bucket.bucket === 'unknown' && 'text-muted-foreground')}>{bucket.label}</span>
          <div className="h-2 rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', bucket.bucket === '180+' ? 'bg-rose-400' : bucket.bucket === 'unknown' ? 'bg-zinc-300' : 'bg-amber-400')}
              style={{ width: `${(bucket.cents / max) * 100}%` }}
            />
          </div>
          <span className="text-right tabular-nums">
            {fmt(bucket.cents, true)} <span className="text-xs text-muted-foreground">· {bucket.count}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function HowWeCount() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <HelpCircle /> How recovery is counted
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 text-sm">
        <dl className="grid gap-2.5">
          <div>
            <dt className="font-medium">Claimed</dt>
            <dd className="text-muted-foreground">What we asked retailers to pay back. Withdrawn disputes don't count.</dd>
          </div>
          <div>
            <dt className="font-medium">Approved</dt>
            <dd className="text-muted-foreground">What a retailer agreed to repay. Often only part of the claim.</dd>
          </div>
          <div>
            <dt className="font-medium text-emerald-700">Recovered</dt>
            <dd className="text-muted-foreground">
              Cash actually received: checks, ACH, credit memos, or repayment on a later remittance. An approval alone is not recovery; it sits in
              "awaiting payment" until money arrives.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Recovery rate</dt>
            <dd className="text-muted-foreground">
              Recovered ÷ claimed, on settled disputes only, so disputes still in flight don't drag it down.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Win rate</dt>
            <dd className="text-muted-foreground">Share of retailer decisions that approved at least part of the claim.</dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

export function OverviewPage() {
  const { data } = useDashboard();
  const { company, session } = useSession();
  const scope = company?.name ?? (session.companies.length > 1 ? `All companies (${session.companies.length})` : session.companies[0]?.name);

  if (!data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const fmt: Fmt = (cents, compact) => formatMoney(cents, data.currency, { compact });
  const k = data.kpis;
  const empty = data.funnel[0]!.count === 0;

  return (
    <div className="grid gap-5">
      <PageHeader title="Recovery overview" description={`${scope} · as of ${formatDate(todayISO())} · ${data.currency}`} actions={<HowWeCount />} />

      {data.otherCurrencies.length > 0 && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            Figures are in {data.currency}. Deductions in {data.otherCurrencies.join(', ')} aren't converted; pick a single company to see them.
          </AlertDescription>
        </Alert>
      )}

      {empty ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">No deductions have been imported for {scope} yet.</CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Kpi
              label="Recovered"
              value={fmt(k.recovered.cents)}
              icon={<CircleDollarSign />}
              accent="bg-emerald-100 text-emerald-700"
              sub={
                <>
                  <span className="font-medium text-emerald-700">{formatPercent(k.recoveryRate)}</span> of settled claims ·{' '}
                  {k.recovered.count} disputes paid
                </>
              }
            />
            <Kpi
              label="Approved, awaiting payment"
              value={fmt(k.outstanding.cents)}
              icon={<Clock />}
              accent="bg-amber-100 text-amber-700"
              sub={`${k.outstanding.count} approved disputes not fully paid`}
              to="/deductions?stage=approved"
            />
            <Kpi
              label="In active disputes"
              value={fmt(k.inDispute.cents)}
              icon={<Scale />}
              accent="bg-violet-100 text-violet-700"
              sub={
                <>
                  {k.inDispute.count} open · win rate <span className="font-medium text-foreground/80">{formatPercent(k.winRate)}</span>
                  {k.avgDaysToRecover !== null && <> · ~{k.avgDaysToRecover}d to cash</>}
                </>
              }
              to="/disputes"
            />
            <Kpi
              label="Ready to dispute"
              value={fmt(k.opportunity.cents)}
              icon={<Sparkles />}
              accent="bg-sky-100 text-sky-700"
              sub={`${k.opportunity.count} open deductions with usually-disputable reasons`}
              to="/deductions?view=recommended"
            />
          </div>

          {(k.needsAttention > 0 || k.excluded > 0) && (
            <Link
              to="/deductions?view=attention"
              className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-2.5 text-sm text-amber-900 hover:bg-amber-50"
            >
              <TriangleAlert className="size-4 shrink-0" />
              <span>
                <span className="font-medium">{formatNumber(k.needsAttention)} deductions</span> have data issues to check.{' '}
                {k.excluded > 0 && <>{k.excluded} with a missing or implausible amount are left out of these totals until fixed.</>}
              </span>
              <ArrowRight className="ml-auto size-4" />
            </Link>
          )}

          <div className="grid gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <CardHeader>
                <CardTitle>Where the money goes</CardTitle>
                <CardDescription>From what retailers deducted to cash actually back in the bank.</CardDescription>
              </CardHeader>
              <CardContent>
                <Funnel data={data} fmt={fmt} />
              </CardContent>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle>Dispute pipeline</CardTitle>
                <CardDescription>Every dispute and the stage it's in.</CardDescription>
                <CardAction>
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/disputes">
                      Board <ArrowRight />
                    </Link>
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <Pipeline data={data} fmt={fmt} />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <CardHeader>
                <CardTitle>Deducted vs. recovered, by month</CardTitle>
                <CardDescription>Deductions by deduction date; recoveries by the date the money arrived.</CardDescription>
              </CardHeader>
              <CardContent>
                <Monthly data={data} fmt={fmt} />
              </CardContent>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle>Open deductions by age</CardTitle>
                <CardDescription>Older deductions get harder to win. Retailers set dispute windows.</CardDescription>
              </CardHeader>
              <CardContent>
                <Aging data={data} fmt={fmt} />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <CardHeader>
                <CardTitle>Recovery by retailer</CardTitle>
                <CardDescription>Recovery rate is recovered ÷ claimed on settled disputes.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Retailer</TableHead>
                      <TableHead className="text-right">Deducted</TableHead>
                      <TableHead className="text-right">Open</TableHead>
                      <TableHead className="text-right">Claimed</TableHead>
                      <TableHead className="text-right">Recovered</TableHead>
                      <TableHead className="pr-4 text-right">Rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byRetailer.slice(0, 10).map((r) => (
                      <TableRow key={r.retailerId ?? 'none'}>
                        <TableCell className="pl-4 font-medium">
                          <Link className="hover:underline" to={`/deductions?retailerId=${r.retailerId ?? 'none'}`}>
                            {r.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(r.deductedCents, true)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(r.openCents, true)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(r.claimedCents, true)}</TableCell>
                        <TableCell className="text-right font-medium text-emerald-700 tabular-nums">{fmt(r.recoveredCents, true)}</TableCell>
                        <TableCell className="pr-4 text-right tabular-nums">{formatPercent(r.recoveryRate)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle>Open deductions by reason</CardTitle>
                <CardDescription>Green reasons are usually worth disputing.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2">
                {data.byReason.map((r) => {
                  const max = Math.max(1, ...data.byReason.map((x) => x.cents));
                  return (
                    <Link
                      key={r.code ?? 'none'}
                      to={`/deductions?stage=open&reasonCode=${r.code ?? 'none'}`}
                      className="group grid grid-cols-[8.5rem_1fr_5.5rem] items-center gap-3 text-sm"
                    >
                      <span className="truncate group-hover:underline">{r.label}</span>
                      <div className="h-2 rounded-full bg-muted">
                        <div
                          className={cn('h-full rounded-full', r.disputable === null ? 'bg-zinc-300' : r.disputable ? 'bg-emerald-500' : 'bg-zinc-400')}
                          style={{ width: `${(r.cents / max) * 100}%` }}
                        />
                      </div>
                      <span className="text-right tabular-nums">{fmt(r.cents, true)}</span>
                    </Link>
                  );
                })}
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <HandCoins className="size-3.5" /> Recovered counts payments received, never approvals.
            </span>
            {k.legacyClosed.count > 0 && (
              <span>
                {k.legacyClosed.count} rows marked "Complete" in the spreadsheet ({fmt(k.legacyClosed.cents, true)}) have no recorded outcome and are
                left out of rates.
              </span>
            )}
            {data.simulatedEvents > 0 && <span>Includes {formatNumber(data.simulatedEvents)} simulated demo events.</span>}
          </div>
        </>
      )}
    </div>
  );
}
