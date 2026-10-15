import type { DeductionDetail } from '@shared/api';
import { Database } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { SimulatedBadge, UserAvatar } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useDeductionWrite } from '@/lib/queries';

export function ActivityPanel({ d }: { d: DeductionDetail }) {
  const write = useDeductionWrite();
  const [body, setBody] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    write.mutate({ run: () => api.comment(d.id, body.trim()) }, { onSuccess: () => setBody('') });
  };

  return (
    <div className="grid gap-4">
      <form onSubmit={submit} className="grid gap-2">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note for the team…" className="min-h-16" />
        <div className="flex justify-end">
          <Button type="submit" size="sm" variant="outline" disabled={!body.trim() || write.isPending}>
            Add note
          </Button>
        </div>
      </form>
      <ol className="relative grid gap-4 before:absolute before:top-2 before:bottom-2 before:left-3 before:w-px before:bg-border">
        {d.activity.map((entry) => (
          <li key={entry.id} className="relative flex gap-3">
            <div className="z-10 shrink-0 bg-background">
              {entry.actor ? (
                <UserAvatar user={entry.actor} />
              ) : (
                <div className="grid size-6 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Database className="size-3.5" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-medium">{entry.actor?.name ?? 'Import'}</span>
                <span className={entry.kind === 'comment' ? 'text-muted-foreground' : ''}>{entry.kind === 'comment' ? 'added a note' : entry.summary}</span>
                {entry.simulated && <SimulatedBadge />}
              </div>
              {entry.note && (
                <p className="mt-1 rounded-md bg-muted/60 px-2.5 py-1.5 text-sm whitespace-pre-wrap text-foreground/90">{entry.note}</p>
              )}
              <div className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
