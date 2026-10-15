import type { DeductionDetail } from '@shared/api';
import {
  DEDUCTION_ACTION_LABELS,
  DISPUTE_ACTION_LABELS,
  type DeductionAction,
  type DisputeAction,
} from '@shared/domain';
import { cn } from 'cn';
import { ChevronDown, ChevronRight, CircleSlash, Copy, Sparkles, StickyNote } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Money, StatusBadge } from '@/components/common';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useDeduction, useDeductionDrawer, useDeductionWrite } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { ActionDialog, INSTANT_ACTIONS, targetFromDetail, type PendingAction } from './ActionDialog';
import { ActivityPanel } from './ActivityPanel';
import { DetailsPanel } from './DetailsPanel';
import { DisputePanel } from './DisputePanel';
import { IssuesPanel } from './IssuesPanel';

/** Which buttons get top billing; everything else goes in "More". */
const PRIMARY_DEDUCTION: DeductionAction[] = ['open_dispute', 'start_review', 'ops_returned', 'reopen'];
const PRIMARY_DISPUTE: DisputeAction[] = ['submit', 'record_decision', 'record_payment', 'appeal'];

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function NextSteps({ d, onPick }: { d: DeductionDetail; onPick: (p: PendingAction) => void }) {
  const write = useDeductionWrite();
  const blocked = d.disputeBlockers.length > 0;
  const disputeActions = (d.disputeDetail?.availableActions ?? []).filter((a) => !(a === 'submit' && blocked));
  const deductionActions = d.availableActions
    .filter((a) => !(a === 'open_dispute' && blocked))
    // When the deduction is worth fighting, make "Open dispute" the primary button.
    .sort((a, b) => (d.recommended ? Number(b === 'open_dispute') - Number(a === 'open_dispute') : 0));
  const showBlockers = blocked && (d.availableActions.includes('open_dispute') || d.disputeDetail?.stage === 'preparing');

  const run = (action: DeductionAction) => {
    if (INSTANT_ACTIONS.includes(action)) {
      write.mutate({ run: () => api.deductionAction(d.id, action), success: DEDUCTION_ACTION_LABELS[action] });
    } else {
      onPick({ kind: 'deduction', action });
    }
  };

  const primary: ReactNode[] = [];
  const more: ReactNode[] = [];
  for (const action of disputeActions) {
    const button = (
      <Button
        key={action}
        size="sm"
        variant={primary.length === 0 ? 'default' : 'outline'}
        onClick={() => onPick({ kind: 'dispute', action })}
      >
        {DISPUTE_ACTION_LABELS[action]}
      </Button>
    );
    if (PRIMARY_DISPUTE.includes(action)) primary.push(button);
    else
      more.push(
        <DropdownMenuItem key={action} variant={action === 'withdraw' ? 'destructive' : 'default'} onClick={() => onPick({ kind: 'dispute', action })}>
          {DISPUTE_ACTION_LABELS[action]}
        </DropdownMenuItem>,
      );
  }
  for (const action of deductionActions) {
    if (PRIMARY_DEDUCTION.includes(action)) {
      primary.push(
        <Button
          key={action}
          size="sm"
          variant={primary.length === 0 ? 'default' : 'outline'}
          disabled={write.isPending}
          onClick={() => run(action)}
        >
          {action === 'open_dispute' && <Sparkles />}
          {DEDUCTION_ACTION_LABELS[action]}
        </Button>,
      );
    } else {
      more.push(
        <DropdownMenuItem key={action} onClick={() => run(action)}>
          {DEDUCTION_ACTION_LABELS[action]}
        </DropdownMenuItem>,
      );
    }
  }

  if (primary.length === 0 && more.length === 0 && !showBlockers) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleSlash className="size-4" />
        {d.recordState !== 'active' ? 'Read-only record.' : 'Nothing left to do on this deduction.'}
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {showBlockers && (
        <Alert className="border-amber-200 bg-amber-50/60">
          <AlertTitle className="text-amber-900">Fix the data before {d.disputeDetail ? 'filing the claim' : 'disputing'}</AlertTitle>
          <AlertDescription className="text-amber-900/80">{d.disputeBlockers.join(' ')}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {primary}
        {more.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                More <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{more}</DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function AssignCompany({ d }: { d: DeductionDetail }) {
  const { session } = useSession();
  const write = useDeductionWrite();
  if (!session.canSeeUnassigned || d.companyId !== null || d.recordState !== 'active') return null;
  return (
    <Alert className="border-rose-200 bg-rose-50/50">
      <AlertTitle>Unknown company</AlertTitle>
      <AlertDescription className="grid gap-2">
        <span>
          The export says <span className="font-mono">company_id {d.sourceCompanyRef ?? 'missing'}</span>, which isn't one of our companies. Only
          admins can see it until it's assigned.
        </span>
        <Select onValueChange={(v) => write.mutate({ run: () => api.assignCompany(d.id, Number(v)), success: 'Assigned to company' })}>
          <SelectTrigger className="w-64 bg-background">
            <SelectValue placeholder="Assign to company…" />
          </SelectTrigger>
          <SelectContent>
            {session.companies
              .filter((c) => c.isActive)
              .map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </AlertDescription>
    </Alert>
  );
}

function SourceRecord({ d }: { d: DeductionDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground">
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        Original export row
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100">
          {JSON.stringify(d.raw, null, 2)}
        </pre>
        <p className="mt-1 text-xs text-muted-foreground">
          Spreadsheet status: <span className="font-mono">{d.sourceStatus ?? '(none)'}</span>
          {d.ocrConfidence !== null && <> · OCR confidence {Math.round(d.ocrConfidence * 100)}%</>}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DrawerBody({ d }: { d: DeductionDetail }) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const { open } = useDeductionDrawer();

  return (
    <>
      <div className="border-b px-6 pt-5 pb-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">#{d.id}</span>
          <span>·</span>
          <span>{d.companyName ?? 'No company'}</span>
          {d.recommended && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
              <Sparkles className="size-3" /> Recommended to dispute
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <SheetTitle className="truncate text-xl font-semibold">{d.retailerName ?? 'Unknown retailer'}</SheetTitle>
            <SheetDescription className="mt-0.5">
              {d.reasonLabel ?? 'Unclassified reason'} · {d.invoiceNumber ?? 'no invoice #'} · {formatDate(d.deductedOn)}
            </SheetDescription>
          </div>
          <div className="text-right">
            <Money cents={d.amountCents} currency={d.currency} flag={d.amountFlag} className="text-xl font-semibold" />
            <div className="mt-1">
              <StatusBadge status={d.status} resolution={d.resolution} stage={d.disputeDetail?.stage} />
            </div>
          </div>
        </div>
        {d.recordState !== 'active' && (
          <Alert className="mt-3">
            <Copy />
            <AlertTitle>
              {d.recordState === 'duplicate'
                ? `Duplicate of #${d.duplicateOf}`
                : d.recordState === 'deleted'
                  ? 'Deleted in the source system'
                  : 'Empty row in the export'}
            </AlertTitle>
            <AlertDescription>
              Kept for the audit trail, but excluded from every list and total.
              {d.duplicateOf && (
                <Button variant="link" className="h-auto p-0" onClick={() => open(d.duplicateOf!)}>
                  Open #{d.duplicateOf}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {d.note && (
          <p className="mt-3 flex items-center gap-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
            <StickyNote className="size-3.5" /> Spreadsheet note: “{d.note}”
          </p>
        )}
        <div className="mt-4">
          <NextSteps d={d} onPick={setPending} />
        </div>
      </div>

      <div className="grid gap-7 overflow-y-auto px-6 py-5">
        <AssignCompany d={d} />
        {d.disputeDetail && <DisputePanel dispute={d.disputeDetail} currency={d.currency} />}
        <Section title="Details">
          <DetailsPanel d={d} />
        </Section>
        <Section
          title="Data issues"
          aside={
            d.openErrors + d.openWarnings > 0 && (
              <span className="text-xs text-muted-foreground">{d.openErrors + d.openWarnings} to check</span>
            )
          }
        >
          <IssuesPanel d={d} />
        </Section>
        {d.duplicates.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Also exported as {d.duplicates.map((id) => `#${id}`).join(', ')} (hidden as duplicate{d.duplicates.length > 1 ? 's' : ''}).
          </p>
        )}
        <Section title="Activity">
          <ActivityPanel d={d} />
        </Section>
        <SourceRecord d={d} />
      </div>

      <ActionDialog target={pending ? targetFromDetail({ ...d, dispute: d.disputeDetail }) : null} pending={pending} onClose={() => setPending(null)} />
    </>
  );
}

export function DeductionDrawer() {
  const { openId, close } = useDeductionDrawer();
  const query = useDeduction(openId);
  return (
    <Sheet open={openId !== undefined} onOpenChange={(o) => !o && close()}>
      <SheetContent className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[44rem]" aria-describedby={undefined}>
        {query.data && query.data.id === openId ? (
          <DrawerBody d={query.data} />
        ) : query.isError ? (
          <div className="p-6">
            <SheetTitle>Not available</SheetTitle>
            <p className="mt-2 text-sm text-muted-foreground">{query.error.message}</p>
          </div>
        ) : (
          <div className="grid gap-3 p-6">
            <SheetTitle className="sr-only">Loading deduction</SheetTitle>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="mt-6 h-40 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
