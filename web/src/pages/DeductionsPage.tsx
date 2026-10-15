import type { DeductionListItem } from '@shared/api';
import { ISSUE_META, STAGE_FILTERS, STAGE_FILTER_LABELS, type DeductionAction, type IssueCode } from '@shared/domain';
import { cn } from 'cn';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Inbox, Search, Sparkles, StickyNote, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, IssueCount, Money, PageHeader, StatusBadge, UserAvatar } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatNumber, showWhitespace } from '@/lib/format';
import { useDeductionDrawer, useDeductions, useInvalidateWorkspace, useMeta } from '@/lib/queries';
import { useSession } from '@/lib/session';

const ANY = '__any__';
const PAGE_SIZE = 50;

const VIEWS = [
  { value: 'recommended', label: 'Ready to dispute', hint: 'Open, clean, and the reason is usually worth disputing. Biggest first.' },
  { value: 'attention', label: 'Needs attention', hint: 'Data problems an analyst should fix or confirm.' },
  { value: 'mine', label: 'My queue', hint: 'Assigned to you.' },
  { value: 'all', label: 'All', hint: 'Everything active.' },
] as const;

type SortKey = 'id' | 'amount' | 'date' | 'retailer' | 'issues';

function SortHeader({
  label,
  sortKey,
  sort,
  order,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: string;
  order: string;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort === sortKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground')}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {active && (order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </TableHead>
  );
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  children,
  className,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? null : v)}>
      <SelectTrigger className={cn('w-44', value && 'border-foreground/30 bg-muted/40', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{placeholder}</SelectItem>
        <SelectSeparator />
        {children}
      </SelectContent>
    </Select>
  );
}

function NoteDialog({
  open,
  title,
  description,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={note.trim().length < 3} onClick={() => onConfirm(note.trim())}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeductionsPage({ mode = 'normal' }: { mode?: 'normal' | 'unassigned' }) {
  const [params, setParams] = useSearchParams();
  const { session, companyId } = useSession();
  const meta = useMeta();
  const drawer = useDeductionDrawer();
  const invalidate = useInvalidateWorkspace();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [noteAction, setNoteAction] = useState<DeductionAction | null>(null);
  const [search, setSearch] = useState(params.get('q') ?? '');

  const unassignedMode = mode === 'unassigned';
  const hasFilters = ['stage', 'retailerId', 'reasonCode', 'assigneeId', 'issue', 'q'].some((k) => params.get(k));
  const view = unassignedMode ? 'unassigned' : (params.get('view') ?? (hasFilters ? 'all' : 'recommended'));
  const sort = params.get('sort') ?? (view === 'recommended' ? 'amount' : view === 'attention' || view === 'unassigned' ? 'issues' : 'date');
  const order = params.get('order') ?? 'desc';
  const page = Number(params.get('page') ?? 1);

  const query = useMemo(
    () => ({
      view,
      stage: params.get('stage') ?? undefined,
      retailerId: params.get('retailerId') ?? undefined,
      reasonCode: params.get('reasonCode') ?? undefined,
      assigneeId: params.get('assigneeId') ?? undefined,
      issue: params.get('issue') ?? undefined,
      q: params.get('q') ?? undefined,
      sort,
      order,
      page,
      pageSize: PAGE_SIZE,
    }),
    [params, view, sort, order, page],
  );
  const list = useDeductions(query);

  const update = (changes: Record<string, string | null>, resetPage = true) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      if (resetPage) next.delete('page');
      return next;
    });

  // Debounced search box → ?q=
  useEffect(() => {
    const handle = setTimeout(() => {
      if ((params.get('q') ?? '') !== search) update({ q: search || null });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // A new page of results means a new selection.
  useEffect(() => setSelected(new Set()), [query, companyId]);

  const onSort = (key: SortKey) => update({ sort: key, order: sort === key && order === 'desc' ? 'asc' : 'desc' });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const currency = list.data?.currency ?? 'USD';
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const showCompany = session.companies.length > 1 && companyId === undefined;

  const runBulk = async (action: DeductionAction | 'assign', payload: Record<string, unknown> = {}) => {
    const ids = [...selected];
    try {
      const result = await api.bulk(ids, action, payload);
      invalidate();
      setSelected(new Set());
      if (result.failed.length === 0) toast.success(`Updated ${result.ok.length} deduction${result.ok.length === 1 ? '' : 's'}`);
      else
        toast.warning(`Updated ${result.ok.length}, skipped ${result.failed.length}`, {
          description: [...new Set(result.failed.map((f) => f.error))].slice(0, 3).join(' '),
        });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk update failed');
    }
  };

  const title = unassignedMode ? 'Unassigned deductions' : 'Deductions';
  const description = unassignedMode
    ? 'Rows whose company_id is 0, 3 or empty in the export. Nobody but admins can see them until they are assigned to a company.'
    : VIEWS.find((v) => v.value === view)?.hint;

  return (
    <div className="grid gap-4">
      <PageHeader
        title={title}
        description={description}
        actions={
          list.data && (
            <div className="text-right text-sm">
              <div className="font-semibold tabular-nums">{formatMoney(list.data.totalCents, currency)}</div>
              <div className="text-xs text-muted-foreground">{formatNumber(total)} deductions</div>
            </div>
          )
        }
      />

      {!unassignedMode && (
        <Tabs value={view} onValueChange={(v) => update({ view: v, sort: null, order: null })}>
          <TabsList>
            {VIEWS.map((v) => (
              <TabsTrigger key={v.value} value={v.value}>
                {v.value === 'recommended' && <Sparkles />}
                {v.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search invoice, id, retailer…" className="w-64 pl-8" />
        </div>
        {!unassignedMode && (
          <FilterSelect value={params.get('stage')} onChange={(v) => update({ stage: v })} placeholder="Any stage">
            {STAGE_FILTERS.map((s) => (
              <SelectItem key={s} value={s}>
                {STAGE_FILTER_LABELS[s]}
              </SelectItem>
            ))}
          </FilterSelect>
        )}
        <FilterSelect value={params.get('retailerId')} onChange={(v) => update({ retailerId: v })} placeholder="Any retailer">
          <SelectItem value="none">Unknown retailer</SelectItem>
          {meta.data?.retailers.map((r) => (
            <SelectItem key={r.id} value={String(r.id)}>
              {r.name}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect value={params.get('reasonCode')} onChange={(v) => update({ reasonCode: v })} placeholder="Any reason">
          <SelectItem value="none">Unclassified</SelectItem>
          {meta.data?.reasons.map((r) => (
            <SelectItem key={r.code} value={r.code}>
              {r.label}
            </SelectItem>
          ))}
        </FilterSelect>
        {!unassignedMode && (
          <FilterSelect value={params.get('assigneeId')} onChange={(v) => update({ assigneeId: v })} placeholder="Any owner" className="w-40">
            <SelectItem value="me">Me</SelectItem>
            <SelectItem value="none">Nobody</SelectItem>
            {meta.data?.users.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>
                {u.name}
              </SelectItem>
            ))}
          </FilterSelect>
        )}
        {params.get('issue') && (
          <Button variant="secondary" size="sm" onClick={() => update({ issue: null })}>
            Issue: {ISSUE_META[params.get('issue') as IssueCode]?.label ?? params.get('issue')} <X />
          </Button>
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch('');
              update({ stage: null, retailerId: null, reasonCode: null, assigneeId: null, issue: null, q: null });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 rounded-xl border bg-zinc-900 px-3 py-2 text-sm text-white shadow-lg">
          <span className="mr-2 font-medium">{selected.size} selected</span>
          <Button size="sm" variant="secondary" onClick={() => void runBulk('start_review')}>
            Start review
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void runBulk('open_dispute')}>
            Open disputes
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setNoteAction('send_to_ops')}>
            Send to ops
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setNoteAction('accept')}>
            Accept as valid
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary">
                Assign to…
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Owner</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {meta.data?.users.map((u) => (
                <DropdownMenuItem key={u.id} onClick={() => void runBulk('assign', { assigneeId: u.id })}>
                  {u.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={() => void runBulk('assign', { assigneeId: null })}>Nobody</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" className="ml-auto text-white hover:bg-white/10 hover:text-white" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-10 pl-3">
                <Checkbox
                  aria-label="Select page"
                  checked={allSelected}
                  onCheckedChange={(c) => setSelected(c ? new Set(items.map((i) => i.id)) : new Set())}
                />
              </TableHead>
              <SortHeader label="ID" sortKey="id" sort={sort} order={order} onSort={onSort} className="w-20" />
              <SortHeader label="Retailer" sortKey="retailer" sort={sort} order={order} onSort={onSort} />
              <TableHead>Invoice</TableHead>
              <TableHead>Reason</TableHead>
              <SortHeader label="Amount" sortKey="amount" sort={sort} order={order} onSort={onSort} className="text-right [&>button]:ml-auto [&>button]:flex" />
              <SortHeader label="Deducted" sortKey="date" sort={sort} order={order} onSort={onSort} />
              <TableHead>Status</TableHead>
              {unassignedMode ? <TableHead>Export company_id</TableHead> : <TableHead className="w-14">Owner</TableHead>}
              <SortHeader label="Issues" sortKey="issues" sort={sort} order={order} onSort={onSort} className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody className={cn(list.isFetching && 'opacity-60 transition-opacity')}>
            {items.map((item) => (
              <DeductionRow
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                showCompany={showCompany}
                unassignedMode={unassignedMode}
                onSelect={(checked) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })
                }
                onOpen={() => drawer.open(item.id)}
              />
            ))}
          </TableBody>
        </Table>
        {list.data && items.length === 0 && (
          <div className="p-6">
            <EmptyState icon={<Inbox className="size-6" />} title={view === 'mine' ? 'Nothing assigned to you' : 'No deductions match'}>
              {view === 'recommended' ? 'Every disputable deduction has been triaged. Nice.' : 'Try clearing a filter.'}
            </EmptyState>
          </div>
        )}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm text-muted-foreground">
            <span>
              {formatNumber((page - 1) * PAGE_SIZE + 1)}–{formatNumber(Math.min(page * PAGE_SIZE, total))} of {formatNumber(total)}
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, false)}>
                <ChevronLeft /> Prev
              </Button>
              <Button variant="outline" size="sm" disabled={page * PAGE_SIZE >= total} onClick={() => update({ page: String(page + 1) }, false)}>
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </div>

      <NoteDialog
        open={noteAction !== null}
        title={noteAction === 'accept' ? `Accept ${selected.size} as valid` : `Send ${selected.size} to ops`}
        description={noteAction === 'accept' ? 'Say why these deductions are legitimate.' : 'What do you need from ops?'}
        onCancel={() => setNoteAction(null)}
        onConfirm={(note) => {
          const action = noteAction!;
          setNoteAction(null);
          void runBulk(action, { note });
        }}
      />
    </div>
  );
}

function DeductionRow({
  item,
  selected,
  showCompany,
  unassignedMode,
  onSelect,
  onOpen,
}: {
  item: DeductionListItem;
  selected: boolean;
  showCompany: boolean;
  unassignedMode: boolean;
  onSelect: (checked: boolean) => void;
  onOpen: () => void;
}) {
  const rawRetailerDiffers = item.retailerRaw !== null && item.retailerRaw !== item.retailerName;
  return (
    <TableRow data-state={selected ? 'selected' : undefined} className="cursor-pointer" onClick={onOpen}>
      <TableCell className="pl-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox aria-label={`Select ${item.id}`} checked={selected} onCheckedChange={(c) => onSelect(c === true)} />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          {item.id}
          {item.recommended && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Sparkles className="size-3 text-emerald-600" />
              </TooltipTrigger>
              <TooltipContent>Recommended to dispute</TooltipContent>
            </Tooltip>
          )}
        </span>
      </TableCell>
      <TableCell className="max-w-48">
        <div className={cn('truncate font-medium', !item.retailerName && 'text-rose-600')}>{item.retailerName ?? 'Unknown'}</div>
        {(showCompany || rawRetailerDiffers) && (
          <div className="truncate text-xs text-muted-foreground">
            {showCompany ? item.companyName : `"${showWhitespace(item.retailerRaw!)}"`}
          </div>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs">{item.invoiceNumber ?? <span className="font-sans text-amber-700">—</span>}</TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              item.disputable === null ? 'bg-zinc-300' : item.disputable ? 'bg-emerald-500' : 'bg-zinc-400',
            )}
          />
          <span className={cn(!item.reasonLabel && 'text-amber-700')}>{item.reasonLabel ?? 'Unclassified'}</span>
          {item.note && (
            <Tooltip>
              <TooltipTrigger asChild>
                <StickyNote className="size-3.5 text-amber-500" />
              </TooltipTrigger>
              <TooltipContent>Spreadsheet note: {item.note}</TooltipContent>
            </Tooltip>
          )}
        </span>
      </TableCell>
      <TableCell className="text-right font-medium">
        <Money cents={item.amountCents} currency={item.currency} flag={item.amountFlag} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {item.deductedOn ? (
          <>
            {formatDate(item.deductedOn, { short: true })}
            <span className="ml-1 text-xs text-muted-foreground">{item.ageDays !== null ? `${item.ageDays}d` : '(future)'}</span>
          </>
        ) : (
          <span className="text-amber-700">—</span>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge status={item.status} resolution={item.resolution} stage={item.dispute?.stage} />
      </TableCell>
      <TableCell>
        {unassignedMode ? (
          <span className="font-mono text-xs">{item.sourceCompanyRef ?? '—'}</span>
        ) : item.assignee ? (
          <UserAvatar user={item.assignee} />
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </TableCell>
      <TableCell>
        <IssueCount errors={item.openErrors} warnings={item.openWarnings} />
      </TableCell>
    </TableRow>
  );
}
