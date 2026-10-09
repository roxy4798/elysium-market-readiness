# Meteora DBC Competition Strategy — Working Brief

Status: strategy and specification only. This file does not claim that Meteora integration has been implemented.

## Competition target

Superteam Earn: Best Use of Meteora's Dynamic Bonding Curve (DBC), Crypto World's Fair.
Official hackathon submission deadline shown by Colosseum: 12 October 2026.
Verify the live track page and all submission fields before final submission.

## Competitive positioning

Research surfaced existing entries/projects in adjacent territory:
- StockCurve: https://github.com/ExpertVagabond/stockcurve
- EquityCurve: https://github.com/sidsri14/equitycurve
- Meteora FastRadar: https://github.com/chijesusboy2004-crypto/meteora-fastradar

Do not pitch a generic tokenized-stock launchpad, oracle price monitor, or real-time DBC pool radar as the sole differentiator.

## Working product thesis

Working name: AURORA — Adaptive Launch Infrastructure (name not finalized; trademark/name availability not checked).

A DBC configuration intelligence platform for builders that compares launch designs before deployment, simulates transparent stress scenarios, emits reproducible configuration artifacts, and verifies the resulting on-chain pool against its selected preset.

Core loop:
1. Choose an asset launch profile and explicit assumptions.
2. Generate a valid Meteora DBC SDK configuration artifact.
3. Run parameterized simulation/stress cases and show method, assumptions, limitations, curve, estimated price impact, quote-reserve requirements, and graduation progress.
4. Hash/version the preset and export a human-readable + machine-readable audit bundle.
5. Read a real DBC pool state via the official SDK/RPC; verify config/pool/migration details.
6. Optional transaction path only after simulation, explicit wallet confirmation, tests and network labels; no hidden/automatic mainnet transactions.

## What must be implemented for a credible submission

### P0 — Product integrity and demo
- polished live web app with three compelling preset comparisons
- chart visualizing curve shape and hypothetical buy/sell scenarios
- explicit SIMULATED vs LIVE ON-CHAIN labels
- machine-readable config export (JSON) and reproducible preset hash
- clear source references to official Meteora SDK/program docs
- read-only mainnet DBC pool lookup by address or base mint
- live on-chain data state, explorer links, pool progress and migration state
- complete README, architecture diagram, test commands, limitations and video/demo script

### P1 — DBC integration
Use official packages and verify against current SDK typings:
- @meteora-ag/dynamic-bonding-curve-sdk
- @solana/web3.js compatible versions
- DynamicBondingCurveClient read methods for pools/configs and progress
- official curve-building helpers and quote functions where suitable
- DAMM v2 SDK/read path for migrated pool verification

Known official docs/repositories:
- https://docs.meteora.ag/developer-guides/dbc
- https://docs.meteora.ag/developer-guides/damm-v2
- https://github.com/MeteoraAg/dynamic-bonding-curve-sdk
- https://github.com/MeteoraAg/dynamic-bonding-curve
- https://github.com/MeteoraAg/meteora-invent

DBC values include configurable curve segments, quote mint, fee schedule, migration threshold/option, token type/decimals, liquidity distribution and partner/creator settings. New configs should use DAMM v2 path; DAMM v1 and rate limiter settings are deprecated for new configs according to current official references. Reconfirm SDK version before coding.

### P2 — Evidence and validation
- unit tests for input validation, serialization/hash determinism, config schema, scenario math and boundary conditions
- SDK quote calculations compared against independent test vectors where feasible
- integration test(s) read existing public mainnet pool state
- fail closed on stale/missing data and unsupported mints/configs
- screen recordings showing the product working, not a static mockup
- publish only verifiable metrics; no invented users, volume, transactions, partnerships, or benchmark claims

## Proposed judging story
1. DBC is not just a launch button: curve/fees/migration are part of asset market design.
2. Builders currently face configuration complexity and cannot easily compare tradeoffs before creating a pool.
3. AURORA lets builders compare scenarios, make their parameter choices reproducible and then verify a real pool against the selected design.
4. Meteora DBC is central because real SDK config generation, quotes/state reads, migration progress and DAMM v2 handoff are core workflows rather than branding.

## Risks / guardrails
- Do not market simulation output as guaranteed price, liquidity, safety, or investment outcomes.
- Do not suggest tokenized securities are legally compliant by default; eligibility depends on issuer, jurisdiction, underlying asset and token rights.
- Never put private keys or seed phrases in the browser or repository.
- Default network should be read-only / devnet; mainnet writes require explicit confirmation and clear fees.
- Clearly distinguish demo data, synthetic stress scenarios, API data and actual on-chain state.
- No unsupported claims about competitors; use their public project pages only as competitive context.

## Suggested final submission description (only after implementation matches it)

AURORA is a DBC configuration intelligence workspace for Solana builders. It lets teams compare launch curves and fee designs under transparent stress scenarios, export reproducible configuration presets, and inspect how a real Meteora DBC pool progresses toward DAMM v2. Each result is labeled as simulated or on-chain, with assumptions and verification details visible so builders can evaluate tradeoffs before committing funds.

This wording is aspirational until the described features are implemented and verified.