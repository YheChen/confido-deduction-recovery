import { cn } from 'cn';
import {
  Building2,
  ChevronsUpDown,
  Columns3,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  ShieldCheck,
  Undo2,
  UserRound,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { UserAvatar } from '@/components/common';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppConfig } from '@/lib/queries';
import { DeductionDrawer } from '@/components/deduction/DeductionDrawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSession } from '@/lib/session';

const ALL = 'all';

function NavItem({ to, icon, children, end }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground [&_svg]:size-4',
          isActive && 'bg-sidebar-accent text-sidebar-foreground',
        )
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

function CompanySwitcher() {
  const { session, companyId, setCompanyId } = useSession();
  const companies = session.companies;
  if (companies.length === 1) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Building2 className="size-4 text-muted-foreground" />
        <span className="font-medium">{companies[0]!.name}</span>
      </div>
    );
  }
  return (
    <Select value={companyId === undefined ? ALL : String(companyId)} onValueChange={(v) => setCompanyId(v === ALL ? undefined : Number(v))}>
      <SelectTrigger className="min-w-56" aria-label="Company">
        <Building2 className="text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ALL}>All my companies ({companies.length})</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Companies</SelectLabel>
          {companies.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              {c.name}
              <span className="text-xs text-muted-foreground">
                {c.currency}
                {!c.isActive && ' · inactive'}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function UserMenu() {
  const { session, signOut } = useSession();
  const { user } = session;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left hover:bg-sidebar-accent">
        <UserAvatar user={user} className="size-7" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{user.name}</div>
          <div className="truncate text-xs text-muted-foreground">{user.role === 'admin' ? 'Admin' : user.title}</div>
        </div>
        <ChevronsUpDown className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium">{user.name}</div>
          <div className="text-xs text-muted-foreground">{user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Can see: {session.companies.map((c) => c.name).join(', ')}
          {session.canSeeUnassigned && ' + unassigned records'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}>
          <UserRound /> Switch user
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SandboxBadge() {
  const config = useAppConfig();
  if (!config.data?.sandbox) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="rounded-full border border-dashed border-amber-400 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
          Demo sandbox
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Hosted demo. Each server instance loads its own copy of the data, so your changes reset when it goes idle.
      </TooltipContent>
    </Tooltip>
  );
}

export function AppShell() {
  const { session, company } = useSession();
  return (
    <div className="flex min-h-svh bg-background">
      <aside className="sticky top-0 flex h-svh w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-4">
        <div className="mb-6 flex items-center gap-2 px-1.5">
          <div className="grid size-8 place-items-center rounded-lg bg-emerald-600 text-white shadow-sm">
            <Undo2 className="size-4" strokeWidth={2.5} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Deduction Recovery</div>
            <div className="text-xs text-muted-foreground">Confido internal</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5">
          <NavItem to="/" end icon={<LayoutDashboard />}>
            Overview
          </NavItem>
          <NavItem to="/deductions" icon={<ListChecks />}>
            Deductions
          </NavItem>
          <NavItem to="/disputes" icon={<Columns3 />}>
            Disputes
          </NavItem>
          <NavItem to="/data-quality" icon={<ShieldCheck />}>
            Data quality
          </NavItem>
          {session.canSeeUnassigned && (
            <>
              <div className="mt-4 mb-1 px-2.5 text-xs font-medium text-muted-foreground">Admin</div>
              <NavItem to="/unassigned" icon={<Inbox />}>
                Unassigned
              </NavItem>
            </>
          )}
        </nav>
        <div className="mt-auto">
          <UserMenu />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b bg-background/90 px-6 backdrop-blur">
          <CompanySwitcher />
          {company && !company.isActive && <span className="text-xs text-amber-700">This company is inactive.</span>}
          <SandboxBadge />
          <div className="ml-auto text-xs text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{session.user.name}</span>
          </div>
        </header>
        <main className="flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
      <DeductionDrawer />
    </div>
  );
}
