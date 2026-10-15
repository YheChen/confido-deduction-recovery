import type { DemoAccount } from '@shared/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ShieldCheck, Undo2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useAppConfig } from '@/lib/queries';

/** Matches DEMO_PASSWORD in server/src/seed/users.ts. Only used by the demo shortcuts below. */
const DEMO_PASSWORD = 'recover-2026';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const demo = useQuery({ queryKey: ['demo-accounts'], queryFn: api.demoAccounts });
  const config = useAppConfig();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const signIn = async (address: string, secret: string) => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(address, secret);
      queryClient.clear();
      queryClient.setQueryData(['me'], session);
      navigate(from === '/login' ? '/' : from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void signIn(email, password);
  };

  return (
    <div className="grid min-h-svh bg-gradient-to-b from-emerald-50/60 to-background lg:grid-cols-[1fr_1.1fr]">
      <div className="hidden flex-col justify-between border-r bg-zinc-950 p-10 text-zinc-100 lg:flex">
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-emerald-500 text-zinc-950">
            <Undo2 className="size-4" strokeWidth={2.5} />
          </div>
          <span className="font-semibold">Deduction Recovery</span>
        </div>
        <div className="max-w-md">
          <h2 className="text-3xl font-semibold tracking-tight">Chase down the money retailers owe us.</h2>
          <p className="mt-4 text-zinc-400">
            Triage every deduction, dispute the ones that aren't fair, and track each claim until the cash is actually back.
          </p>
        </div>
        <p className="flex items-center gap-2 text-xs text-zinc-500">
          <ShieldCheck className="size-4" /> Each person only sees the companies they work on.
        </p>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="grid w-full max-w-md gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Sign in</CardTitle>
              <CardDescription>Use your work email.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                {error && <p className="text-sm text-rose-600">{error}</p>}
                <Button type="submit" disabled={busy || !email || !password}>
                  Sign in
                </Button>
              </form>
            </CardContent>
          </Card>

          {demo.data && demo.data.length > 0 && (
            <div className="grid gap-2">
              <p className="text-xs font-medium text-muted-foreground">Demo accounts (one click)</p>
              {config.data?.sandbox && (
                <p className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  This is a hosted sandbox with sample data. Feel free to click around: your changes reset when the server goes idle.
                </p>
              )}
              {demo.data.map((account: DemoAccount) => (
                <button
                  key={account.email}
                  type="button"
                  disabled={busy}
                  onClick={() => void signIn(account.email, DEMO_PASSWORD)}
                  className="group flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40 disabled:opacity-60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {account.name}
                      <span
                        className={
                          account.role === 'admin'
                            ? 'rounded-full bg-zinc-900 px-1.5 text-[10px] font-semibold text-white uppercase'
                            : 'text-xs font-normal text-muted-foreground'
                        }
                      >
                        {account.role === 'admin' ? 'Admin' : account.title}
                      </span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{account.companies.join(' · ')}</div>
                  </div>
                  <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
