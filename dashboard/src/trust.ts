import { canonicalVerificationState, escapeHtml, onchainAttestationState, onchainMetadata, type VerificationStateInput } from './presentation.js';

const COPYABLE_LABELS = new Set([
  'Assessment ID',
  'Assessment hash',
  'Canonical assessment hash',
  'Contract address',
  'Contract',
  'Transaction hash',
  'Transaction',
  'Attester',
]);

function fieldsHtml(fields: Array<[string, string]>): string {
  return fields.map(([label, value]) => {
    const isCopyable = COPYABLE_LABELS.has(label) && value && value !== 'Not available';
    const copyButton = isCopyable
      ? ` <button class="copy-button" type="button" data-copy="${escapeHtml(value)}" aria-label="Copy ${escapeHtml(label)}">Copy</button>`
      : '';
    return `<div><dt>${escapeHtml(label)}</dt><dd class="mono"><span>${escapeHtml(value)}</span>${copyButton}</dd></div>`;
  }).join('');
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
  if (result?.assessment_id) canonicalFieldRows.push(['Assessment ID', result.assessment_id]);
  if (result?.assessment_hash) canonicalFieldRows.push(['Canonical assessment hash', result.assessment_hash]);
  if (result?.methodology_version) canonicalFieldRows.push(['Canonical methodology', result.methodology_version]);
  const canonicalFields = fieldsHtml(canonicalFieldRows);

  const metadataFields = onchainMetadata(result);
  let explorerHtml = '';
  if (attestationStatus === 'ATTESTED' && recorded) {
    const fieldsMap = new Map(metadataFields);
    const contract = recorded.contract_address || fieldsMap.get('Contract address');
    const chainId = String(recorded.chain_id || fieldsMap.get('Chain ID') || '99801');
    const txHash = recorded.transaction_hash;
    const blockNum = recorded.block_number !== null ? String(recorded.block_number) : null;
    const attester = fieldsMap.get('Attester');
    const attestedAt = fieldsMap.get('Attested at');

    metadataFields.length = 0;
    metadataFields.push(['Network', 'Elysium Testnet']);
    metadataFields.push(['Chain ID', chainId]);
    if (contract) metadataFields.push(['Contract address', contract]);
    if (txHash) metadataFields.push(['Transaction hash', txHash]);
    if (blockNum) metadataFields.push(['Block number', blockNum]);
    if (attester) metadataFields.push(['Attester', attester]);
    if (attestedAt) metadataFields.push(['Attested at', attestedAt]);

    explorerHtml = `<div class="trust-explorer-row"><a href="https://elysium.kinetiq.xyz/testnet-explorer" target="_blank" rel="noopener noreferrer" class="explorer-link">Official Elysium Testnet Explorer <span aria-hidden="true">↗</span></a></div>`;
  }
  const metadata = fieldsHtml(metadataFields);

  const canonicalDescription = canonicalStatus === 'VALID'
    ? 'Canonical assessment verified. The canonical assessment payload is deterministically reconstructed and its hash matches the stored assessment hash.'
    : 'The canonical assessment payload is deterministically reconstructed and its hash is compared with the stored assessment hash.';

  const attestationDescription = attestationStatus === 'ATTESTED'
    ? 'Onchain attestation verified · Attested on Elysium Testnet. Assessment data matches the attested record.'
    : 'Onchain status is independent of canonical validity. NOT CONFIGURED means no contract is configured; it does not invalidate this assessment.';

  return `<div class="trust-connector" aria-hidden="true">↓</div>
    <article class="section-card trust-step"><div class="trust-step-heading"><div><p class="eyebrow">2 · CANONICAL VERIFICATION</p><h2>Canonical assessment check</h2></div><strong class="trust-state ${canonicalClass}">${escapeHtml(canonicalStatus)}</strong></div><p>${canonicalDescription}</p>${canonicalFields ? `<dl class="detail-list">${canonicalFields}</dl>` : '<p class="muted-value">The verification endpoint did not return canonical fields.</p>'}</article>
    <div class="trust-connector" aria-hidden="true">↓</div>
    <article class="section-card trust-step"><div class="trust-step-heading"><div><p class="eyebrow">3 · ONCHAIN ATTESTATION</p><h2>Optional contract proof</h2></div><strong class="trust-state ${onchainClass}">${escapeHtml(attestationStatus)}</strong></div><p>${attestationDescription}</p>${metadata ? `<dl class="detail-list">${metadata}</dl>` : ''}${explorerHtml}</article>`;
}
