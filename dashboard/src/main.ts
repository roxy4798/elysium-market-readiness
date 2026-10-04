import { api, ApiError, type AssessmentComponents, type AssessmentDetail, type CanonicalAssessment, type DailyMetric, type OverviewResponse, type TokenListItem, type VerificationResponse } from './api.js';
import { assessmentAvailability, escapeHtml, ratioPercent, routeFromHash, scoreText, valueText, verificationState } from './presentation.js';
import { methodologyPageHtml } from './methodology.js';
import { verificationFlowHtml, type RecordedAttestationFields } from './trust.js';

const content = document.querySelector<HTMLElement>('#page-content')!;
const sideNav = document.querySelector<HTMLElement>('#side-nav')!;
const breadcrumb = document.querySelector<HTMLElement>('#breadcrumb')!;
const healthIndicator = document.querySelector<HTMLElement>('.system-indicator')!;
const COMPONENTS: Array<{ key: keyof AssessmentComponents; title: string; weight: string }> = [
  { key: 'holder_health', title: 'Holder Health', weight: '25%' },
  { key: 'transfer_activity', title: 'Transfer Activity', weight: '25%' },
  { key: 'address_activity', title: 'Address Activity', weight: '20%' },
  { key: 'concentration_score', title: 'Concentration Score', weight: '20%' },
  { key: 'consistency_score', title: 'Consistency', weight: '10%' },
];

let renderRevision = 0;
let loadedTokens: TokenListItem[] = [];
let tokenPage = 1;
let tokenTotal = 0;
let tokenLimit = 25;
let tokenSearch = '';

function esc(value: unknown): string { return escapeHtml(value); }
function tokenLabel(token: { name: string | null; symbol: string | null }): string {
  return token.name || token.symbol || 'Unnamed token';
}
function dateLabel(value: string | null | undefined): string { return value || 'Not available'; }
function shortAddress(address: string): string { return `${address.slice(0, 8)}…${address.slice(-6)}`; }
function tokenHref(address: string): string { return `#/tokens/${encodeURIComponent(address)}`; }
function historyHref(address: string): string { return `${tokenHref(address)}/assessments`; }
function detailHref(address: string, date: string): string { return `${historyHref(address)}/${encodeURIComponent(date)}`; }

function setShell(active: 'dashboard' | 'overview' | 'history' | 'methodology', address?: string, title?: string): void {
  breadcrumb.textContent = title ?? (active === 'dashboard' ? 'Market overview' : active === 'overview' ? 'Token overview' : active === 'history' ? 'Assessment history' : 'How it works');
  if (!address) {
    sideNav.innerHTML = `<a class="nav-link ${active === 'dashboard' ? 'active' : ''}" href="#/"><span class="nav-icon" aria-hidden="true">▦</span>Market overview</a><a class="nav-link ${active === 'methodology' ? 'active' : ''}" href="#/methodology"><span class="nav-icon" aria-hidden="true">◎</span>How it works</a>`;
    return;
  }
  sideNav.innerHTML = `
    <a class="nav-link" href="#/"><span class="nav-icon" aria-hidden="true">‹</span>All tokens</a>
    <div class="nav-token">${esc(shortAddress(address))}</div>
    <a class="nav-link ${active === 'overview' ? 'active' : ''}" href="${tokenHref(address)}"><span class="nav-icon" aria-hidden="true">◫</span>Overview</a>
    <a class="nav-link ${active === 'history' ? 'active' : ''}" href="${historyHref(address)}"><span class="nav-icon" aria-hidden="true">◷</span>Assessment history</a>
    <a class="nav-link ${active === 'methodology' ? 'active' : ''}" href="#/methodology"><span class="nav-icon" aria-hidden="true">◎</span>How it works</a>`;
}

function shellLoading(active: 'dashboard' | 'overview' | 'history', address?: string): void {
  setShell(active, address);
  content.innerHTML = `<section class="loading-panel" aria-label="Loading"><div class="skeleton sk-title"></div><div class="skeleton sk-line"></div><div class="skeleton sk-card"></div><div class="skeleton sk-card"></div></section>`;
}

function errorPanel(error: unknown, retry: string): string {
  const apiError = error instanceof ApiError ? error : null;
  if (apiError?.status === 400 && retry.startsWith('#/tokens/')) {
    const isAssessmentDate = /\/assessments\/[^/]+$/.test(retry);
    return `<section class="state-panel"><div class="state-icon" aria-hidden="true">!</div><p class="eyebrow">INVALID ${isAssessmentDate ? 'ASSESSMENT DATE' : 'TOKEN ADDRESS'}</p><h2>${isAssessmentDate ? 'Enter a valid calendar date.' : 'Enter a valid token contract address.'}</h2><p>Check the value and try again.</p><a class="button button-primary" href="${isAssessmentDate ? esc(retry.replace(/\/[^/]+$/, '')) : '#/'}">${isAssessmentDate ? 'Back to assessment history' : 'Back to market overview'}</a></section>`;
  }
  if (apiError?.status === 404) {
    if (/\/assessments\/[^/]+$/.test(retry)) {
      return `<section class="state-panel"><div class="state-icon" aria-hidden="true">?</div><p class="eyebrow">ASSESSMENT NOT FOUND</p><h2>No assessment exists for this date.</h2><p>This token is indexed, but the requested assessment record is not available.</p><a class="button button-primary" href="${esc(retry.replace(/\/[^/]+$/, ''))}">Back to assessment history</a></section>`;
    }
    return `<section class="state-panel"><div class="state-icon" aria-hidden="true">?</div><p class="eyebrow">TOKEN NOT FOUND</p><h2>This token is not in the index.</h2><p>Check the contract address or return to token discovery.</p><a class="button button-primary" href="#/">Back to market overview</a></section>`;
  }
  const message = apiError?.status === 0 ? apiError.message : 'The dashboard could not load this data. Please retry in a moment.';
  return `<section class="state-panel"><div class="state-icon" aria-hidden="true">!</div><p class="eyebrow">API ERROR${apiError?.status ? ` · ${apiError.status}` : ''}</p><h2>Data is temporarily unavailable.</h2><p>${esc(message)}</p><button class="button button-primary" type="button" data-retry="${esc(retry)}">Try again</button></section>`;
}

function statusPill(status: string | null | undefined): string {
  if (!status) return '<span class="pill pill-muted">Not assessed</span>';
  const tone = status === 'INSUFFICIENT_DATA' ? 'pill-warn' : status === 'READY' || status === 'MATURE' ? 'pill-good' : 'pill-neutral';
  const label = status === 'INSUFFICIENT_DATA' ? 'Insufficient data' : status;
  return `<span class="pill ${tone}">${esc(label)}</span>`;
}

function renderTokenRows(tokens: TokenListItem[]): string {
  if (!tokens.length) return `<tr><td colspan="7"><div class="table-empty">No tokens match this search.</div></td></tr>`;
  return tokens.map((token) => {
    const title = tokenLabel(token);
    const health = scoreText(token.health_score, token.status);
    const momentum = token.momentum === null ? 'Not available' : `${token.momentum > 0 ? '+' : ''}${valueText(token.momentum)}`;
    return `<tr>
      <td data-label="Token"><a class="token-cell" href="${tokenHref(token.address)}"><span class="token-avatar">${esc((token.symbol || title).slice(0, 1).toUpperCase())}</span><span><strong>${esc(title)}</strong><small>${esc(shortAddress(token.address))}</small></span></a></td>
      <td data-label="Symbol"><span class="symbol-text">${esc(token.symbol || '—')}</span></td>
      <td data-label="Health score"><span class="table-score ${token.health_score === null ? 'muted-value' : ''}">${esc(health)}</span></td>
      <td data-label="Activity momentum"><span class="table-score ${token.momentum === null ? 'muted-value' : ''}">${esc(momentum)}</span></td>
      <td data-label="Status">${statusPill(token.status)}</td>
      <td data-label="Latest assessment"><small class="date-cell">${esc(dateLabel(token.latest_assessment_date))}</small></td>
      <td data-label="Data availability"><span class="availability ${token.status === 'INSUFFICIENT_DATA' ? 'availability-warn' : ''}">${esc(assessmentAvailability(token.status, token.health_score))}</span></td>
    </tr>`;
  }).join('');
}

function filteredTokens(): TokenListItem[] {
  const search = tokenSearch.trim().toLocaleLowerCase();
  if (!search) return loadedTokens;
  return loadedTokens.filter((token) => [token.name, token.symbol, token.address].some((value) => value?.toLocaleLowerCase().includes(search)));
}

function renderDashboardBody(): void {
  const tbody = document.querySelector<HTMLTableSectionElement>('#token-rows');
  const matchCount = document.querySelector<HTMLElement>('#match-count');
  if (!tbody || !matchCount) return;
  const filtered = filteredTokens();
  tbody.innerHTML = renderTokenRows(filtered);
  matchCount.textContent = tokenSearch ? `${filtered.length} matches on this page` : `${tokenTotal} indexed tokens`;
}

async function renderDashboard(page: number, revision: number): Promise<void> {
  shellLoading('dashboard');
  try {
    const response = await api.tokens(page, 25);
    if (revision !== renderRevision) return;
    loadedTokens = response.tokens;
    tokenPage = response.page;
    tokenLimit = response.limit;
    tokenTotal = response.total;
    tokenSearch = '';
    const pageCount = Math.max(1, Math.ceil(response.total / response.limit));
    const firstRow = response.total === 0 ? 0 : (response.page - 1) * response.limit + 1;
    const lastRow = Math.min(response.page * response.limit, response.total);
    content.innerHTML = `
      <section class="page-heading">
        <div><p class="eyebrow">ELYSIUM · MARKET READINESS</p><h1>Market overview</h1><p class="heading-subtitle">Independent onchain market-health assessment for assets building on Elysium.</p></div>
        <div class="heading-meta"><span class="meta-label">DATA SOURCE</span><span class="meta-value"><i class="source-dot" aria-hidden="true"></i> Indexed onchain activity</span></div>
      </section>
      <section class="intro-note"><span class="intro-icon" aria-hidden="true">◈</span><p>Transparent assessments built from observable onchain activity, with deterministic verification and optional onchain attestation.</p></section>
      <section class="demo-spotlight-card" aria-label="Featured competition demo asset">
        <div class="spotlight-content">
          <span class="eyebrow">VERIFIED DEMO ASSET</span>
          <h2>ELYS · Elysium Test Token</h2>
          <p>Real Elysium testnet activity indexed · 7 completed days of historical observation · Attested onchain (Block 2492705).</p>
        </div>
        <div class="spotlight-stats">
          <div class="spotlight-metric"><span>Health Score</span><strong>34.00</strong></div>
          <div class="spotlight-metric"><span>Activity Momentum</span><strong>+4.50</strong></div>
          <div class="spotlight-metric"><span>Status</span><span class="status-pill status-early">EARLY</span></div>
          <a class="button button-primary button-small" href="#/tokens/0x245bfe8c6c2429f6a7743d53377ae39b98500459">Explore ELYS Demo →</a>
        </div>
      </section>
      <section class="summary-grid" aria-label="Market data summary">
        <article class="summary-card"><span class="summary-label">TOKENS INDEXED</span><strong>${response.total}</strong><span class="summary-foot">Discovered by the Elysium indexer</span></article>
        <article class="summary-card summary-card-wide"><span class="summary-label">ASSESSMENT AVAILABILITY</span><strong class="summary-message">Scores appear after the required historical window is available.</strong><span class="summary-foot">No score is inferred from missing data.</span></article>
      </section>
      <section class="section-card discovery-card">
        <div class="section-heading"><div><p class="eyebrow">DISCOVERY</p><h2>Indexed assets</h2></div><label class="search-box"><span class="sr-only">Search tokens on this page</span><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"></circle><path d="m13 13 4 4"></path></svg><input id="token-search" type="search" placeholder="Search this page" autocomplete="off" /></label></div>
        <p id="match-count" class="table-count"></p>
        <div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Token</th><th scope="col">Symbol</th><th scope="col">Health score</th><th scope="col">Activity momentum</th><th scope="col">Status</th><th scope="col">Latest assessment</th><th scope="col">Data availability</th></tr></thead><tbody id="token-rows">${renderTokenRows(response.tokens)}</tbody></table></div>
        ${response.total === 0 ? `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">◌</div><h3>No indexed tokens yet</h3><p>Token records will appear here when the indexer discovers validated ERC-20 activity.</p></div>` : ''}
        <div class="pagination"><span>Showing ${firstRow}–${lastRow} of ${response.total}</span><div><a class="button button-small ${page <= 1 ? 'disabled' : ''}" href="#/?page=${Math.max(1, page - 1)}" aria-label="Previous page" ${page <= 1 ? 'aria-disabled="true" tabindex="-1"' : ''}>Previous</a><span class="page-number">Page ${response.page} of ${pageCount}</span><a class="button button-small ${page >= pageCount ? 'disabled' : ''}" href="#/?page=${Math.min(pageCount, page + 1)}" aria-label="Next page" ${page >= pageCount ? 'aria-disabled="true" tabindex="-1"' : ''}>Next</a></div></div>
      </section>
      <section class="disclaimer-inline"><span aria-hidden="true">ⓘ</span> Independent assessment layer. Not an official Ascend or Elysium ranking, approval, or investment recommendation.</section>`;
    const search = document.querySelector<HTMLInputElement>('#token-search');
    search?.addEventListener('input', () => { tokenSearch = search.value; renderDashboardBody(); });
  } catch (error) {
    if (revision !== renderRevision) return;
    content.innerHTML = errorPanel(error, `#/`);
  }
}

function renderMethodology(): void {
  setShell('methodology');
  content.innerHTML = methodologyPageHtml;
}

function componentCards(components: AssessmentComponents | null | undefined): string {
  return COMPONENTS.map(({ key, title, weight }) => {
    const score = components?.[key] ?? null;
    const text = score === null ? 'Not available' : valueText(score);
    return `<article class="component-row"><div class="component-top"><div><strong>${esc(title)}</strong><span class="component-weight">Weight ${weight}</span></div><b>${esc(text)}${score === null ? '' : '<small> / 100</small>'}</b></div>${score === null ? '<div class="progress-track progress-empty"><span></span></div>' : `<progress class="score-progress" max="100" value="${Math.max(0, Math.min(100, score))}" aria-label="${esc(title)} score ${esc(text)} out of 100"></progress>`}</article>`;
  }).join('');
}

function metricCard(label: string, value: string | number): string {
  return `<article class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`;
}

function activityChart(metrics: DailyMetric[]): string {
  if (!metrics.length) return '<div class="chart-empty">No daily activity metrics are available yet.</div>';
  const width = 720; const height = 180; const padX = 14; const padY = 22;
  const max = Math.max(1, ...metrics.map((metric) => metric.transfer_count));
  const plotWidth = width - padX * 2;
  const step = plotWidth / metrics.length;
  const barWidth = Math.min(34, step * 0.7);
  const bars = metrics.map((metric, index) => {
    const h = Math.max(3, (metric.transfer_count / max) * (height - padY * 2));
    const x = padX + step * index + (step - barWidth) / 2;
    const y = height - padY - h;
    return `<g><title>${esc(metric.date)}: ${metric.transfer_count} transfers</title><rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="3" fill="#277c78"></rect></g>`;
  }).join('');
  return `<figure class="activity-figure"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily transfer counts from indexed metrics"><line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" class="chart-axis"></line>${bars}</svg><figcaption><span>Transfer count by UTC date</span><span>${esc(metrics[0]!.date)}${metrics.length > 1 ? ` — ${esc(metrics[metrics.length - 1]!.date)}` : ''}</span></figcaption></figure>`;
}

function attestationSummary(state: OverviewResponse['attestation']): string {
  if (!state.configured) return 'Not configured';
  if (state.mismatch || (state.attested && state.data_matches === false)) return 'Mismatch';
  if (state.attested && state.data_matches === null) return 'Verification unavailable';
  return state.attested ? 'Attested' : 'Not attested';
}

async function renderOverview(address: string, revision: number): Promise<void> {
  shellLoading('overview', address);
  try {
    const [overview, metricsResponse, momentumResponse] = await Promise.all([
      api.overview(address), api.metrics(address, 1, 100), api.momentum(address, 1, 100),
    ]);
    if (revision !== renderRevision) return;
    const token = overview.token;
    const assessment = overview.latest_assessment;
    const metrics = metricsResponse.metrics;
    const latestMetrics = overview.latest_metrics;
    const insufficient = assessment?.status === 'INSUFFICIENT_DATA';
    const healthText = assessment ? scoreText(assessment.health_score, assessment.status) : 'Not assessed';
    const momentumText = assessment?.momentum === null || assessment?.momentum === undefined ? 'Not available' : `${assessment.momentum > 0 ? '+' : ''}${valueText(assessment.momentum)}`;
    content.innerHTML = `
      <section class="token-title-row"><div><a class="back-link" href="#/">← All tokens</a><div class="token-identity"><span class="token-avatar token-avatar-large">${esc((token.symbol || token.name || 'T').slice(0, 1).toUpperCase())}</span><div><p class="eyebrow">TOKEN OVERVIEW</p><h1>${esc(token.name || token.symbol || 'Unnamed token')}</h1><p class="token-subtitle">${esc(token.symbol || 'Unknown symbol')} <span class="identity-dot">·</span> <span class="mono">${esc(token.address)}</span> <button class="copy-button" type="button" data-copy="${esc(token.address)}" aria-label="Copy contract address">Copy</button></p></div></div></div><div class="title-status">${statusPill(assessment?.status)}</div></section>
      ${insufficient ? `<section class="insufficient-banner" role="status"><span class="banner-icon" aria-hidden="true">!</span><div><strong>INSUFFICIENT HISTORICAL DATA</strong><p>A complete assessment requires the required historical observation window. Current indexed data is not sufficient to calculate Health Score and Activity Momentum. This is expected for newly indexed assets.</p></div></section>` : ''}
      <section class="hero-grid">
        <article class="hero-score-card"><div class="hero-top"><span class="eyebrow">HEALTH SCORE</span><span class="hero-date">${esc(dateLabel(assessment?.assessment_date))}</span></div><div class="hero-score ${assessment?.health_score == null ? 'hero-score-empty' : ''}">${assessment?.health_score == null ? '<span>—</span>' : esc(valueText(assessment.health_score))}<small>${assessment?.health_score == null ? 'Score unavailable' : '/ 100'}</small></div><div class="hero-status-row"><span class="hero-status-label">CURRENT STATUS</span>${statusPill(assessment?.status)}</div><p class="hero-help">${assessment?.health_score == null ? 'A score is shown when sufficient persisted observations are available.' : 'An independent assessment of observable onchain market health.'}</p></article>
        <article class="momentum-card"><div class="hero-top"><span class="eyebrow">ACTIVITY MOMENTUM</span><span class="range-label">−100 to +100</span></div><div class="momentum-value ${assessment?.momentum == null ? 'muted-value' : ''}">${esc(momentumText)}</div><div class="momentum-track" aria-hidden="true"><span class="momentum-mid"></span>${assessment?.momentum == null ? '' : `<span class="momentum-marker" style="left:${((assessment.momentum + 100) / 200) * 100}%"></span>`}</div><p class="hero-help">Measures recent changes in observable onchain activity relative to the prior 7-day baseline.</p><div class="momentum-foot">${momentumResponse.momentum.length} persisted observations</div></article>
      </section>
      <section class="content-grid">
        <article class="section-card component-card"><div class="section-heading"><div><p class="eyebrow">ASSESSMENT</p><h2>Component breakdown</h2></div><span class="unit-note">Scores out of 100</span></div><div class="component-list">${componentCards(assessment?.components)}</div><p class="footnote">Weights are displayed separately from the component values returned by the assessment API.</p></article>
        <article class="section-card coverage-card"><div class="section-heading"><div><p class="eyebrow">DATA COVERAGE</p><h2>Assessment window</h2></div><span class="coverage-symbol" aria-hidden="true">◷</span></div><div class="coverage-stat"><strong>${assessment ? `${assessment.data_window_days}` : '—'}</strong><span>completed days</span></div><dl class="detail-list"><div><dt>Assessment date</dt><dd>${esc(dateLabel(assessment?.assessment_date))}</dd></div><div><dt>Methodology</dt><dd>${esc(assessment?.methodology_version ?? 'Not available')}</dd></div><div><dt>Schema</dt><dd>${esc(assessment?.schema_version ?? 'Not available')}</dd></div></dl>${insufficient ? '<p class="coverage-warning">The methodology requires at least 7 completed historical observations before it can produce a normal assessment.</p>' : '<p class="coverage-hint">Coverage reflects the persisted assessment record.</p>'}</article>
      </section>
      <section class="section-card metrics-section"><div class="section-heading"><div><p class="eyebrow">ONCHAIN ACTIVITY</p><h2>Daily market metrics</h2></div><span class="unit-note">${metrics.length} observations</span></div>
        ${latestMetrics ? `<div class="metric-grid">${metricCard('Holder count',latestMetrics.holder_count)}${metricCard('New holders',latestMetrics.new_holders)}${metricCard('Active holders',latestMetrics.active_holders)}${metricCard('Transfer count',latestMetrics.transfer_count)}${metricCard('Unique senders',latestMetrics.unique_senders)}${metricCard('Unique receivers',latestMetrics.unique_receivers)}${metricCard('Onchain holder concentration · top 1',ratioPercent(latestMetrics.top1_concentration))}${metricCard('Onchain holder concentration · top 5',ratioPercent(latestMetrics.top5_concentration))}${metricCard('Onchain holder concentration · top 10',ratioPercent(latestMetrics.top10_concentration))}</div>` : '<div class="chart-empty">No daily metrics are available for this token.</div>'}
        <div class="chart-wrap"><div class="chart-heading"><strong>Transfer activity</strong><span>From persisted daily metrics</span></div>${activityChart(metrics)}</div>
      </section>
      <section class="section-card attestation-strip"><div><p class="eyebrow">DETERMINISTIC VERIFICATION</p><h2>Verification & attestation</h2><p>Canonical verification checks the persisted assessment identity and hash. Onchain attestation is reported separately.</p></div><div class="attestation-status">${statusPill(attestationSummary(overview.attestation).toUpperCase().replaceAll(' ', '_'))}<span>${esc(attestationSummary(overview.attestation))}</span></div></section>
      <div class="page-actions"><a class="button button-primary" href="${historyHref(address)}">View assessment history <span aria-hidden="true">→</span></a></div>`;
  } catch (error) {
    if (revision !== renderRevision) return;
    content.innerHTML = errorPanel(error, tokenHref(address));
  }
}

async function historyVerification(assessment: CanonicalAssessment): Promise<string> {
  if (assessment.status === 'INSUFFICIENT_DATA' || assessment.assessment_id === null) return 'Insufficient data';
  try { return verificationState(await api.verification(assessment.assessment_id)); }
  catch { return 'Verification unavailable'; }
}

function historyRows(address: string, assessments: CanonicalAssessment[], states: string[]): string {
  if (!assessments.length) return '<div class="empty-state"><div class="empty-symbol" aria-hidden="true">◷</div><h3>No assessment history</h3><p>Persisted assessments will appear here when available.</p></div>';
  return assessments.map((assessment, i) => {
    const insufficient = assessment.status === 'INSUFFICIENT_DATA';
    const id = assessment.assessment_id;
    const health = scoreText(assessment.health_score, assessment.status);
    const momentum = assessment.momentum === null ? 'Not available' : `${assessment.momentum > 0 ? '+' : ''}${valueText(assessment.momentum)}`;
    const state = states[i] ?? 'Not checked';
    return `<article class="history-row">
      <div class="history-date"><span class="eyebrow">ASSESSMENT DATE</span><a href="${detailHref(address, assessment.assessment_date)}">${esc(assessment.assessment_date)} <span aria-hidden="true">↗</span></a></div>
      <div class="history-cell"><span>Health score</span><strong class="${assessment.health_score === null ? 'muted-value' : ''}">${esc(health)}</strong></div>
      <div class="history-cell"><span>Activity momentum</span><strong class="${assessment.momentum === null ? 'muted-value' : ''}">${esc(momentum)}</strong></div>
      <div class="history-cell"><span>Status</span>${statusPill(assessment.status)}</div>
      <div class="history-cell"><span>Methodology</span><strong>${esc(assessment.methodology_version)}</strong></div>
      <div class="history-cell history-id"><span>Assessment ID</span>${id ? `<span class="mono id-value">${esc(shortAddress(id))}<button type="button" class="copy-button" data-copy="${esc(id)}" aria-label="Copy assessment ID">Copy</button></span>` : '<strong class="muted-value">Not generated</strong>'}</div>
      <div class="history-cell"><span>Verification</span><span class="verification-label ${state.toLowerCase().includes('valid') ? 'verification-good' : state.toLowerCase().includes('mismatch') || insufficient ? 'verification-warn' : ''}">${esc(insufficient ? 'Insufficient data' : state)}</span></div>
      <a class="history-open" href="${detailHref(address, assessment.assessment_date)}" aria-label="Open assessment for ${esc(assessment.assessment_date)}">Open assessment <span aria-hidden="true">→</span></a>
    </article>`;
  }).join('');
}

async function renderHistory(address: string, page: number, revision: number): Promise<void> {
  shellLoading('history', address);
  try {
    const response = await api.assessments(address, page, 25);
    if (revision !== renderRevision) return;
    const states = await Promise.all(response.assessments.map(historyVerification));
    if (revision !== renderRevision) return;
    const pageCount = Math.max(1, Math.ceil(response.total / response.limit));
    content.innerHTML = `
      <section class="page-heading compact-heading"><div><p class="eyebrow">TOKEN HISTORY</p><h1>Assessment history</h1><p class="heading-subtitle">Persisted assessments for <span class="mono">${esc(shortAddress(address))}</span>. Values are presented as stored by the assessment engine.</p></div><a class="button button-small" href="${tokenHref(address)}">Token overview</a></section>
      ${response.assessments.some((row) => row.status === 'INSUFFICIENT_DATA') ? `<section class="insufficient-banner small-banner" role="status"><span class="banner-icon" aria-hidden="true">!</span><div><strong>INSUFFICIENT HISTORICAL DATA</strong><p>Entries without a complete historical window do not have a Health Score, Momentum, canonical assessment ID, or hash.</p></div></section>` : ''}
      <section class="section-card history-card"><div class="section-heading"><div><p class="eyebrow">PERSISTED RECORDS</p><h2>${response.total} assessment${response.total === 1 ? '' : 's'}</h2></div><span class="unit-note">Newest first</span></div>
        ${historyRows(address, response.assessments, states)}
        <div class="pagination"><span>${response.total} records</span><div><a class="button button-small ${page <= 1 ? 'disabled' : ''}" href="${historyHref(address)}?page=${Math.max(1, page - 1)}" ${page <= 1 ? 'aria-disabled="true" tabindex="-1"' : ''}>Previous</a><span class="page-number">Page ${response.page} of ${pageCount}</span><a class="button button-small ${page >= pageCount ? 'disabled' : ''}" href="${historyHref(address)}?page=${Math.min(pageCount, page + 1)}" ${page >= pageCount ? 'aria-disabled="true" tabindex="-1"' : ''}>Next</a></div></div>
      </section>`;
  } catch (error) {
    if (revision !== renderRevision) return;
    content.innerHTML = errorPanel(error, historyHref(address));
  }
}

function coverageError(body: unknown): { reason: string; date: string; windowDays: number } | null {
  if (!body || typeof body !== 'object' || !('error' in body) || body.error !== 'INSUFFICIENT_DATA') return null;
  const insufficient = body as { reason?: string; assessment_date?: string; data_window_days?: number };
  return { reason: insufficient.reason ?? 'INSUFFICIENT_HISTORICAL_WINDOW', date: insufficient.assessment_date ?? 'Not available', windowDays: insufficient.data_window_days ?? 0 };
}

function detailSuccess(address: string, result: AssessmentDetail, verification: VerificationResponse | null, recorded: RecordedAttestationFields | null): string {
  const components = result.components;
  const rows = [
    ['Token address', `<span class="mono">${esc(address)}</span> <button class="copy-button" type="button" data-copy="${esc(address)}" aria-label="Copy token address">Copy</button>`],
    ['Assessment ID', result.assessment_id ? `<span class="mono">${esc(result.assessment_id)}</span> <button class="copy-button" type="button" data-copy="${esc(result.assessment_id)}" aria-label="Copy assessment ID">Copy</button>` : '<span>Not available</span>'],
    ['Assessment date', esc(result.assessment_date)],
    ['Health score', esc(scoreText(result.health_score, result.status))],
    ['Activity Momentum', esc(valueText(result.momentum))],
    ['Status', statusPill(result.status)],
    ['Methodology version', esc(result.methodology_version)],
    ['Schema version', esc(result.schema_version)],
    ['Assessment hash', result.assessment_hash ? `<span class="mono">${esc(result.assessment_hash)}</span> <button class="copy-button" type="button" data-copy="${esc(result.assessment_hash)}" aria-label="Copy assessment hash">Copy</button>` : '<span>Not available</span>'],
  ];
  return `<section class="page-heading compact-heading">
      <div>
        <p class="eyebrow">CANONICAL ASSESSMENT</p>
        <h1>Assessment detail</h1>
        <p class="heading-subtitle">${esc(result.token.symbol)} · ${esc(result.assessment_date)}</p>
      </div>
      <div class="heading-actions">
        <a class="button button-small" href="#/methodology">Methodology</a>
        <a class="button button-small" href="${historyHref(address)}">Assessment history</a>
      </div>
    </section>
    <section class="trust-stack" aria-label="Assessment, canonical verification, and onchain attestation">
      <article class="section-card trust-step assessment-step">
        <div class="section-heading">
          <div><p class="eyebrow">1 · ASSESSMENT</p><h2>Persisted assessment</h2></div>
          ${statusPill(result.status)}
        </div>
        <dl class="detail-list detail-list-wide">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
        <div class="trust-components">
          <p class="eyebrow">COMPONENT SCORES RETURNED BY THE API</p>
          <div class="component-list">${componentCards(components)}</div>
          <p class="method-note">Weights are displayed separately from the component values returned by the assessment API. <a href="#/methodology" class="inline-link">Learn how these 5 components are calculated →</a></p>
        </div>
      </article>
      ${verificationFlowHtml(verification, recorded)}
      <article class="section-card trust-step provenance-card" aria-labelledby="provenance-detail-title">
        <div class="section-heading"><div><p class="eyebrow">4 · PROVENANCE</p><h2 id="provenance-detail-title">Data provenance & integrity</h2></div></div>
        <dl class="detail-list">
          <div><dt>Data source</dt><dd>Elysium Testnet</dd></div>
          <div><dt>Chain</dt><dd>99801</dd></div>
          <div><dt>Assessment</dt><dd>Per-token, per-date</dd></div>
          <div><dt>Methodology</dt><dd class="mono">health-v1</dd></div>
          <div><dt>Canonicalization</dt><dd>Deterministic</dd></div>
          <div><dt>Integrity</dt><dd>SHA-256 assessment hash</dd></div>
          <div><dt>Onchain proof</dt><dd class="mono">ElysiumAssessmentAttestation</dd></div>
        </dl>
      </article>
    </section>
    <p class="disclaimer-inline">Independent assessment layer. Not an official Ascend or Elysium ranking, approval, or investment recommendation.</p>`;
}

async function renderAssessmentDetail(address: string, date: string, revision: number): Promise<void> {
  shellLoading('history', address);
  try {
    const result = await api.assessment(address, date);
    if (revision !== renderRevision) return;
    const assessment = result;
    let verification: VerificationResponse | null = null;
    let recordedAttestation: RecordedAttestationFields | null = null;
    if (assessment.assessment_id) {
      try { verification = await api.verification(assessment.assessment_id); }
      catch { verification = null; }
      if (verification?.onchain_attested && verification.onchain_data_matches) {
        try {
          const overview = await api.overview(address);
          if (overview.latest_assessment?.assessment_id === assessment.assessment_id && overview.attestation.attested && overview.attestation.data_matches === true) {
            recordedAttestation = overview.attestation;
          }
        } catch { recordedAttestation = null; }
      }
    }
    if (revision !== renderRevision) return;
    const verificationInput = verification && assessment.assessment_id
      ? { ...verification, assessment_id: assessment.assessment_id }
      : verification;
    content.innerHTML = detailSuccess(address, assessment, verificationInput, recordedAttestation);
  } catch (error) {
    if (revision !== renderRevision) return;
    const state = error instanceof ApiError && error.status === 422 ? coverageError(error.body) : null;
    if (state) {
      content.innerHTML = `<section class="page-heading compact-heading"><div><p class="eyebrow">ASSESSMENT DETAIL</p><h1>${esc(state.date || date)}</h1><p class="heading-subtitle">${esc(shortAddress(address))}</p></div><a class="button button-small" href="${historyHref(address)}">Assessment history</a></section>
        <section class="insufficient-detail" role="status"><div class="state-icon state-icon-warn" aria-hidden="true">!</div><p class="eyebrow">INSUFFICIENT HISTORICAL DATA</p><h2>No numerical assessment was produced.</h2><p>A complete assessment requires the required historical observation window. Current indexed data is insufficient to calculate Health Score or Activity Momentum.</p><dl class="detail-list"><div><dt>Assessment date</dt><dd>${esc(state.date || date)}</dd></div><div><dt>Data window</dt><dd>${state.windowDays} completed days</dd></div><div><dt>Reason</dt><dd class="mono">${esc(state.reason)}</dd></div></dl></section>`;
      return;
    }
    content.innerHTML = errorPanel(error, detailHref(address, date));
  }
}

async function updateHealthIndicator(): Promise<void> {
  try {
    await api.health();
    healthIndicator.innerHTML = '<i aria-hidden="true"></i> API available';
    healthIndicator.classList.remove('system-offline');
  } catch {
    healthIndicator.innerHTML = '<i aria-hidden="true"></i> API unavailable';
    healthIndicator.classList.add('system-offline');
  }
}

function render(): void {
  const revision = ++renderRevision;
  const route = routeFromHash(location.hash);
  const segments = route.path.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (!segments.length) { void renderDashboard(route.page, revision); return; }
  if (segments.length === 1 && segments[0] === 'methodology') { renderMethodology(); return; }
  if (segments[0] === 'tokens' && segments[1]) {
    const address = segments[1];
    if (segments[2] === 'assessments' && segments[3]) { void renderAssessmentDetail(address, segments[3], revision); return; }
    if (segments[2] === 'assessments') { void renderHistory(address, route.page, revision); return; }
    void renderOverview(address, revision);
    return;
  }
  setShell('dashboard');
  breadcrumb.textContent = 'Page not found';
  content.innerHTML = `<section class="state-panel"><div class="state-icon" aria-hidden="true">?</div><p class="eyebrow">NOT FOUND</p><h2>This dashboard page does not exist.</h2><a class="button button-primary" href="#/">Back to market overview</a></section>`;
}

document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const retry = target.closest<HTMLElement>('[data-retry]')?.dataset['retry'];
  if (retry) { location.hash = retry; return; }
  const copy = target.closest<HTMLElement>('[data-copy]')?.dataset['copy'];
  if (copy) {
    const button = target.closest<HTMLButtonElement>('[data-copy]');
    try {
      await navigator.clipboard.writeText(copy);
      if (button) { button.textContent = 'Copied'; window.setTimeout(() => { button.textContent = 'Copy'; }, 1400); }
    } catch {
      if (button) button.textContent = 'Copy manually';
    }
  }
});

window.addEventListener('hashchange', render);
void updateHealthIndicator();
render();
