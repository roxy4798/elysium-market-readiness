import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assessmentAvailability,
  escapeHtml,
  ratioPercent,
  routeFromHash,
  scoreText,
  valueText,
  verificationState,
} from '../dist/presentation.js';

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
  assert.equal(verificationState({ canonical_valid: true, onchain_attested: true, onchain_data_matches: true }), 'Valid · attested');
  assert.equal(verificationState({ canonical_valid: true, onchain_attested: true, onchain_data_matches: false }), 'Mismatch');
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
});
