import {
  DEDUCTION_ACTION_LABELS,
  DISPUTE_ACTION_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type DeductionAction,
  type Decision,
  type DisputeAction,
  type DisputeStage,
  type PaymentMethod,
} from '@shared/domain';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { centsToInput, dollarsToCents, formatMoney, todayISO } from '@/lib/format';
import { useDeductionWrite } from '@/lib/queries';

/** What an action needs to know about the record it acts on. */
export interface ActionTarget {
  id: number;
  amountCents: number | null;
  currency: string;
  retailerName: string | null;
  disputable: boolean | null;
  reasonLabel: string | null;
  dispute: { stage: DisputeStage; claimCents: number; approvedCents: number | null; recoveredCents: number } | null;
}

export type PendingAction =
  | { kind: 'deduction'; action: DeductionAction }
  | { kind: 'dispute'; action: DisputeAction; decision?: Decision };

/** Moves with nothing to fill in run straight away. */
export const INSTANT_ACTIONS: DeductionAction[] = ['start_review', 'ops_returned', 'reopen'];

const SUCCESS: Record<string, string> = {
  start_review: 'Review started',
  send_to_ops: 'Sent to ops',
  ops_returned: 'Back in review',
  accept: 'Accepted as valid',
  reopen: 'Reopened',
  open_dispute: 'Dispute opened',
  submit: 'Marked as submitted',
  record_decision: 'Decision recorded',
  record_payment: 'Payment recorded',
  appeal: 'Appeal started',
  withdraw: 'Dispute withdrawn',
  close: 'Dispute closed',
};

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ActionDialog({ target, pending, onClose }: { target: ActionTarget | null; pending: PendingAction | null; onClose: () => void }) {
  const write = useDeductionWrite();
  const open = target !== null && pending !== null;
  const dispute = target?.dispute ?? null;
  const remaining = dispute ? Math.max(0, (dispute.approvedCents ?? 0) - dispute.recoveredCents) : 0;

  const [note, setNote] = useState('');
  const [money, setMoney] = useState('');
  const [secondMoney, setSecondMoney] = useState('');
  const [date, setDate] = useState(todayISO());
  const [reference, setReference] = useState('');
  const [decision, setDecision] = useState<Decision>('approved');
  const [method, setMethod] = useState<PaymentMethod>('check');
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever a new action is opened (not on every re-render of the target).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !pending || !target) return;
    setNote('');
    setReference('');
    setDate(todayISO());
    setError(null);
    setMethod('check');
    setDecision(pending.kind === 'dispute' && pending.decision ? pending.decision : 'approved');
    if (pending.action === 'open_dispute') setMoney(centsToInput(target.amountCents));
    else if (pending.action === 'submit') setMoney(centsToInput(target.dispute?.claimCents || target.amountCents));
    else if (pending.action === 'record_payment') setMoney(centsToInput(remaining));
    else setMoney('');
    setSecondMoney(pending.action === 'record_decision' ? centsToInput(Math.round((target.dispute?.claimCents ?? 0) * 0.5)) : '');
  }, [open, pending, target?.id]);

  if (!target || !pending) return null;

  const fmt = (cents: number | null | undefined) => formatMoney(cents ?? 0, target.currency);
  const retailer = target.retailerName ?? 'the retailer';
  const title = pending.kind === 'deduction' ? DEDUCTION_ACTION_LABELS[pending.action] : DISPUTE_ACTION_LABELS[pending.action];

  let description: ReactNode = null;
  let body: ReactNode = null;
  let build: () => Record<string, unknown> | string = () => ({ note: note || undefined });

  switch (pending.action) {
    case 'send_to_ops':
      description = 'Ask operations for the backup you need (proof of delivery, BOL, receiving records).';
      body = (
        <Field label="What do you need from ops?">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Signed BOL and POD for the 3/14 shipment" />
        </Field>
      );
      break;
    case 'accept':
      description = 'The deduction is legitimate, so nothing will be disputed. It closes with $0 to recover and can be reopened later.';
      body = (
        <Field label="Why is it valid?">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Matches the promo agreed in the Q2 trade plan" />
        </Field>
      );
      build = () => (note.trim().length < 3 ? 'Say why the deduction is valid.' : { note });
      break;
    case 'open_dispute': {
      description = `Start building a claim against ${retailer}. You can file it once the backup is ready.`;
      body = (
        <>
          {target.disputable === false && (
            <Alert>
              <TriangleAlert />
              <AlertDescription>{target.reasonLabel} deductions are usually valid. Make sure you have backup before disputing.</AlertDescription>
            </Alert>
          )}
          <Field label="Claim amount" hint={`Defaults to the full deduction (${fmt(target.amountCents)}). Lower it to dispute only part.`}>
            <Input inputMode="decimal" value={money} onChange={(e) => setMoney(e.target.value)} />
          </Field>
          <Field label="Note (optional)">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why we think it's invalid" />
          </Field>
        </>
      );
      build = () => {
        const claim = dollarsToCents(money);
        if (!claim) return 'Enter a claim amount.';
        return { claimCents: claim, note: note || undefined };
      };
      break;
    }
    case 'submit':
      description = `Record that the claim was filed with ${retailer} (portal, email or EDI).`;
      body = (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Submitted on">
              <Input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Claim amount">
              <Input inputMode="decimal" value={money} onChange={(e) => setMoney(e.target.value)} />
            </Field>
          </div>
          <Field label="Retailer claim / reference # (optional)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. KR-48213" />
          </Field>
        </>
      );
      build = () => {
        const claim = dollarsToCents(money);
        if (!claim) return 'Enter the claim amount.';
        return { submittedOn: date, claimCents: claim, claimReference: reference || undefined, note: note || undefined };
      };
      break;
    case 'record_decision':
      description = `What did ${retailer} decide on the ${fmt(dispute?.claimCents)} claim?`;
      body = (
        <>
          <RadioGroup value={decision} onValueChange={(v) => setDecision(v as Decision)} className="grid gap-2">
            {(
              [
                ['approved', 'Approved in full', `They will pay back ${fmt(dispute?.claimCents)}.`],
                ['partial', 'Partially approved', 'They agreed to pay back part of the claim.'],
                ['denied', 'Denied', 'They rejected the claim. You can appeal or close it afterwards.'],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-[state=checked]:border-foreground/40 has-data-[state=checked]:bg-muted/50">
                <RadioGroupItem value={value} className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <div className="grid grid-cols-2 gap-3">
            {decision === 'partial' && (
              <Field label="Approved amount">
                <Input inputMode="decimal" value={secondMoney} onChange={(e) => setSecondMoney(e.target.value)} />
              </Field>
            )}
            <Field label="Decision date">
              <Input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label={decision === 'denied' ? 'Reason given by the retailer' : 'Note (optional)'}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </>
      );
      build = () => {
        if (decision === 'denied' && note.trim().length < 3) return 'Add the reason the retailer gave.';
        const approvedCents = decision === 'partial' ? dollarsToCents(secondMoney) : undefined;
        if (decision === 'partial' && !approvedCents) return 'Enter the approved amount.';
        return { decision, decidedOn: date, approvedCents: approvedCents ?? undefined, note: note || undefined };
      };
      break;
    case 'record_payment':
      description = (
        <>
          Only money actually received counts as recovered. {fmt(remaining)} of the {fmt(dispute?.approvedCents)} approval is still
          outstanding.
        </>
      );
      body = (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount received">
              <Input inputMode="decimal" value={money} onChange={(e) => setMoney(e.target.value)} />
            </Field>
            <Field label="Received on">
              <Input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="How it came back">
              <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Reference (optional)">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Check #, CM #, remittance" />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">When the full approval has been received the dispute closes automatically.</p>
        </>
      );
      build = () => {
        const amount = dollarsToCents(money);
        if (!amount) return 'Enter the amount received.';
        return { amountCents: amount, receivedOn: date, method, reference: reference || undefined, note: note || undefined };
      };
      break;
    case 'appeal':
      description = 'Send it back to Preparing to re-file with new backup or an escalation.';
      body = (
        <Field label="What is different this time?">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Attached carrier delivery photos" />
        </Field>
      );
      build = () => (note.trim().length < 3 ? 'Say what is different about the appeal.' : { note });
      break;
    case 'withdraw':
      description = 'Stop pursuing this dispute. It closes with nothing recovered and is left out of recovery rates.';
      body = (
        <Field label="Why drop it?">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Ops confirmed the shortage was real" />
        </Field>
      );
      build = () => (note.trim().length < 3 ? 'Say why the dispute is being dropped.' : { note });
      break;
    case 'close': {
      const writeOff = dispute?.stage === 'approved' ? remaining : (dispute?.claimCents ?? 0) - (dispute?.recoveredCents ?? 0);
      description =
        dispute?.stage === 'approved'
          ? `Settle it at ${fmt(dispute.recoveredCents)} received. The remaining ${fmt(writeOff)} of the approval is written off.`
          : `Accept the denial. ${fmt(writeOff)} is written off.`;
      body = (
        <Field label={writeOff > 0 && dispute?.stage === 'approved' ? 'Why write off the rest?' : 'Note (optional)'}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      );
      build = () =>
        dispute?.stage === 'approved' && writeOff > 0 && note.trim().length < 3 ? 'Say why the rest is being written off.' : { note: note || undefined };
      break;
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const payload = build();
    if (typeof payload === 'string') {
      setError(payload);
      return;
    }
    setError(null);
    write.mutate(
      {
        run: () =>
          pending.kind === 'deduction'
            ? api.deductionAction(target.id, pending.action, payload)
            : api.disputeAction(target.id, pending.action, payload),
        success: SUCCESS[pending.action],
      },
      { onSuccess: onClose },
    );
  };

  const destructive = pending.action === 'withdraw';
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {body}
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={write.isPending}>
              {write.isPending ? 'Saving…' : title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function targetFromDetail(d: {
  id: number;
  amountCents: number | null;
  currency: string;
  retailerName: string | null;
  disputable: boolean | null;
  reasonLabel: string | null;
  dispute: ActionTarget['dispute'];
}): ActionTarget {
  return {
    id: d.id,
    amountCents: d.amountCents,
    currency: d.currency,
    retailerName: d.retailerName,
    disputable: d.disputable,
    reasonLabel: d.reasonLabel,
    dispute: d.dispute,
  };
}
