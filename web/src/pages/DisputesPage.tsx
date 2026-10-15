import type { BoardItem } from '@shared/api';
import {
  actionForStageMove,
  DISPUTE_STAGE_DESCRIPTIONS,
  DISPUTE_STAGE_LABELS,
  DISPUTE_STAGES,
  RESOLUTION_LABELS,
  type DisputeStage,
} from '@shared/domain';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { cn } from 'cn';
import { GripVertical, Hourglass, Repeat, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { PageHeader, UserAvatar } from '@/components/common';
import { ActionDialog, type ActionTarget, type PendingAction } from '@/components/deduction/ActionDialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { formatMoney } from '@/lib/format';
import { useBoard, useDeductionDrawer } from '@/lib/queries';
import { useSession } from '@/lib/session';

const CLOSED_LIMIT = 25;

const COLUMN_ACCENT: Record<DisputeStage, string> = {
  preparing: 'bg-violet-300',
  submitted: 'bg-violet-500',
  approved: 'bg-emerald-500',
  denied: 'bg-rose-400',
  closed: 'bg-zinc-400',
};

function toTarget(item: BoardItem): ActionTarget {
  return {
    id: item.id,
    amountCents: item.amountCents,
    currency: item.currency,
    retailerName: item.retailerName,
    disputable: item.disputable,
    reasonLabel: item.reasonLabel,
    dispute: item.dispute,
  };
}

function CardBody({ item, dragging }: { item: BoardItem; dragging?: boolean }) {
  const fmt = (cents: number) => formatMoney(cents, item.currency);
  const d = item.dispute;
  const approved = d.approvedCents ?? 0;
  return (
    <div
      className={cn(
        'group rounded-lg border bg-card p-3 text-sm shadow-xs transition-shadow hover:shadow-md',
        dragging && 'rotate-1 shadow-xl ring-2 ring-violet-400',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{item.retailerName ?? 'Unknown retailer'}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            #{item.id} · {item.invoiceNumber ?? 'no invoice'}
          </div>
        </div>
        <div className="text-right">
          <div className="font-semibold tabular-nums">{fmt(d.claimCents)}</div>
          <div className="text-[11px] text-muted-foreground">{item.reasonLabel ?? 'Unclassified'}</div>
        </div>
      </div>

      {(d.stage === 'approved' || (d.stage === 'closed' && d.recoveredCents > 0)) && (
        <div className="mt-2.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${Math.min(100, (d.recoveredCents / Math.max(1, d.stage === 'approved' ? approved : d.claimCents)) * 100)}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
            <span className="text-emerald-700">{fmt(d.recoveredCents)} received</span>
            <span>{d.stage === 'approved' ? `of ${fmt(approved)} approved` : `of ${fmt(d.claimCents)}`}</span>
          </div>
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        {item.assignee ? <UserAvatar user={item.assignee} className="size-5" /> : <span className="size-5 rounded-full border border-dashed" />}
        {item.claimReference && <span className="truncate font-mono">{item.claimReference}</span>}
        {item.appealCount > 0 && (
          <span className="inline-flex items-center gap-0.5 text-amber-700">
            <Repeat className="size-3" /> appeal {item.appealCount}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-0.5 whitespace-nowrap">
          {d.stage === 'closed' ? (
            item.resolution && RESOLUTION_LABELS[item.resolution]
          ) : (
            <>
              <Hourglass className="size-3" />
              {item.daysInStage}d
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function DraggableCard({ item, onOpen }: { item: BoardItem; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: item.id, disabled: item.dispute.stage === 'closed' });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      className={cn('relative cursor-grab touch-none active:cursor-grabbing', isDragging && 'opacity-30', item.dispute.stage === 'closed' && 'cursor-pointer')}
    >
      {item.dispute.stage !== 'closed' && (
        <GripVertical className="absolute top-3 -left-0.5 size-3.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60" />
      )}
      <CardBody item={item} />
    </div>
  );
}

function Column({
  stage,
  items,
  total,
  dragFrom,
  children,
}: {
  stage: DisputeStage;
  items: BoardItem[];
  total: number;
  dragFrom: DisputeStage | null;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const legal = dragFrom !== null && actionForStageMove(dragFrom, stage) !== null;
  const currency = items[0]?.currency ?? 'USD';
  const sum = items.reduce((acc, i) => {
    if (stage === 'approved') return acc + Math.max(0, (i.dispute.approvedCents ?? 0) - i.dispute.recoveredCents);
    if (stage === 'closed') return acc + i.dispute.recoveredCents;
    return acc + i.dispute.claimCents;
  }, 0);
  const sumLabel = stage === 'approved' ? 'owed' : stage === 'closed' ? 'recovered' : 'claimed';

  return (
    <div className="flex min-w-[13rem] flex-1 flex-col">
      <div className="mb-2 px-1">
        <div className="flex items-center gap-2">
          <span className={cn('size-2 rounded-full', COLUMN_ACCENT[stage])} />
          <span className="text-sm font-semibold">{DISPUTE_STAGE_LABELS[stage]}</span>
          <span className="text-xs text-muted-foreground">{total}</span>
          <span className="ml-auto text-xs tabular-nums">
            {formatMoney(sum, currency, { compact: true })} <span className="text-muted-foreground">{sumLabel}</span>
          </span>
        </div>
        <p className="mt-0.5 line-clamp-2 min-h-8 text-[11px] leading-4 text-muted-foreground">{DISPUTE_STAGE_DESCRIPTIONS[stage]}</p>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex flex-1 flex-col gap-2 rounded-xl bg-muted/50 p-2 transition-colors',
          dragFrom !== null && dragFrom !== stage && (legal ? 'bg-violet-50/80 outline-2 -outline-offset-2 outline-violet-300 outline-dashed' : 'opacity-40'),
          isOver && legal && 'bg-violet-100 outline-violet-500',
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function DisputesPage() {
  const board = useBoard();
  const drawer = useDeductionDrawer();
  const { session } = useSession();
  const [search, setSearch] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [dragging, setDragging] = useState<BoardItem | null>(null);
  const [pending, setPending] = useState<{ target: ActionTarget; action: PendingAction } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (board.data?.items ?? []).filter((item) => {
      if (onlyMine && item.assignee?.id !== session.user.id) return false;
      if (!q) return true;
      return [item.retailerName, item.invoiceNumber, item.claimReference, String(item.id)].some((v) => v?.toLowerCase().includes(q));
    });
  }, [board.data, search, onlyMine, session.user.id]);

  const onDragStart = (event: DragStartEvent) => setDragging(items.find((i) => i.id === Number(event.active.id)) ?? null);

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const item = items.find((i) => i.id === Number(event.active.id));
    const to = event.over?.id as DisputeStage | undefined;
    if (!item || !to || to === item.dispute.stage) return;
    const from = item.dispute.stage;
    const action = actionForStageMove(from, to);
    if (!action) {
      toast.error(`A dispute can't go from ${DISPUTE_STAGE_LABELS[from]} to ${DISPUTE_STAGE_LABELS[to]}.`, {
        description:
          from === 'preparing'
            ? 'File it with the retailer first (Submitted).'
            : from === 'submitted'
              ? 'Record what the retailer decided: Approved or Denied.'
              : from === 'approved'
                ? 'Record payments as they arrive; it closes automatically when paid in full.'
                : 'Appeal it (back to Preparing) or close it.',
      });
      return;
    }
    setPending({
      target: toTarget(item),
      action: { kind: 'dispute', action, decision: to === 'denied' ? 'denied' : to === 'approved' ? 'approved' : undefined },
    });
  };

  if (!board.data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-8 w-64" />
        <div className="flex gap-3">
          {DISPUTE_STAGES.map((s) => (
            <Skeleton key={s} className="h-96 flex-1" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Disputes"
        description="Biggest claims first. Drag a card to move it forward: each move asks for what that stage needs, and the server rejects anything out of order."
        actions={
          <>
            <div className="flex items-center gap-2">
              <Switch id="mine" checked={onlyMine} onCheckedChange={setOnlyMine} />
              <Label htmlFor="mine" className="text-sm font-normal">
                Only mine
              </Label>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Retailer, invoice, claim #" className="w-56 pl-8" />
            </div>
          </>
        }
      />

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className="flex gap-3 overflow-x-auto pb-4">
          {DISPUTE_STAGES.map((stage) => {
            // Biggest dollars first; settled disputes newest first.
            const column = items
              .filter((i) => i.dispute.stage === stage)
              .sort((a, b) =>
                stage === 'closed'
                  ? (b.closedOn ?? b.stageEnteredAt).localeCompare(a.closedOn ?? a.stageEnteredAt)
                  : b.dispute.claimCents - a.dispute.claimCents,
              );
            const shown = stage === 'closed' ? column.slice(0, CLOSED_LIMIT) : column;
            return (
              <Column key={stage} stage={stage} items={column} total={column.length} dragFrom={dragging?.dispute.stage ?? null}>
                {shown.map((item) => (
                  <DraggableCard key={item.id} item={item} onOpen={() => drawer.open(item.id)} />
                ))}
                {column.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">Nothing here</p>}
                {stage === 'closed' && column.length > CLOSED_LIMIT && (
                  <Link to="/deductions?stage=closed" className="py-2 text-center text-xs text-muted-foreground hover:underline">
                    + {column.length - CLOSED_LIMIT} more closed
                  </Link>
                )}
              </Column>
            );
          })}
        </div>
        <DragOverlay dropAnimation={null}>{dragging && <CardBody item={dragging} dragging />}</DragOverlay>
      </DndContext>

      <ActionDialog target={pending?.target ?? null} pending={pending?.action ?? null} onClose={() => setPending(null)} />
    </div>
  );
}
