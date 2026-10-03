import { canonicalVerificationState, escapeHtml, onchainAttestationState, onchainMetadata, type VerificationStateInput } from './presentation.js';

function fieldsHtml(fields: Array<[string, string]>): string {
  return fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd class="mono">${escapeHtml(value)}</dd></div>`).join('');
}

export interface RecordedAttestationFields {
  contract_address: string | null;
  chain_id: number;
  transaction_hash: string | null;
  block_number: number | null;
}

export function verificationFlowHtml(result: VerificationStateInput | null, recorded: RecordedAttestationFields | null = null): string {
  const canonicalStatus = canonicalVerificationState(result);
  const attestationStatus = onchainAttestationState(result);
  const canonicalClass = canonicalStatus === 'VALID' ? 'trust-valid' : canonicalStatus === 'INVALID' ? 'trust-invalid' : 'trust-unavailable';
  const onchainClass = attestationStatus === 'ATTESTED' ? 'trust-valid' : attestationStatus === 'MISMATCH' ? 'trust-invalid' : 'trust-unavailable';
  const canonicalFieldRows: Array<[string, string]> = [];
  if (result?.assessment_hash) canonicalFieldRows.push(['Canonical assessment hash', result.assessment_hash]);
  if (result?.methodology_version) canonicalFieldRows.push(['Canonical methodology', result.methodology_version]);
  const canonicalFields = fieldsHtml(canonicalFieldRows);
  const metadataFields = onchainMetadata(result);
  if (attestationStatus === 'ATTESTED' && recorded) {
    const present = new Set(metadataFields.map(([label]) => label));
    if (!present.has('Contract address') && recorded.contract_address) metadataFields.push(['Contract address', recorded.contract_address]);
    if (!present.has('Chain ID')) metadataFields.push(['Chain ID', String(recorded.chain_id)]);
    if (recorded.transaction_hash) metadataFields.push(['Transaction hash', recorded.transaction_hash]);
    if (recorded.block_number !== null) metadataFields.push(['Block number', String(recorded.block_number)]);
  }
  const metadata = fieldsHtml(metadataFields);
  return `<div class="trust-connector" aria-hidden="true">↓</div>
    <article class="section-card trust-step"><div class="trust-step-heading"><div><p class="eyebrow">2 · CANONICAL VERIFICATION</p><h2>Canonical assessment check</h2></div><strong class="trust-state ${canonicalClass}">${escapeHtml(canonicalStatus)}</strong></div><p>The canonical assessment payload is deterministically reconstructed and its hash is compared with the stored assessment hash.</p>${canonicalFields ? `<dl class="detail-list">${canonicalFields}</dl>` : '<p class="muted-value">The verification endpoint did not return canonical fields.</p>'}</article>
    <div class="trust-connector" aria-hidden="true">↓</div>
    <article class="section-card trust-step"><div class="trust-step-heading"><div><p class="eyebrow">3 · ONCHAIN ATTESTATION</p><h2>Optional contract proof</h2></div><strong class="trust-state ${onchainClass}">${escapeHtml(attestationStatus)}</strong></div><p>Onchain status is independent of canonical validity. NOT CONFIGURED means no contract is configured; it does not invalidate this assessment.</p>${metadata ? `<dl class="detail-list">${metadata}</dl>` : ''}</article>`;
}
