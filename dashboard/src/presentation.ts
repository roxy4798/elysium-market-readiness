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

export interface VerificationStateInput {
  canonical_valid?: boolean;
  onchain_attested?: boolean;
  onchain_data_matches?: boolean | null;
  assessment_hash?: string;
  methodology_version?: string;
  onchain?: {
    configured?: boolean;
    error?: string;
    contract_address?: string;
    chain_id?: number;
    attester?: string;
    attested_at?: number;
  };
}

export function canonicalVerificationState(result: VerificationStateInput | null): string {
  if (!result || typeof result.canonical_valid !== 'boolean') return 'VERIFICATION UNAVAILABLE';
  return result.canonical_valid ? 'VALID' : 'INVALID';
}

export function onchainAttestationState(result: VerificationStateInput | null): string {
  if (!result) return 'VERIFICATION UNAVAILABLE';
  if (result.onchain?.configured === false) return 'NOT CONFIGURED';
  if (result.onchain?.error) return 'VERIFICATION UNAVAILABLE';
  if (!result.onchain?.configured) return 'VERIFICATION UNAVAILABLE';
  if (!result.onchain_attested) return 'NOT ATTESTED';
  if (typeof result.onchain_data_matches !== 'boolean') return 'VERIFICATION UNAVAILABLE';
  return result.onchain_data_matches ? 'ATTESTED' : 'MISMATCH';
}

export function onchainMetadata(result: VerificationStateInput | null): Array<[string, string]> {
  if (!result?.onchain?.configured || result.onchain.error) return [];
  const fields: Array<[string, string | number | undefined]> = [
    ['Contract address', result.onchain.contract_address],
    ['Chain ID', result.onchain.chain_id],
    ['Attester', result.onchain.attester],
    ['Attested at', result.onchain.attested_at && result.onchain.attested_at > 0
      ? new Date(result.onchain.attested_at * 1000).toISOString()
      : undefined],
  ];
  return fields.flatMap(([label, value]) => value === undefined || value === '' ? [] : [[label, String(value)]]);
}

export function verificationState(result: VerificationStateInput | null): string {
  if (!result) return 'Not checked';
  const canonical = canonicalVerificationState(result);
  if (canonical === 'INVALID') return 'Invalid';
  const onchain = onchainAttestationState(result);
  if (onchain === 'NOT CONFIGURED') return 'Valid · not configured';
  if (onchain === 'NOT ATTESTED') return 'Valid · not attested';
  if (onchain === 'MISMATCH') return 'Mismatch';
  if (onchain === 'ATTESTED') return 'Valid · attested';
  return 'Verification unavailable';
}

export function routeFromHash(hash: string): { path: string; page: number } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parsed = new URL(raw || '/', 'https://dashboard.invalid');
  const pageValue = Number(parsed.searchParams.get('page') ?? '1');
  return { path: parsed.pathname, page: Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1 };
}
