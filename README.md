# Elysium Market Readiness

**Independent, transparent, onchain market-health and market-progression assessment layer for assets building on Elysium.**

> [!IMPORTANT]
> **DISCLAIMERS:**
> - This is **NOT** an official Ascend product.
> - This is **NOT** an official Elysium product.
> - This is **NOT** an Ascend ranking or approval system.
> - This does **NOT** predict token prices or token success.
> - Built as an independent developer submission for the **Ascend Elysium Builder Competition**.

---

## 1. Project Overview & Scope

**Current Status:**
- **Phase 1**: ERC-20 Indexer & Onchain Data Layer (COMPLETE)
- **Phase 2A**: Raw Market Metrics Engine (COMPLETE)
- **Phase 2B**: Market Health Score V1 & Market Momentum Assessment Engine (COMPLETE)

### Core Capabilities:
- **Testnet RPC Connectivity**: Connects directly to **Elysium Testnet** (`Chain ID: 99801`, gas token `HYPE`).
- **ERC-20 Event Indexer**: Discovers, decodes, and indexes onchain `Transfer(address,address,uint256)` event logs.
- **Strict Onchain Validation**: Multi-call contract checks (`decimals()`, `totalSupply()`, `name()`, `symbol()`), filtering non-ERC20s, NFTs, and reverts.
- **Deterministic Raw Metrics Engine**: Converts indexed transfers and balances into daily raw market metrics with zero estimates and zero synthetic data.
- **Deterministic Assessment Engine (Phase 2B)**: Computes Market Health Score (0–100), Market Momentum (-100 to +100), and categorical Status (`EARLY`, `BUILDING`, `DEVELOPING`, `MATURE`, `READY`) with zero future lookahead.
- **Idempotent PostgreSQL Storage**: Atomic transactional persistence with conflict handling on `transfers`, `daily_metrics`, and `market_assessments`.
- **Fault-Tolerant Checkpointing**: Durable checkpoint tracking in PostgreSQL allowing clean stop/resume cycles without gaps or re-indexing.

---

## 2. Network Specification

| Parameter | Value |
|---|---|
| **Network Name** | Elysium Testnet |
| **Chain ID** | `99801` |
| **RPC Endpoint** | `https://testnet-rpc.elysium.kinetiq.xyz` |
| **Native Gas Token** | `HYPE` |

---

## 3. Project Structure

```text
elysium-market-readiness/
├── .gitignore                      # Root gitignore (excludes secrets, builds, runtime data)
├── README.md                       # Architecture, setup, and Phase 1 / 2A / 2B documentation
├── database/
│   └── schema.sql                  # PostgreSQL idempotent schema & indexes
└── indexer/
    ├── .env.example                # Safe environment template with placeholders
    ├── package.json                # Dependencies, scripts, and engine constraints
    ├── tsconfig.json               # TypeScript base config
    ├── tsconfig.build.json         # TypeScript production build config
    ├── eslint.config.js            # Linter configuration
    ├── src/
    │   ├── abi/
    │   │   └── erc20.ts            # Minimal ERC-20 ABI & Transfer event definitions
    │   ├── checkpoint.ts           # Durable checkpointing & safe target block planner
    │   ├── client.ts               # Viem client, RPC retry wrapper & error classifier
    │   ├── config.ts               # Env parsing, validation, and password redactor
    │   ├── database.ts             # PostgreSQL pool & transactional repository
    │   ├── holder-engine.ts        # Pure in-memory accounting & balance anomalies
    │   ├── logger.ts               # Leveled JSON/text console logger
    │   ├── main.ts                 # CLI entrypoint (run, migrate, doctor, metrics, assess)
    │   ├── scanner.ts              # Adaptive log fetcher, pipeline orchestrator
    │   ├── token-validator.ts      # Multi-call ERC-20 validator & bytes32 decoder
    │   ├── transfer-processor.ts   # 3-topic Transfer log decoder & deduplicator
    │   ├── metrics/
    │   │   ├── types.ts            # Metrics data structures & Transfer interfaces
    │   │   ├── activity-metrics.ts # Transfer count, senders, receivers, active holders
    │   │   ├── holder-metrics.ts   # End-of-day holder count & new holder detection
    │   │   ├── concentration-metrics.ts # Onchain holder concentration (Top 1, 5, 10)
    │   │   └── daily-metrics.ts    # Coordinator, date boundaries, and DB upserts
    │   └── assessment/
    │       ├── types.ts            # Assessment interfaces, components & status types
    │       ├── scoring.ts          # Pure scoring functions, weights, interpolation & momentum
    │       └── assessment-engine.ts# Lookahead-free coordinator & DB upserts
    └── tests/
        ├── checkpoint.test.ts      # Checkpoint persistence and crash recovery tests
        ├── config.test.ts          # Config loading and credential redaction tests
        ├── daily-metrics.test.ts   # 15 deterministic raw metrics & edge case tests
        ├── assessment.test.ts      # 21 deterministic assessment, status & momentum tests
        ├── holder-engine.test.ts   # Invariant and balance accounting tests
        ├── rpc-resilience.test.ts  # Adaptive batching, retry, rate limit tests
        ├── transfer-processor.test.ts # Transfer log decoding and validation tests
        └── helpers/
            ├── fakes.ts            # Mock viem chain & RPC fault injectors
            └── memory-store.ts     # In-memory transactional test store
```

---

## 4. Architecture & Data Flow

```text
                     ┌────────────────────────────────────────┐
                     │   Elysium Testnet RPC (Chain 99801)    │
                     │  https://testnet-rpc.elysium.kinetiq.xyz│
                     └───────────────────▲────────────────────┘
                                         │
                        eth_getLogs      │  readContract (decimals,
                        (Transfer topic) │  totalSupply, name, symbol)
                                         │
┌────────────────────────────────────────┴────────────────────────────────────────┐
│ Phase 1: Ingestion Pipeline                                                     │
│                                                                                 │
│  1. Checkpoint Loader ──► Determines next unprocessed block range               │
│  2. AdaptiveLogFetcher ──► Queries logs with auto-halving / auto-growth         │
│  3. Transfer Decoder   ──► Validates 3-topic Transfer layout (uint256 amount)   │
│  4. TokenValidator     ──► Filters non-ERC20s & NFTs; caches rejections         │
│  5. BlockTimestampCache──► Resolves & seeds timestamps (0-cost when in log)     │
│  6. HolderEngine       ──► Mint/burn/transfer balance accounting (non-negative) │
│  7. PgStore (Tx)       ──► Atomic commit: tokens + transfers + balances + CP    │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                     ┌───────────────────▼────────────────────┐
                     │         PostgreSQL Database            │
                     │  - tokens                              │
                     │  - transfers (UNIQUE tx_hash,log_index)│
                     │  - balances (CHECK balance >= 0)       │
                     │  - indexer_state (checkpoint)          │
                     │  - daily_metrics (PK: token, date)     │
                     │  - market_assessments (PK: token, date)│
                     └───────────────────┬────────────────────┘
                                         │
┌────────────────────────────────────────┴────────────────────────────────────────┐
│ Phase 2A: Deterministic Raw Metrics Engine                                      │
│                                                                                 │
│  1. Activity Aggregator   ──► transfer_count, unique senders, receivers, active │
│  2. Holder Balance Engine ──► end-of-day holder_count (> 0) & new_holders (0->+)│
│  3. Concentration Engine  ──► top1, top5, top10 onchain holder concentration   │
│  4. Idempotent Upserter   ──► ON CONFLICT (token_address, date) DO UPDATE       │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
┌────────────────────────────────────────┴────────────────────────────────────────┐
│ Phase 2B: Market Health Score V1 & Momentum Assessment Engine                  │
│                                                                                 │
│  1. Rolling Median Baseline ──► 7-day median for transfers, active & new holders│
│  2. Component Evaluator     ──► Holder (25%), Transfers (25%), Active (20%),   │
│                                 Concentration (20%), Consistency (10%)          │
│  3. Status Classifier       ──► EARLY, BUILDING, DEVELOPING, MATURE, READY      │
│  4. Market Momentum         ──► -100 to +100 activity change vs 7d baseline     │
│  5. Idempotent Upserter     ──► market_assessments (PK: token_address, date)    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Database Schema & Reproducibility

Defined in [database/schema.sql](file:///c:/ELYSIUM/elysium-market-readiness/database/schema.sql):
- **`tokens`**: `address` (PK, lowercase), `name`, `symbol`, `decimals`, `total_supply`, `first_seen_block`, `last_seen_block`, `balance_anomalies`.
- **`transfers`**: `id` (BIGSERIAL PK), `token_address`, `tx_hash`, `log_index`, `block_number`, `block_timestamp`, `from_address`, `to_address`, `amount`. Unique index on `(tx_hash, log_index)`.
- **`balances`**: `token_address`, `holder_address`, `balance` (`CHECK balance >= 0`), `last_updated_block`. Primary key on `(token_address, holder_address)`.
- **`indexer_state`**: Single-row checkpoint table storing `last_processed_block` and `updated_at`.
- **`daily_metrics`**: `token_address`, `date`, `holder_count`, `new_holders`, `active_holders`, `transfer_count`, `unique_senders`, `unique_receivers`, `top1_concentration`, `top5_concentration`, `top10_concentration`, timestamps. Primary key on `(token_address, date)`.
- **`market_assessments`**: `token_address`, `assessment_date`, `health_score`, `status`, `momentum`, `holder_health`, `transfer_activity`, `address_activity`, `concentration_score`, `consistency_score`, `data_window_days`, `reason`, timestamps. Primary key on `(token_address, assessment_date)`.

The database is 100% reproducible from [database/schema.sql](file:///c:/ELYSIUM/elysium-market-readiness/database/schema.sql) and `npm run migrate`.

---

## 6. Phase 2A — Raw Market Metrics

Phase 2A converts indexed ERC-20 transfer and holder balance data into daily raw market metrics.

### Metric Definitions:
1. **`holder_count`**: Number of token holders with a positive balance (`> 0`) at the end of the selected day (`23:59:59.999 UTC`). Excludes zero address (`0x000...000`).
2. **`new_holders`**: Number of addresses that became holders for the first time on the selected day (balance transitioned from `0 → positive`). Excludes existing holders receiving additional tokens, self-transfers, zero address, and burns. Counted at most once per address.
3. **`active_holders`**: Number of unique non-zero addresses participating in at least one valid transfer of the token during the selected day (`unique(from_address) UNION unique(to_address)`).
4. **`transfer_count`**: Number of valid ERC-20 Transfer events stored for the token on the selected day.
5. **`unique_senders`**: Number of unique non-zero `from_address` values for the token on the selected day.
6. **`unique_receivers`**: Number of unique non-zero `to_address` values for the token on the selected day.
7. **`top1_concentration`**, **`top5_concentration`**, **`top10_concentration`**:
   - `top 1 holder balance / total tracked positive balance`
   - `sum of top 5 holder balances / total tracked positive balance`
   - `sum of top 10 holder balances / total tracked positive balance`
   - Stored as decimal ratios between `0` and `1` (e.g. `0.25` for 25%). Calculated strictly using BigInt arithmetic to eliminate IEEE 754 floating point precision errors.

### UTC Date Convention:
All daily metrics use **UTC** calendar boundaries exclusively (`YYYY-MM-DD 00:00:00.000Z` to `YYYY-MM-DD 23:59:59.999Z`). Local machine timezones never influence metric calculation.

### Concentration Terminology & Limitations:
- These metrics measure **onchain holder concentration**, NOT "investor concentration" or "human ownership concentration".
- Onchain addresses cannot automatically be assumed to represent individual human beings (contracts, liquidity pools, exchanges, or single users with multiple wallets are not distinguished at this layer).
- If a token has zero positive holders or no transfers, concentration ratios are stored as `null`.

### Historical Range & Missing Data Handling:
- The metrics engine works deterministically on whatever indexed data exists in PostgreSQL.
- If a requested date precedes the earliest indexed block or exceeds the latest indexed block checkpoint, the CLI returns a clear `INSUFFICIENT_INDEXED_DATA` status explaining the exact block boundary.
- No synthetic or estimated values are ever fabricated.

### CLI Usage:
```bash
# Calculate metrics for a single UTC date:
npm run metrics -- --date 2026-09-22

# Calculate metrics across an inclusive date range:
npm run metrics -- --from 2026-09-11 --to 2026-09-22

# Filter calculation to a specific token:
npm run metrics -- --date 2026-09-22 --token 0x7d29d8047b905000459c0e80c34a26ceedcb47b2

# Show help:
npm run metrics -- --help
```

---

## 7. Phase 2B — Market Health Score V1 & Market Momentum

Phase 2B implements a deterministic assessment engine on top of `daily_metrics`. It converts validated onchain activity into:
1. **Market Health Score**: `0–100`
2. **Market Momentum**: `-100` to `+100`
3. **Status Classification**: `EARLY`, `BUILDING`, `DEVELOPING`, `MATURE`, `READY`

### 1. Health Score Methodology & Component Weights
The final health score is a weighted linear combination of five normalized components (`0–100`):

$$\text{health\_score} = (\text{holder\_health} \times 0.25) + (\text{transfer\_activity} \times 0.25) + (\text{address\_activity} \times 0.20) + (\text{concentration\_score} \times 0.20) + (\text{consistency\_score} \times 0.10)$$

| Component | Weight | Underlying Metric / Baseline | Purpose |
|---|---|---|---|
| **Holder Health** | **25%** | $\frac{\text{new\_holders}}{\text{previous\_holder\_count}}$ | Measures daily holder base growth rate |
| **Transfer Activity** | **25%** | $\frac{\text{today\_transfer\_count}}{\text{median\_7d\_transfer\_count}}$ | Measures token velocity vs 7-day rolling median |
| **Address Activity** | **20%** | $\frac{\text{today\_active\_holders}}{\text{median\_7d\_active\_holders}}$ | Measures active network participants vs 7-day median |
| **Holder Concentration** | **20%** | $100 \times (1 - \text{Risk})$ | Rewards decentralization of onchain balances |
| **Activity Consistency** | **10%** | $\frac{\text{active\_days}}{7} \times 100$ | Rewards sustained daily activity over 7 completed days |

### 2. Normalization Anchors & Linear Interpolation
All component scores are interpolated linearly between predefined anchor points and clamped to `[0, 100]`:

- **Holder Health Anchors** (Daily Growth %):
  - `0%` $\rightarrow$ `0`
  - `5%` $\rightarrow$ `25`
  - `10%` $\rightarrow$ `50`
  - `20%` $\rightarrow$ `75`
  - `30%+` $\rightarrow$ `100` (capped at 100; extreme growth never exceeds 100)
  - *If historical holder baseline is unavailable, reports `INSUFFICIENT_DATA` rather than fabricating a score.*

- **Transfer Activity & Address Activity Anchors** (Ratio vs 7-day rolling median):
  - `0.0x` $\rightarrow$ `0`
  - `0.5x` $\rightarrow$ `25`
  - `1.0x` $\rightarrow$ `50` (baseline activity matches historical median)
  - `2.0x` $\rightarrow$ `75`
  - `3.0x+` $\rightarrow$ `100` (capped at 100)
  - *Prevents hardcoded absolute transfer thresholds across tokens of different scales.*

- **Onchain Holder Concentration Score**:
  $$\text{Risk} = 0.50 \times \text{top1} + 0.30 \times \text{top5} + 0.20 \times \text{top10}$$
  $$\text{Score} = 100 \times (1 - \text{Risk})$$
  - Clamped strictly to `[0, 100]`.
  - Terminology: strictly referred to as **"onchain holder concentration"**, recognizing that one entity may control multiple addresses.

- **Activity Consistency Score**:
  $$\text{Score} = \left(\frac{\text{active\_days}}{7}\right) \times 100$$
  - Evaluates the previous 7 completed daily observations where $\text{transfer\_count} > 0$.
  - Example: `0/7` $\rightarrow$ `0.0`, `1/7` $\rightarrow$ `14.3`, ..., `7/7` $\rightarrow$ `100.0`.

### 3. Minimum Historical Window Requirement
- **Requirement**: Minimum **7 completed daily observations** strictly prior to the assessment date.
- If fewer than 7 historical observations exist:
  - `health_score = NULL`
  - `status = INSUFFICIENT_DATA`
  - `reason = INSUFFICIENT_HISTORICAL_WINDOW`
- Missing historical data is **never replaced with zero** or fabricated estimates.

### 4. Status Boundaries
Scores map deterministically into exactly 5 status labels:
- `0–39`: **`EARLY`**
- `40–59`: **`BUILDING`**
- `60–74`: **`DEVELOPING`**
- `75–89`: **`MATURE`**
- `90–100`: **`READY`**

### 5. Market Momentum Definition
- **What it is**: Market Momentum measures the rate of change in **onchain market activity** relative to the token's 7-day rolling baseline across three dimensions:
  1. `transfer_count` vs 7-day rolling median
  2. `active_holders` vs 7-day rolling median
  3. `new_holders` vs 7-day rolling median
- **Normalization**: Normalized strictly to `[-100, +100]`:
  - **Negative (`< 0`)**: Activity is weakening relative to baseline.
  - **Zero (`0.0`)**: Activity is stable near baseline.
  - **Positive (`> 0`)**: Activity is strengthening relative to baseline.
- **CRITICAL**: **Market Momentum is NOT price momentum.** It carries zero directional financial prediction.

### 6. Strict Data Integrity & Lookahead Prevention
- **No Lookahead Leakage**: Assessments strictly query observations dated `< assessmentDate` when constructing the 7-day rolling baseline and consistency window.
- **Historical Immutability**: Historical assessments always utilize historical `daily_metrics` snapshot states, never current wallet balances.
- **Pure Determinism**: Identical database state + identical assessment date will always yield identical results without wall-clock drift or randomness.

### 7. CLI Usage
```bash
# Run assessment for all tokens on a specific UTC date:
npm run assess -- --date 2026-09-22

# Filter assessment to a specific token:
npm run assess -- --date 2026-09-22 --token 0x548b11fbcf18216335a1215440cbfa48682a0d0a

# Default to latest indexed date:
npm run assess
```

#### Example Output (Sufficient History):
```text
ASSET ASSESSMENT
────────────────────────
Token: EBT (0x548b11fbcf18216335a1215440cbfa48682a0d0a)
Date: 2026-09-22

Market Health: 66.5 / 100
Status: DEVELOPING
Market Momentum: +42.0

Components:
Holder Health: 75.0
Transfer Activity: 80.0
Address Activity: 65.0
Concentration: 40.0
Consistency: 85.7

Data Window: 7 days
────────────────────────
```

#### Example Output (Insufficient History):
```text
ASSET ASSESSMENT
────────────────────────
Token: USDC (0x7d29d8047b905000459c0e80c34a26ceedcb47b2)
Date: 2026-09-22

Status: INSUFFICIENT_DATA
Reason: INSUFFICIENT_HISTORICAL_WINDOW
Data Window: 1 days (minimum 7 required)
────────────────────────
```

### 8. Explicit Disclaimers & Non-Goals
> [!WARNING]
> - **Independent Project**: This software is an independent submission and is **NOT** an official Ascend or Elysium product.
> - **Not an Approval or Ranking**: Health Scores and Statuses do **NOT** constitute an official Ascend ranking, endorsement, or approval.
> - **Zero Price/Success Prediction**: Market Health and Momentum do **NOT** predict token prices, token market caps, or project success.
> - **Not a Trading Strategy**: This engine does **NOT** generate buy/sell signals and must never be used as investment advice.
> - **No External Market Data**: The engine relies 100% on verifiable onchain event logs; it does not consume DEX liquidity, CEX volumes, or offchain pricing.
> - **No HyperCore Dependency**: Operates independently of HyperCore consensus internals.

---

## 8. Known RPC Rate-Limit Limitation & Resilience

The Elysium Testnet public RPC (`https://testnet-rpc.elysium.kinetiq.xyz`) is hosted on Conduit infrastructure with tight request concurrency boundaries.

### Known Limitations:
1. **Conduit Rate Limit (`-32017`)**: High concurrency or excessive block ranges return JSON-RPC error code `-32017` ("Rate limit exceeded").
2. **Log Query Range Caps**: Requesting large block ranges during high-activity periods can trigger gateway timeouts (`504 Gateway Timeout`) or HTTP 429.

### Built-in Mitigations:
- **Adaptive Batch Halving**: Automatically halves the range (down to `MIN_BLOCK_BATCH_SIZE=10`) upon error and retries immediately without dropping blocks.
- **Adaptive Batch Growth**: Gradually doubles back toward `BLOCK_BATCH_SIZE` after 5 consecutive successes.
- **Exponential Backoff with Jitter**: Transient network errors and rate limits back off exponentially (`RPC_RETRY_BASE_DELAY_MS=1500`, up to `RPC_MAX_RETRIES=5`).
- **Throttled Concurrency**: Controlled concurrent RPC calls (`RPC_CONCURRENCY=2`) prevent saturating the public endpoint.

---

## 9. Verification & Quality Assurance

### Automated Test Suite
The repository includes **92 automated unit and integration tests** across **7 test suites**:
- [tests/config.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/config.test.ts): Environment variable parsing, validation rules, chain ID assertions, and log password masking.
- [tests/holder-engine.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/holder-engine.test.ts): Mint/burn accounting, self-transfers, zero-balance transitions, and non-negative invariants.
- [tests/transfer-processor.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/transfer-processor.test.ts): 3-topic Transfer log decoding, data boundary validation, and deduplication.
- [tests/checkpoint.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/checkpoint.test.ts): Crash recovery, transaction atomicity, idempotent resume, and target range planning.
- [tests/rpc-resilience.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/rpc-resilience.test.ts): Exponential backoff with jitter, Conduit `-32017` handling, and adaptive batch halving/growth.
- [tests/daily-metrics.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/daily-metrics.test.ts): 15 deterministic tests covering all raw metrics, zero address exclusions, self-transfers, concentration ratios, empty dates, idempotency, and UTC boundaries.
- [tests/assessment.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/assessment.test.ts): 21 deterministic tests covering all 20 Phase 2B audit requirements (holder growth anchors, interpolation, activity anchors, concentration clamping, consistency 0/7 and 7/7, insufficient historical window, exact status boundaries 40/60/75/90, lookahead prevention, idempotency, negative/neutral/positive momentum, and component weighting).

```bash
cd indexer
npm run test
npm run typecheck
npm run build
npm run doctor
npm run metrics -- --date 2026-09-22
npm run assess -- --date 2026-09-22
```

### Verified Live Testnet & Assessment Results
- **Chain ID**: `99801` (Verified onchain)
- **Blocks Scanned**: Blocks `0` through `30,000`
- **ERC-20 Contracts Tracked**: `12` contracts (e.g. USDC, PURR, WHYPE, EBT)
- **Transfer Events Indexed**: `198` real onchain transfers stored
- **Daily Metrics Calculated**: 33 daily metric rows across 12 calendar days (idempotent upserts)
- **Assessments Generated**: Idempotently computed and stored in `market_assessments`
- **Balance Invariant**: `0` balance anomalies
- **Doctor Diagnostic**: 100% Passed

