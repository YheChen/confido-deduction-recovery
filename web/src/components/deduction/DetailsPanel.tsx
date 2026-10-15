import type { DeductionDetail } from '@shared/api';
import { cn } from 'cn';
import { Pencil } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Money } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { centsToInput, dollarsToCents, formatDate, showWhitespace, todayISO } from '@/lib/format';
import { useDeductionWrite, useMeta } from '@/lib/queries';
import { useSession } from '@/lib/session';

const NONE = '__none__';

/** "What the export said" under each cleaned value. */
function RawValue({ raw, shown }: { raw: string | null | undefined; shown?: string | null }) {
  if (raw === undefined) return null;
  if (raw !== null && shown !== undefined && raw === shown) return null;
  return (
    <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={raw ?? 'null'}>
      Export: <span className="font-mono">{raw === null ? 'null' : raw === '' ? '""' : `"${showWhitespace(raw)}"`}</span>
    </div>
  );
}

function EditPopover({
  label,
  disabled,
  disabledReason,
  children,
}: {
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (disabled) {
    return (
      <span title={disabledReason} className="opacity-0 group-hover/field:opacity-40">
        <Pencil className="size-3.5" />
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="opacity-0 group-hover/field:opacity-100 data-[state=open]:opacity-100" aria-label={`Edit ${label}`}>
          <Pencil />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

function Row({
  label,
  children,
  edit,
  className,
}: {
  label: string;
  children: ReactNode;
  edit?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('group/field min-w-0', className)}>
      <div className="flex h-5 items-center gap-1 text-xs text-muted-foreground">
        {label}
        {edit}
      </div>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

/** Owns its draft so each field's editor starts from that field's value. */
function TextEditor({
  initial,
  pending,
  onSave,
  type = 'text',
  inputMode,
  placeholder,
  max,
  hint,
}: {
  initial: string;
  pending: boolean;
  onSave: (value: string) => void;
  type?: string;
  inputMode?: 'decimal';
  placeholder?: string;
  max?: string;
  hint?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (value.trim()) onSave(value.trim());
      }}
    >
      <Input autoFocus type={type} inputMode={inputMode} max={max} placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <Button type="submit" size="sm" disabled={pending || !value.trim()}>
        {pending ? 'Saving…' : 'Save correction'}
      </Button>
    </form>
  );
}

export function DetailsPanel({ d }: { d: DeductionDetail }) {
  const meta = useMeta();
  const { session } = useSession();
  const write = useDeductionWrite();
  const active = d.recordState === 'active';

  const save = (patch: Record<string, unknown>, close: () => void, success = 'Saved') =>
    write.mutate({ run: () => api.edit(d.id, patch), success }, { onSuccess: close });

  const reason = meta.data?.reasons.find((r) => r.code === d.reasonCode);

  return (
    <section className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
      <Row
        label="Retailer"
        edit={
          active && (
            <EditPopover label="retailer">
              {(close) => (
                <Select defaultValue={d.retailerId ? String(d.retailerId) : undefined} onValueChange={(v) => save({ retailerId: Number(v) }, close, 'Retailer updated')}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a retailer" />
                  </SelectTrigger>
                  <SelectContent>
                    {meta.data?.retailers.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.name}
                        <span className="text-xs text-muted-foreground">{r.type}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </EditPopover>
          )
        }
      >
        <span className={cn(!d.retailerName && 'text-rose-600')}>{d.retailerName ?? 'Unknown'}</span>
        <RawValue raw={d.retailerRaw} shown={d.retailerName} />
      </Row>

      <Row
        label="Reason"
        edit={
          active && (
            <EditPopover label="reason">
              {(close) => (
                <Select defaultValue={d.reasonCode ?? undefined} onValueChange={(v) => save({ reasonCode: v }, close, 'Reason updated')}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {meta.data?.reasons.map((r) => (
                      <SelectItem key={r.code} value={r.code}>
                        {r.label}
                        <span className="text-xs text-muted-foreground">{r.typicallyDisputable ? 'usually disputable' : 'usually valid'}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </EditPopover>
          )
        }
      >
        <span className={cn(!d.reasonLabel && 'text-amber-700')}>{d.reasonLabel ?? 'Unclassified'}</span>
        {reason && (
          <span className={cn('ml-1.5 text-xs', reason.typicallyDisputable ? 'text-emerald-700' : 'text-muted-foreground')}>
            {reason.typicallyDisputable ? '· usually disputable' : '· usually valid'}
          </span>
        )}
        <RawValue raw={d.reasonRaw} shown={d.reasonLabel} />
      </Row>

      <Row
        label="Invoice #"
        edit={
          active && (
            <EditPopover label="invoice">
              {(close) => (
                <TextEditor
                  initial={d.invoiceNumber ?? ''}
                  placeholder="INV-12345"
                  pending={write.isPending}
                  onSave={(value) => save({ invoiceNumber: value }, close, 'Invoice updated')}
                />
              )}
            </EditPopover>
          )
        }
      >
        <span className="font-mono text-[13px]">{d.invoiceNumber ?? <span className="font-sans text-amber-700">Missing</span>}</span>
        <RawValue raw={d.invoiceRaw} shown={d.invoiceNumber} />
      </Row>

      <Row
        label="Amount"
        edit={
          active && (
            <EditPopover
              label="amount"
              disabled={!d.editable.amount}
              disabledReason="The amount is locked once the claim has been submitted."
            >
              {(close) => (
                <TextEditor
                  initial={centsToInput(d.amountCents)}
                  inputMode="decimal"
                  hint="Use the amount on the retailer's remittance."
                  pending={write.isPending}
                  onSave={(value) => {
                    const cents = dollarsToCents(value);
                    if (cents) save({ amountCents: cents }, close, 'Amount corrected');
                  }}
                />
              )}
            </EditPopover>
          )
        }
      >
        <Money cents={d.amountCents} currency={d.currency} flag={d.amountFlag} className="font-medium" />
        <RawValue raw={d.amountRaw} />
      </Row>

      <Row
        label="Deducted on"
        edit={
          active && (
            <EditPopover label="date">
              {(close) => (
                <TextEditor
                  initial={d.deductedOn ?? ''}
                  type="date"
                  max={todayISO()}
                  pending={write.isPending}
                  onSave={(value) => save({ deductedOn: value }, close, 'Date corrected')}
                />
              )}
            </EditPopover>
          )
        }
      >
        <span className={cn(!d.deductedOn && 'text-amber-700')}>{d.deductedOn ? formatDate(d.deductedOn) : 'Missing'}</span>
        {d.ageDays !== null && <span className="ml-1.5 text-xs text-muted-foreground">· {d.ageDays}d ago</span>}
        <RawValue raw={d.deductedRaw} shown={d.deductedOn} />
      </Row>

      <Row label="Owner">
        {active && d.assignableUsers.length > 0 ? (
          <Select
            value={d.assignee ? String(d.assignee.id) : NONE}
            onValueChange={(v) =>
              write.mutate({ run: () => api.assign(d.id, v === NONE ? null : Number(v)), success: v === NONE ? 'Unassigned' : 'Owner updated' })
            }
          >
            <SelectTrigger size="sm" className="-ml-1 h-7 border-transparent px-1 hover:border-input">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Unassigned</SelectItem>
              {d.assignableUsers.map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {u.name}
                  {u.id === session.user.id && <span className="text-xs text-muted-foreground">(you)</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span>{d.assignee?.name ?? 'Unassigned'}</span>
        )}
      </Row>
    </section>
  );
}
