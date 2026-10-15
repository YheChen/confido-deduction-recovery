import type { DeductionDetail } from '@shared/api';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { api } from './api';
import { useSession } from './session';

/** Deployment facts the UI needs before sign-in (e.g. whether this is the hosted sandbox). */
export function useAppConfig() {
  return useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: Infinity });
}

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: 10 * 60_000 });
}

export type DeductionQuery = Record<string, string | number | undefined>;

export function useDeductions(params: DeductionQuery) {
  const { companyId } = useSession();
  return useQuery({
    queryKey: ['deductions', companyId, params],
    queryFn: () => api.deductions({ ...params, companyId }),
    placeholderData: keepPreviousData,
  });
}

export function useDeduction(id: number | undefined) {
  return useQuery({
    queryKey: ['deduction', id],
    queryFn: () => api.deduction(id!),
    enabled: id !== undefined,
  });
}

export function useBoard() {
  const { companyId } = useSession();
  return useQuery({ queryKey: ['board', companyId], queryFn: () => api.board(companyId), placeholderData: keepPreviousData });
}

export function useDashboard() {
  const { companyId } = useSession();
  return useQuery({ queryKey: ['dashboard', companyId], queryFn: () => api.dashboard(companyId), placeholderData: keepPreviousData });
}

export function useDataQuality() {
  const { companyId } = useSession();
  return useQuery({ queryKey: ['data-quality', companyId], queryFn: () => api.dataQuality(companyId), placeholderData: keepPreviousData });
}

/** Everything a deduction change can affect. */
export function useInvalidateWorkspace() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    for (const key of ['deductions', 'board', 'dashboard', 'data-quality']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [queryClient]);
}

/**
 * Runs a write that returns the fresh deduction, caches it, refreshes every
 * list and chart, and surfaces server-side validation messages as toasts.
 */
export function useDeductionWrite() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWorkspace();
  return useMutation({
    mutationFn: async (args: { run: () => Promise<DeductionDetail>; success?: string }) => args.run(),
    onSuccess: (detail, args) => {
      queryClient.setQueryData(['deduction', detail.id], detail);
      invalidate();
      if (args.success) toast.success(args.success);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Something went wrong.'),
  });
}

/** The deduction drawer is driven by `?d=<id>` so any screen can open it and links are shareable. */
export function useDeductionDrawer() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('d');
  const openId = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  const open = useCallback(
    (id: number) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('d', String(id));
        return next;
      }),
    [setParams],
  );
  const close = useCallback(
    () =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('d');
        return next;
      }),
    [setParams],
  );
  return { openId, open, close };
}
