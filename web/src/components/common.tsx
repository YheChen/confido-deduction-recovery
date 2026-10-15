import type { AmountFlag, UserRef } from '@shared/api';
import {
  statusDisplay,
  type DeductionStatus,
  type DisputeStage,
  type IssueSeverity,
  type Resolution,
  type StatusTone,
} from '@shared/domain';
import { cn } from 'cn';
import { CircleAlert, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatMoney } from '@/lib/format';

export const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-muted text-foreground ring-foreground/10',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  red: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  muted: 'bg-zinc-100 text-zinc-600 ring-zinc-500/15',
};

export function Pill({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusBadge({
  status,
  resolution,
  stage,
  className,
}: {
  status: DeductionStatus;
  resolution: Resolution | null;
  stage: DisputeStage | null | undefined;
  className?: string;
}) {
  const { label, tone } = statusDisplay(status, resolution, stage ?? null);
  return (
    <Pill tone={tone} className={className}>
      {label}
    </Pill>
  );
}

export function Money({
  cents,
  currency = 'USD',
  flag = 'ok',
  className,
  compact,
}: {
  cents: number | null;
  currency?: string;
  flag?: AmountFlag;
  className?: string;
  compact?: boolean;
}) {
  if (flag === 'missing' || cents === null) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-rose-600', className)}>
        <CircleAlert className="size-3.5" /> Missing
      </span>
    );
  }
  const text = formatMoney(cents, currency, { compact });
  if (flag === 'suspect') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn('inline-flex items-center gap-1 tabular-nums text-rose-600 line-through decoration-rose-300', className)}>
            <OctagonAlert className="size-3.5 shrink-0" />
            {text}
          </span>
        </TooltipTrigger>
        <TooltipContent>Implausible amount. Excluded from totals until confirmed or corrected.</TooltipContent>
      </Tooltip>
    );
  }
  return <span className={cn('tabular-nums', className)}>{text}</span>;
}

export const SEVERITY_META: Record<IssueSeverity, { icon: typeof OctagonAlert; className: string; label: string }> = {
  error: { icon: OctagonAlert, className: 'text-rose-600', label: 'Blocking' },
  warning: { icon: TriangleAlert, className: 'text-amber-600', label: 'Check' },
  info: { icon: Info, className: 'text-sky-600', label: 'FYI' },
};

export function SeverityIcon({ severity, className }: { severity: IssueSeverity; className?: string }) {
  const meta = SEVERITY_META[severity];
  const Icon = meta.icon;
  return <Icon className={cn('size-4 shrink-0', meta.className, className)} />;
}

export function IssueCount({ errors, warnings }: { errors: number; warnings: number }) {
  if (!errors && !warnings) return <span className="text-muted-foreground/50">—</span>;
  return (
    <span className="inline-flex items-center gap-2 text-xs tabular-nums">
      {errors > 0 && (
        <span className="inline-flex items-center gap-0.5 text-rose-600">
          <OctagonAlert className="size-3.5" />
          {errors}
        </span>
      )}
      {warnings > 0 && (
        <span className="inline-flex items-center gap-0.5 text-amber-600">
          <TriangleAlert className="size-3.5" />
          {warnings}
        </span>
      )}
    </span>
  );
}

const AVATAR_COLORS = ['bg-indigo-100 text-indigo-700', 'bg-teal-100 text-teal-700', 'bg-orange-100 text-orange-700', 'bg-pink-100 text-pink-700'];

export function UserAvatar({ user, className }: { user: UserRef; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar className={cn('size-6', className)}>
          <AvatarFallback className={cn('text-[10px] font-semibold', AVATAR_COLORS[user.id % AVATAR_COLORS.length])}>
            {user.initials}
          </AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent>{user.name}</TooltipContent>
    </Tooltip>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function SimulatedBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="rounded border border-dashed border-zinc-300 px-1 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
          Simulated
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Generated by the demo seed so the recovery views have history. Run `npm run db:reset -- --no-demo` for the raw export only.
      </TooltipContent>
    </Tooltip>
  );
}
