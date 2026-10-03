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
- *(Phase 2B/3 scoring engine, Health Score, Momentum Score, and rankings belong to subsequent phases and are NOT present in this repository.)*

### Core Capabilities:
- **Testnet RPC Connectivity**: Connects directly to **Elysium Testnet** (`Chain ID: 99801`, gas token `HYPE`).
- **ERC-20 Event Indexer**: Discovers, decodes, and indexes onchain `Transfer(address,address,uint256)` event logs.
- **Strict Onchain Validation**: Multi-call contract checks (`decimals()`, `totalSupply()`, `name()`, `symbol()`), filtering non-ERC20s, NFTs, and reverts.
- **Deterministic Raw Metrics Engine**: Converts indexed transfers and balances into daily raw market metrics with zero estimates and zero synthetic data.
- **Idempotent PostgreSQL Storage**: Atomic transactional persistence with conflict handling on `transfers` and `daily_metrics`.
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
├── README.md                       # Architecture, setup, and Phase 1 / 2A documentation
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
    │   ├── main.ts                 # CLI entrypoint (run, migrate, doctor, metrics)
    │   ├── scanner.ts              # Adaptive log fetcher, pipeline orchestrator
    │   ├── token-validator.ts      # Multi-call ERC-20 validator & bytes32 decoder
    │   ├── transfer-processor.ts   # 3-topic Transfer log decoder & deduplicator
    │   └── metrics/
    │       ├── types.ts            # Metrics data structures & Transfer interfaces
    │       ├── activity-metrics.ts # Transfer count, senders, receivers, active holders
    │       ├── holder-metrics.ts   # End-of-day holder count & new holder detection
    │       ├── concentration-metrics.ts # Onchain holder concentration (Top 1, 5, 10)
    │       └── daily-metrics.ts    # Coordinator, date boundaries, and DB upserts
    └── tests/
        ├── checkpoint.test.ts      # Checkpoint persistence and crash recovery tests
        ├── config.test.ts          # Config loading and credential redaction tests
        ├── daily-metrics.test.ts   # 15 deterministic raw metrics & edge case tests
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
                     └───────────────────┬────────────────────┘
                                         │
┌────────────────────────────────────────┴────────────────────────────────────────┐
│ Phase 2A: Deterministic Raw Metrics Engine                                      │
│                                                                                 │
│  1. Activity Aggregator   ──► transfer_count, unique senders, receivers, active │
│  2. Holder Balance Engine ──► end-of-day holder_count (> 0) & new_holders (0->+)│
│  3. Concentration Engine  ──► top1, top5, top10 onchain holder concentration   │
│  4. Idempotent Upserter   ──► ON CONFLICT (token_address, date) DO UPDATE       │
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

### Example CLI Output:
```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ELYSIUM DAILY METRICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Date:
2026-09-22

Token:
USDC

Holders:
49

New Holders:
49

Active Holders:
50

Transfers:
78

Unique Senders:
9

Unique Receivers:
50

Top 1:
0.36

Top 5:
0.92

Top 10:
0.94

Status:
CALCULATED

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 7. Known RPC Rate-Limit Limitation & Resilience

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

## 8. Verification & Quality Assurance

### Automated Test Suite
The repository includes 71 automated unit and integration tests across 6 test suites:
- [tests/config.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/config.test.ts): Environment variable parsing, validation rules, chain ID assertions, and log password masking.
- [tests/holder-engine.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/holder-engine.test.ts): Mint/burn accounting, self-transfers, zero-balance transitions, and non-negative invariants.
- [tests/transfer-processor.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/transfer-processor.test.ts): 3-topic Transfer log decoding, data boundary validation, and deduplication.
- [tests/checkpoint.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/checkpoint.test.ts): Crash recovery, transaction atomicity, idempotent resume, and target range planning.
- [tests/rpc-resilience.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/rpc-resilience.test.ts): Exponential backoff with jitter, Conduit `-32017` handling, and adaptive batch halving/growth.
- [tests/daily-metrics.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/daily-metrics.test.ts): 15 deterministic tests covering all raw metrics, zero address exclusions, self-transfers, concentration ratios, empty dates, idempotency, and UTC boundaries.

```bash
cd indexer
npm run test
npm run typecheck
npm run build
npm run doctor
npm run metrics -- --date 2026-09-22
```

### Verified Live Testnet & Metrics Results
- **Chain ID**: `99801` (Verified onchain)
- **Blocks Scanned**: Blocks `0` through `30,000`
- **ERC-20 Contracts Tracked**: `12` contracts (e.g. USDC, PURR, WHYPE, EBT)
- **Transfer Events Indexed**: `198` real onchain transfers stored
- **Daily Metrics Calculated**: 33 daily metric rows across 12 calendar days (idempotent upserts)
- **Balance Invariant**: `0` balance anomalies
- **Doctor Diagnostic**: 100% Passed
