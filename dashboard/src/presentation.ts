export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function scoreText(score: number | null | undefined, status?: string | null): string {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return status === 'INSUFFICIENT_DATA' ? 'Insufficient data' : 'Not assessed';
  }
  return score.toFixed(2);
}

export function valueText(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Not available';
  return value.toFixed(digits);
}

export function ratioPercent(value: number | string | null): string {
  if (value === null || value === undefined || value === '') return 'Not available';
  const ratio = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(ratio)) return 'Not available';
  return `${(ratio * 100).toFixed(1)}%`;
}

export function assessmentAvailability(status: string | null | undefined, score: number | null | undefined): string {
  if (status === 'INSUFFICIENT_DATA') return 'Insufficient data';
  if (score === null || score === undefined) return 'Not assessed';
  return 'Assessment available';
}

export function verificationState(result: {
  canonical_valid?: boolean;
  onchain_attested?: boolean;
  onchain_data_matches?: boolean;
  onchain?: { configured?: boolean; error?: string };
} | null): string {
  if (!result) return 'Not checked';
  if (result.canonical_valid === false) return 'Invalid';
  if (result.onchain?.configured === false) return 'Valid · not configured';
  if (result.onchain?.error) return 'Verification unavailable';
  if (!result.onchain_attested) return 'Valid · not attested';
  if (!result.onchain_data_matches) return 'Mismatch';
  return 'Valid · attested';
}

export function routeFromHash(hash: string): { path: string; page: number } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parsed = new URL(raw || '/', 'https://dashboard.invalid');
  const pageValue = Number(parsed.searchParams.get('page') ?? '1');
  return { path: parsed.pathname, page: Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1 };
}
