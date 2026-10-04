export interface TokenListItem {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  total_supply: string | null;
  latest_assessment_date: string | null;
  health_score: number | null;
  momentum: number | null;
  status: string | null;
}

export interface Page<T> { page: number; limit: number; total: number; }
export type TokenListResponse = Page<TokenListItem> & { tokens: TokenListItem[] };

export interface AssessmentComponents {
  holder_health: number | null;
  transfer_activity: number | null;
  address_activity: number | null;
  concentration_score: number | null;
  consistency_score: number | null;
}

export interface CanonicalAssessment {
  assessment_id: string | null;
  schema_version: string;
  methodology_version: string;
  token: { address: string; symbol: string | null };
  assessment_date: string;
  health_score: number | null;
  momentum: number | null;
  status: string;
  components: AssessmentComponents;
  data_window_days: number;
  assessment_hash: string | null;
}

export interface TokenInfo {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  total_supply: string | null;
}

export interface DailyMetric {
  date: string;
  holder_count: number;
  new_holders: number;
  active_holders: number;
  transfer_count: number;
  unique_senders: number;
  unique_receivers: number;
  top1_concentration: number | string | null;
  top5_concentration: number | string | null;
  top10_concentration: number | string | null;
}

export interface AttestationState {
  configured: boolean;
  attested: boolean;
  data_matches: boolean | null;
  mismatch?: boolean;
  contract_address: string | null;
  chain_id: number;
  transaction_hash: string | null;
  block_number: number | null;
}

export interface OverviewResponse {
  token: TokenInfo;
  latest_assessment: CanonicalAssessment | null;
  latest_metrics: DailyMetric | null;
  attestation: AttestationState;
}

export interface AssessmentHistoryResponse extends Page<CanonicalAssessment> { assessments: CanonicalAssessment[]; }
export interface MetricsResponse extends Page<DailyMetric> { metrics: DailyMetric[]; }
export interface MomentumPoint { date: string; value: number | null; }
export interface MomentumResponse extends Page<MomentumPoint> { momentum: MomentumPoint[]; }

export interface AssessmentDetail extends CanonicalAssessment { }

export interface VerificationResponse {
  assessment_id: string;
  valid: boolean;
  canonical_valid: boolean;
  onchain_attested: boolean;
  onchain_data_matches: boolean;
  assessment_hash: string;
  methodology_version: string;
  onchain: {
    configured: boolean;
    attested?: boolean;
    error?: string;
    contract_address?: string;
    chain_id?: number;
    attester?: string;
    attested_at?: number;
    hash_matches?: boolean;
    token_matches?: boolean;
    date_matches?: boolean;
    methodology_matches?: boolean;
  };
}

export interface InsufficientAssessment {
  error: 'INSUFFICIENT_DATA';
  reason: string;
  data_window_days: number;
  token: { address: string; symbol: string };
  assessment_date: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function normalizeApiBase(configuredBase: string | undefined): string {
  const base = configuredBase?.trim() || 'http://localhost:3000';
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('API_BASE_URL must be a public HTTP(S) base URL without credentials, query, or fragment.');
  }
  return parsed.href.replace(/\/+$/, '');
}

const configuredBase = document.querySelector<HTMLMetaElement>('meta[name="elysium-api-base"]')?.content;
const apiBase = normalizeApiBase(configuredBase);

async function request<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError(0, null, 'The API could not be reached. Check the connection and try again.');
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const payload = body as { error?: string; reason?: string } | null;
    const message = payload?.reason ?? payload?.error ?? `The API returned HTTP ${response.status}.`;
    throw new ApiError(response.status, body, message);
  }
  return body as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const result = search.toString();
  return result ? `?${result}` : '';
}

const tokenPath = (address: string): string => `/v1/tokens/${encodeURIComponent(address)}`;

export const api = {
  health: () => request<{ status: string }>('/health'),
  tokens: (page = 1, limit = 25) => request<TokenListResponse>(`/v1/tokens${query({ page, limit })}`),
  overview: (address: string) => request<OverviewResponse>(`${tokenPath(address)}/overview`),
  assessments: (address: string, page = 1, limit = 25) => request<AssessmentHistoryResponse>(`${tokenPath(address)}/assessments${query({ page, limit })}`),
  metrics: (address: string, page = 1, limit = 100) => request<MetricsResponse>(`${tokenPath(address)}/metrics${query({ page, limit })}`),
  momentum: (address: string, page = 1, limit = 100) => request<MomentumResponse>(`${tokenPath(address)}/momentum${query({ page, limit })}`),
  assessment: (address: string, date: string) => request<AssessmentDetail>(`${tokenPath(address)}/assessment${query({ date })}`),
  verification: (assessmentId: string) => request<VerificationResponse>(`/v1/assessments/${encodeURIComponent(assessmentId)}/verify`),
};
