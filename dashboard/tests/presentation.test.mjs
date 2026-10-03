import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assessmentAvailability,
  canonicalVerificationState,
  escapeHtml,
  onchainAttestationState,
  onchainMetadata,
  ratioPercent,
  routeFromHash,
  scoreText,
  valueText,
  verificationState,
} from '../dist/presentation.js';
import { methodologyPageHtml } from '../dist/methodology.js';
import { verificationFlowHtml } from '../dist/trust.js';

test('null assessment values stay explicit instead of displaying fabricated zeroes', () => {
  assert.equal(scoreText(null, 'INSUFFICIENT_DATA'), 'Insufficient data');
  assert.equal(scoreText(undefined), 'Not assessed');
  assert.equal(valueText(null), 'Not available');
  assert.equal(assessmentAvailability('INSUFFICIENT_DATA', null), 'Insufficient data');
  assert.equal(assessmentAvailability(null, null), 'Not assessed');
});

test('scores, ratios, and verification states preserve API meanings', () => {
  assert.equal(scoreText(72.4), '72.40');
  assert.equal(ratioPercent('0.125'), '12.5%');
  assert.equal(ratioPercent(null), 'Not available');
  assert.equal(verificationState(null), 'Not checked');
  assert.equal(verificationState({ canonical_valid: false }), 'Invalid');
  assert.equal(verificationState({ canonical_valid: true, onchain: { configured: false } }), 'Valid · not configured');
  assert.equal(verificationState({ canonical_valid: true, onchain: { configured: true, error: 'contract_read_failed' } }), 'Verification unavailable');
  assert.equal(verificationState({ canonical_valid: true, onchain: { configured: true }, onchain_attested: false }), 'Valid · not attested');
  assert.equal(verificationState({ canonical_valid: true, onchain_attested: true, onchain_data_matches: true, onchain: { configured: true } }), 'Valid · attested');
  assert.equal(verificationState({ canonical_valid: true, onchain_attested: true, onchain_data_matches: false, onchain: { configured: true } }), 'Mismatch');
});

test('canonical validity and optional onchain status stay independent', () => {
  // Isolated mock API payloads for UI-state tests; none represents production chain data.
  const notConfigured = { canonical_valid: true, onchain_attested: false, onchain_data_matches: false, onchain: { configured: false } };
  const notAttested = { canonical_valid: true, onchain_attested: false, onchain_data_matches: false, onchain: { configured: true, attested: false } };
  const attested = { canonical_valid: true, onchain_attested: true, onchain_data_matches: true, onchain: { configured: true } };
  const mismatch = { canonical_valid: true, onchain_attested: true, onchain_data_matches: false, onchain: { configured: true } };
  const invalidCanonical = { canonical_valid: false, onchain_attested: false, onchain_data_matches: false, onchain: { configured: false } };

  assert.equal(canonicalVerificationState(notConfigured), 'VALID');
  assert.equal(onchainAttestationState(notConfigured), 'NOT CONFIGURED');
  assert.equal(canonicalVerificationState(invalidCanonical), 'INVALID');
  assert.equal(onchainAttestationState(notAttested), 'NOT ATTESTED');
  assert.equal(onchainAttestationState(attested), 'ATTESTED');
  assert.equal(onchainAttestationState(mismatch), 'MISMATCH');
  assert.equal(onchainAttestationState({ canonical_valid: true, onchain: { configured: true, error: 'contract_read_failed' } }), 'VERIFICATION UNAVAILABLE');
  assert.equal(onchainAttestationState({ canonical_valid: true, onchain_attested: true, onchain: { configured: true } }), 'VERIFICATION UNAVAILABLE');
});

test('methodology page explains the existing pipeline, weights, momentum, and provenance', () => {
  for (const expected of [
    'Onchain transfers', 'Daily metrics', 'Health components', 'Health Score', 'Activity Momentum',
    'Canonical assessment', 'Canonical verification', 'Optional onchain attestation',
    'Holder Health', '25%', 'Transfer Activity', 'Address Activity', 'Onchain Concentration',
    'Activity Consistency', 'it is not price momentum', 'Elysium Testnet', '99801', 'health-v1', '7 completed daily observations',
    '1.0', 'do not claim exhaustive coverage',
  ]) assert.ok(methodologyPageHtml.includes(expected), `methodology page should include ${expected}`);
});

test('onchain metadata only includes fields actually returned by the verification API', () => {
  assert.deepEqual(onchainMetadata(null), []);
  assert.deepEqual(onchainMetadata({ onchain: { configured: false } }), []);
  assert.deepEqual(onchainMetadata({ onchain: { configured: true, attested: false } }), []);
  // Mock values are isolated test fixtures and are not committed as production data.
  const attestedFixture = { onchain: { configured: true, contract_address: '0xtest', chain_id: 99801, attester: '0xattester', attested_at: 1790985600 } };
  const fields = onchainMetadata(attestedFixture);
  assert.deepEqual(fields.map(([label]) => label), ['Contract address', 'Chain ID', 'Attester', 'Attested at']);
  assert.ok(!fields.some(([label]) => /transaction|block|token|methodology|assessment hash/i.test(label)));
  assert.deepEqual(onchainMetadata({ onchain: { configured: true, error: 'contract_read_failed', contract_address: '0xshould-not-display' } }), []);
  assert.ok(!methodologyPageHtml.includes('explorer'));
});

test('verification flow renders hierarchy and never treats no contract as an invalid assessment', () => {
  // These isolated mock API payloads exercise presentation only; no test submits or fabricates a chain transaction.
  const notConfiguredHtml = verificationFlowHtml({ canonical_valid: true, onchain_attested: false, onchain_data_matches: false, onchain: { configured: false } });
  assert.match(notConfiguredHtml, /2 · CANONICAL VERIFICATION[\s\S]*?VALID/);
  assert.match(notConfiguredHtml, /3 · ONCHAIN ATTESTATION[\s\S]*?NOT CONFIGURED/);
  assert.match(notConfiguredHtml, /does not invalidate this assessment/);
  assert.doesNotMatch(notConfiguredHtml, /MISMATCH/);

  const invalidHtml = verificationFlowHtml({ canonical_valid: false, onchain_attested: false, onchain_data_matches: false, onchain: { configured: false } });
  assert.match(invalidHtml, /INVALID/);
  const notAttestedHtml = verificationFlowHtml({ canonical_valid: true, onchain_attested: false, onchain_data_matches: false, onchain: { configured: true, attested: false } });
  assert.match(notAttestedHtml, /NOT ATTESTED/);
  const mismatchHtml = verificationFlowHtml({ canonical_valid: true, onchain_attested: true, onchain_data_matches: false, onchain: { configured: true } });
  assert.match(mismatchHtml, /MISMATCH/);
  const unavailableHtml = verificationFlowHtml({ canonical_valid: true, onchain_attested: false, onchain_data_matches: false, onchain: { configured: true, error: 'contract_read_failed' } });
  assert.match(unavailableHtml, /VERIFICATION UNAVAILABLE/);

  const attestedHtml = verificationFlowHtml({ canonical_valid: true, onchain_attested: true, onchain_data_matches: true, assessment_hash: 'mock-hash', methodology_version: 'health-v1', onchain: { configured: true, contract_address: '0xmock-contract', chain_id: 99801 } });
  assert.match(attestedHtml, /ATTESTED/);
  assert.match(attestedHtml, /0xmock-contract/);
  assert.doesNotMatch(attestedHtml, /transaction hash|block number|explorer/i);
  assert.doesNotMatch(verificationFlowHtml(null), /0x[a-f0-9]{40,64}/i);
});

test('hash routing accepts valid pages and safely falls back for invalid pagination', () => {
  assert.deepEqual(routeFromHash('#/tokens?page=3'), { path: '/tokens', page: 3 });
  assert.deepEqual(routeFromHash('#/tokens?page=-1'), { path: '/tokens', page: 1 });
  assert.deepEqual(routeFromHash('#/tokens?page=not-a-number'), { path: '/tokens', page: 1 });
});

test('API-provided text is escaped before insertion into HTML', () => {
  assert.equal(escapeHtml(`<script a="b">'&`), '&lt;script a=&quot;b&quot;&gt;&#39;&amp;');
});

test('responsive styles adapt navigation, token discovery, overview, and history for mobile', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /@media\s*\(max-width:\s*780px\)/);
  assert.match(css, /\.main-area\s*\{\s*margin-left:\s*0/);
  assert.match(css, /\.data-table\s+thead\s*\{[^}]*clip:/s);
  assert.match(css, /\.hero-grid,\s*\.content-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.history-row\s*\{\s*grid-template-columns:\s*1fr 1fr/);
  assert.match(css, /\.method-flow\s*\{/);
  assert.match(css, /\.trust-stack\s*\{/);
});
