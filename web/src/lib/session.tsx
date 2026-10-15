import type { CompanyRef, SessionInfo } from '@shared/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api, ApiError } from './api';

interface SessionState {
  session: SessionInfo;
  /** undefined = every company this person can see. */
  companyId: number | undefined;
  company: CompanyRef | undefined;
  setCompanyId: (id: number | undefined) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

const storageKey = (userId: number) => `recovery.company.${userId}`;

function readStoredCompany(session: SessionInfo): number | undefined {
  if (session.companies.length === 1) return session.companies[0]!.id;
  try {
    const raw = localStorage.getItem(storageKey(session.user.id));
    const id = raw ? Number(raw) : undefined;
    return session.companies.some((c) => c.id === id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export function useSessionQuery() {
  return useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 5 * 60_000,
  });
}

/** Renders children only for a signed-in person; everyone else goes to /login. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const query = useSessionQuery();
  const location = useLocation();
  if (query.isPending) {
    return <div className="grid min-h-svh place-items-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (query.isError || !query.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <SignedIn session={query.data}>{children}</SignedIn>;
}

function SignedIn({ session, children }: { session: SessionInfo; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [companyId, setCompanyIdState] = useState<number | undefined>(() => readStoredCompany(session));

  const setCompanyId = useCallback(
    (id: number | undefined) => {
      setCompanyIdState(id);
      try {
        if (id === undefined) localStorage.removeItem(storageKey(session.user.id));
        else localStorage.setItem(storageKey(session.user.id), String(id));
      } catch {
        // Storage can be unavailable (private mode); the choice just won't persist.
      }
    },
    [session.user.id],
  );

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    queryClient.clear();
    window.location.assign('/login');
  }, [queryClient]);

  const value = useMemo<SessionState>(
    () => ({
      session,
      companyId,
      company: session.companies.find((c) => c.id === companyId),
      setCompanyId,
      signOut,
    }),
    [session, companyId, setCompanyId, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
