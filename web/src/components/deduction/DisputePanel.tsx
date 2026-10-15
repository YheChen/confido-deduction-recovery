import type { DisputeDetail } from '@shared/api';
import { DISPUTE_STAGE_DESCRIPTIONS, PAYMENT_METHOD_LABELS, RESOLUTION_LABELS } from '@shared/domain';
import { cn } from 'cn';
import { Check, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDate, formatMoney } from '@/lib/format';

const STEPS = [
  { key: 'preparing', label: 'Preparing' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'decision', label: 'Decision' },
  { key: 'closed', label: 'Settled' },
] as const;

function stepIndex(stage: DisputeDetail['stage']): number {
  switch (stage) {
    case 'preparing':
      return 0;
    case 'submitted':
      return 1;
    case 'approved':
    case 'denied':
      return 2;
    case 'closed':
      return 3;
  }
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="size-3" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{hint}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className={cn('text-base font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

export function DisputePanel({ dispute, currency }: { dispute: DisputeDetail; currency: string }) {
  const current = stepIndex(dispute.stage);
  const fmt = (cents: number | null) => formatMoney(cents ?? 0, currency);
  const recoveredPct = dispute.claimCents ? Math.min(100, (dispute.recoveredCents / dispute.claimCents) * 100) : 0;
  const approvedPct = dispute.claimCents && dispute.approvedCents ? Math.min(100, (dispute.approvedCents / dispute.claimCents) * 100) : 0;
  const decisionLabel =
    dispute.stage === 'denied' || dispute.outcome === 'denied'
      ? 'Denied'
      : dispute.approvedCents !== null && dispute.approvedCents < dispute.claimCents
        ? 'Partly approved'
        : dispute.approvedCents !== null
          ? 'Approved'
          : 'Decision';

  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Dispute</h3>
          <p className="text-xs text-muted-foreground">{DISPUTE_STAGE_DESCRIPTIONS[dispute.stage]}</p>
        </div>
        {dispute.outcome && (
          <span className="text-xs font-medium text-muted-foreground">{RESOLUTION_LABELS[dispute.outcome]}</span>
        )}
      </div>

      <ol className="flex items-center gap-2 px-4 pt-4">
        {STEPS.map((step, i) => {
          const done = i < current || dispute.stage === 'closed';
          const active = i === current && dispute.stage !== 'closed';
          const label = step.key === 'decision' ? decisionLabel : step.label;
          const denied = step.key === 'decision' && decisionLabel === 'Denied' && i <= current;
          return (
            <li key={step.key} className="flex flex-1 items-center gap-2">
              <span
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold',
                  done && !denied && 'border-emerald-600 bg-emerald-600 text-white',
                  denied && 'border-rose-500 bg-rose-500 text-white',
                  active && !denied && 'border-violet-600 bg-violet-50 text-violet-700',
                  !done && !active && 'text-muted-foreground',
                )}
              >
                {done && !denied ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn('text-xs whitespace-nowrap', active || done ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
              {i < STEPS.length - 1 && <span className={cn('h-px flex-1', done ? 'bg-emerald-600/50' : 'bg-border')} />}
            </li>
          );
        })}
      </ol>

      <div className="grid grid-cols-4 gap-3 px-4 pt-4">
        <Stat label="Claimed" value={fmt(dispute.claimCents)} />
        <Stat label="Approved" value={dispute.approvedCents === null ? '—' : fmt(dispute.approvedCents)} />
        <Stat
          label="Recovered"
          value={fmt(dispute.recoveredCents)}
          tone="text-emerald-700"
          hint="Money actually received. Approval alone doesn't count."
        />
        {dispute.stage === 'closed' ? (
          <Stat label="Written off" value={fmt(dispute.writtenOffCents)} tone={dispute.writtenOffCents ? 'text-rose-600' : undefined} />
        ) : (
          <Stat label="Outstanding" value={fmt(dispute.outstandingCents)} tone={dispute.outstandingCents ? 'text-amber-700' : undefined} />
        )}
      </div>

      <div className="px-4 pt-3">
        <div className="relative h-2 overflow-hidden rounded-full bg-muted">
          <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-200" style={{ width: `${approvedPct}%` }} />
          <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-600" style={{ width: `${recoveredPct}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
          <span>{recoveredPct.toFixed(0)}% of the claim recovered</span>
          {approvedPct > 0 && approvedPct < 100 && <span>{approvedPct.toFixed(0)}% approved</span>}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Claim ref</dt>
          <dd className="font-mono text-xs">{dispute.claimReference ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Submitted</dt>
          <dd>{dispute.submittedOn ? formatDate(dispute.submittedOn) : dispute.stage === 'preparing' ? 'Not yet' : 'Unknown (legacy)'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Decided</dt>
          <dd>{formatDate(dispute.decidedOn)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{dispute.appealCount ? 'Appeals' : 'Closed'}</dt>
          <dd>{dispute.appealCount ? dispute.appealCount : formatDate(dispute.closedOn)}</dd>
        </div>
      </dl>

      {dispute.recoveries.length > 0 && (
        <div className="border-t px-4 py-3">
          <h4 className="mb-2 text-xs font-medium text-muted-foreground">Payments received</h4>
          <ul className="grid gap-1.5 text-sm">
            {dispute.recoveries.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">{formatDate(r.receivedOn, { short: true })}</span>
                  <span>{PAYMENT_METHOD_LABELS[r.method]}</span>
                  {r.reference && <span className="truncate font-mono text-xs text-muted-foreground">{r.reference}</span>}
                </span>
                <span className="font-medium text-emerald-700 tabular-nums">+{fmt(r.amountCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {dispute.legacyStageInferred && dispute.stage === 'preparing' && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          The spreadsheet only said "dispute", so this was assumed not to be filed yet.
        </p>
      )}
    </section>
  );
}
