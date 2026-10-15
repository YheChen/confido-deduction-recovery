import type { DeductionDetail } from '@shared/api';
import { ISSUE_META } from '@shared/domain';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { SeverityIcon } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useDeductionWrite } from '@/lib/queries';

export function IssuesPanel({ d }: { d: DeductionDetail }) {
  const write = useDeductionWrite();
  const [showResolved, setShowResolved] = useState(false);
  const open = d.issues.filter((i) => !i.resolvedAt);
  const resolved = d.issues.filter((i) => i.resolvedAt);
  const active = d.recordState === 'active';

  if (d.issues.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4 text-emerald-600" /> Clean record. Nothing needed fixing on import.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {open.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-emerald-600" /> All data issues are resolved.
        </p>
      )}
      {open.map((issue) => (
        <div key={issue.id} className="flex gap-3 rounded-lg border bg-card px-3 py-2.5">
          <SeverityIcon severity={issue.severity} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{ISSUE_META[issue.code].label}</div>
            <p className="text-sm text-muted-foreground">{issue.message}</p>
            <p className="mt-1 text-xs text-muted-foreground/80">{ISSUE_META[issue.code].fix}</p>
          </div>
          {active && issue.verifiable && (
            <Button
              size="sm"
              variant="outline"
              className="self-center"
              disabled={write.isPending}
              onClick={() => write.mutate({ run: () => api.verifyIssue(d.id, issue.id), success: 'Marked as verified' })}
            >
              Verified
            </Button>
          )}
        </div>
      ))}
      {resolved.length > 0 && (
        <Collapsible open={showResolved} onOpenChange={setShowResolved}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className={`size-3.5 transition-transform ${showResolved ? 'rotate-90' : ''}`} />
            {resolved.length} resolved
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid gap-1.5">
            {resolved.map((issue) => (
              <div key={issue.id} className="flex items-start gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                <span>
                  <span className="font-medium text-foreground/80">{ISSUE_META[issue.code].label}</span> · {issue.resolutionNote}
                  {issue.resolvedBy && ` · ${issue.resolvedBy}`} · {formatDateTime(issue.resolvedAt!)}
                </span>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
