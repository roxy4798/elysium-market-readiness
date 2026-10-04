export const methodologyPageHtml = `<div class="methodology-page">
  <section class="page-heading methodology-heading">
    <div><p class="eyebrow">TRANSPARENT PROCESS</p><h1>How it works</h1><p class="heading-subtitle">An independent assessment built from the transfer activity this indexer observes. Every score and proof state comes from the existing assessment and verification APIs.</p></div>
  </section>
  <section class="section-card methodology-flow-card" aria-labelledby="method-flow-title">
    <div class="section-heading"><div><p class="eyebrow">DATA TO PROOF</p><h2 id="method-flow-title">The assessment pipeline</h2></div><span class="unit-note">health-v1 · schema 1.0</span></div>
    <ol class="method-flow">
      <li><strong>Onchain transfers</strong><span>ERC-20 Transfer events observed by the indexer</span></li>
      <li><strong>Daily metrics</strong><span>Holder, transfer, address activity, and concentration observations</span></li>
      <li><strong>Health components</strong><span>Five component values returned by the assessment engine</span></li>
      <li><strong>Health Score</strong><span>Weighted result from 0 to 100, when enough history exists</span></li>
      <li><strong>Activity Momentum</strong><span>Activity change versus the prior seven-day baseline</span></li>
      <li><strong>Canonical assessment</strong><span>Versioned assessment fields with a deterministic identity and hash</span></li>
      <li><strong>Canonical verification</strong><span>Reconstruct the payload and compare its ID and hash with persisted values</span></li>
      <li><strong>Optional onchain attestation</strong><span>When configured, compare an immutable contract record with the canonical assessment</span></li>
    </ol>
  </section>
  <section class="section-card methodology-components" aria-labelledby="component-method-title">
    <div class="section-heading"><div><p class="eyebrow">HEALTH SCORE</p><h2 id="component-method-title">Five weighted components</h2></div><span class="unit-note">Scale: 0 to 100</span></div>
    <div class="method-component-grid">
      <article><strong>Holder Health</strong><b>25%</b><p>New holders relative to the prior holder count.</p></article>
      <article><strong>Transfer Activity</strong><b>25%</b><p>Transfer count relative to its prior seven-day median.</p></article>
      <article><strong>Address Activity</strong><b>20%</b><p>Active holders relative to their prior seven-day median.</p></article>
      <article><strong>Onchain Concentration</strong><b>20%</b><p>Holder concentration from the top 1, 5, and 10 holder shares. Concentration is based on onchain balances, not investor identity.</p></article>
      <article><strong>Activity Consistency</strong><b>10%</b><p>Share of prior seven daily observations with at least one transfer.</p></article>
    </div>
    <p class="method-note">Health Score is NOT a safety score and is NOT a liquidity score. The dashboard presents component values and final scores returned by the existing assessment API. It does not calculate or infer scores.</p>
  </section>
  <section class="content-grid method-notes-grid">
    <article class="section-card method-note-card"><p class="eyebrow">ACTIVITY MOMENTUM</p><h2>Activity, not price</h2><p>Activity momentum based on transfer count, active holders, and new holders compared against the prior 7-day baseline. Momentum summarizes observed onchain activity only; <strong>it is not price momentum</strong> and is <strong>NOT a trading signal</strong>. It carries zero financial prediction.</p></article>
    <article class="section-card method-note-card"><p class="eyebrow">CANONICAL PROOF</p><h2>Integrity and attestation are separate</h2><p>Canonical verification checks the deterministic assessment identity and payload hash. Onchain attestation is optional: when configured, the verifier also compares the contract’s stored hash, token, UTC date, and methodology. An unconfigured contract does not make a canonical assessment invalid.</p></article>
  </section>
  <section class="section-card provenance-card" aria-labelledby="provenance-title">
    <div class="section-heading"><div><p class="eyebrow">DATA PROVENANCE</p><h2 id="provenance-title">What this dashboard represents</h2></div></div>
    <dl class="provenance-list">
      <div><dt>Network</dt><dd>Elysium Testnet · Chain ID 99801</dd></div>
      <div><dt>Data source</dt><dd>ERC-20 Transfer events observed by this indexer</dd></div>
      <div><dt>Assessment</dt><dd>Per-token, per-date</dd></div>
      <div><dt>Assessment methodology</dt><dd class="mono">health-v1</dd></div>
      <div><dt>Historical window</dt><dd>7 completed daily observations before the assessment date</dd></div>
      <div><dt>Assessment schema</dt><dd>1.0</dd></div>
      <div><dt>Canonicalization</dt><dd>Deterministic</dd></div>
      <div><dt>Integrity</dt><dd>SHA-256 assessment hash</dd></div>
      <div><dt>Onchain proof</dt><dd class="mono">ElysiumAssessmentAttestation</dd></div>
    </dl>
    <p class="method-note">Indexed tokens and history reflect this indexer’s observations; they do not claim exhaustive coverage of every Elysium asset or block.</p>
  </section>
  <p class="disclaimer-inline">Independent assessment layer. Not an official Ascend or Elysium ranking, approval, or investment recommendation.</p></div>`;
