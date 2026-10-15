import type {
  BoardResponse,
  BulkResult,
  DashboardResponse,
  DataQualityResponse,
  DeductionDetail,
  DeductionListResponse,
  DemoAccount,
  MetaResponse,
  SessionInfo,
} from '@shared/api';
import type { DeductionAction, DisputeAction } from '@shared/domain';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(params: Query = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  me: () => request<SessionInfo>('GET', '/me'),
  login: (email: string, password: string) => request<SessionInfo>('POST', '/auth/login', { email, password }),
  logout: () => request<void>('POST', '/auth/logout'),
  demoAccounts: () => request<DemoAccount[]>('GET', '/auth/demo-accounts'),
  config: () => request<{ sandbox: boolean }>('GET', '/config'),
  meta: () => request<MetaResponse>('GET', '/meta'),

  deductions: (params: Query) => request<DeductionListResponse>('GET', `/deductions${qs(params)}`),
  deduction: (id: number) => request<DeductionDetail>('GET', `/deductions/${id}`),
  edit: (id: number, patch: Record<string, unknown>) => request<DeductionDetail>('PATCH', `/deductions/${id}`, patch),
  deductionAction: (id: number, action: DeductionAction, payload: Record<string, unknown> = {}) =>
    request<DeductionDetail>('POST', `/deductions/${id}/actions/${action}`, payload),
  disputeAction: (id: number, action: DisputeAction, payload: Record<string, unknown> = {}) =>
    request<DeductionDetail>('POST', `/deductions/${id}/dispute/${action}`, payload),
  assign: (id: number, assigneeId: number | null) => request<DeductionDetail>('POST', `/deductions/${id}/assign`, { assigneeId }),
  comment: (id: number, body: string) => request<DeductionDetail>('POST', `/deductions/${id}/comments`, { body }),
  verifyIssue: (id: number, issueId: number, note?: string) =>
    request<DeductionDetail>('POST', `/deductions/${id}/issues/${issueId}/verify`, { note }),
  assignCompany: (id: number, companyId: number, note?: string) =>
    request<DeductionDetail>('POST', `/deductions/${id}/company`, { companyId, note }),
  bulk: (ids: number[], action: DeductionAction | 'assign', payload: Record<string, unknown> = {}) =>
    request<BulkResult>('POST', '/deductions/bulk', { ids, action, payload }),

  board: (companyId?: number) => request<BoardResponse>('GET', `/disputes${qs({ companyId })}`),
  dashboard: (companyId?: number) => request<DashboardResponse>('GET', `/dashboard${qs({ companyId })}`),
  dataQuality: (companyId?: number) => request<DataQualityResponse>('GET', `/data-quality${qs({ companyId })}`),
};
