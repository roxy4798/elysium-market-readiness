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

## 1. Project Overview & Current Scope

**Current Status: Phase 1 — ERC-20 Indexer & Onchain Data Layer.**  
*(Phase 2 scoring engine and risk metrics are planned for subsequent phases and are NOT present in this repository.)*

Phase 1 provides a production-grade, fault-tolerant indexing engine specifically configured and tuned for the **Elysium Testnet**:
- Connects directly to **Elysium Testnet** (`Chain ID: 99801`, gas token `HYPE`).
- Discovers, decodes, and indexes all onchain ERC-20 `Transfer(address,address,uint256)` event logs.
- Strictly validates candidate token contracts onchain (`decimals()`, `totalSupply()`, optional `name()`, `symbol()`).
- Rejects non-ERC20s, NFTs (ERC-721/1155), EOAs, and reverting contract interfaces.
- Atomically persists parsed transfers, token metadata, and holder balances into PostgreSQL.
- Implements idempotent re-indexing, strict non-negative balance accounting, and zero-balance transitions.
- Provides atomic block checkpointing for crash-recovery and seamless restartability.
- Features adaptive RPC batching and exponential backoff with jitter to handle Elysium RPC rate limits.

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
├── README.md                       # Architecture, setup, and Phase 1 documentation
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
    │   ├── main.ts                 # CLI entrypoint (run, migrate, doctor)
    │   ├── scanner.ts              # Adaptive log fetcher, pipeline orchestrator
    │   ├── token-validator.ts      # Multi-call ERC-20 validator & bytes32 decoder
    │   └── transfer-processor.ts   # 3-topic Transfer log decoder & deduplicator
    └── tests/
        ├── checkpoint.test.ts      # Checkpoint persistence and crash recovery tests
        ├── config.test.ts          # Config loading and credential redaction tests
        ├── holder-engine.test.ts   # Invariant and balance accounting tests
        ├── rpc-resilience.test.ts  # Adaptive batching, retry, rate limit tests
        ├── transfer-processor.test.ts # Transfer log decoding and validation tests
        └── helpers/
            ├── fakes.ts            # Mock viem chain & RPC fault injectors
            └── memory-store.ts     # In-memory transactional test store
```

---

## 4. Architecture & Pipeline

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
│ Scanner & Ingestion Pipeline                                                    │
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
                     └────────────────────────────────────────┘
```

### Module Responsibilities:
- [src/client.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/src/client.ts): Viem `PublicClient` setup with jittered exponential backoff (`withRetry`). Classifies transient errors (HTTP 429, 502-504, network timeouts, Conduit rate limit `-32017`) vs permanent contract execution reverts.
- [src/scanner.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/src/scanner.ts): Bounded range scanner coordinating log fetching, token validation, block timestamp caching, and atomic persistence. Never skips blocks.
- [src/token-validator.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/src/token-validator.ts): Distinguishes valid ERC-20 contracts from NFTs, reverts, or arbitrary contracts. Supports both standard UTF-8 string and legacy bytes32 metadata encoding.
- [src/transfer-processor.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/src/transfer-processor.ts): Strict log validation (topic0 `0xddf252ad...`, indexed `from`/`to`, unindexed 32-byte `value`).
- [src/holder-engine.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/src/holder-engine.ts): In-memory accounting: handles mints (`from == 0x0`), burns (`to == 0x0`), self-transfers, zero-balance pruning, and balance anomaly tracking.
- [src/database.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/src/database.ts): PostgreSQL transactional storage (`pg`). Uses `ON CONFLICT DO NOTHING` for transfers and upsert logic for tokens and balances.
- [src/checkpoint.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/src/checkpoint.ts): Durable checkpoint management guaranteeing restart recovery starting exactly from `last_processed_block + 1`.

---

## 5. Database Schema & Reproducibility

Defined in [database/schema.sql](file:///c:/ELYSIUM/elysium-market-readiness/database/schema.sql):
- **`tokens`**: `address` (PK, lowercase), `name`, `symbol`, `decimals`, `total_supply`, `first_seen_block`, `last_seen_block`, `balance_anomalies`.
- **`transfers`**: `id` (BIGSERIAL PK), `token_address`, `tx_hash`, `log_index`, `block_number`, `block_timestamp`, `from_address`, `to_address`, `amount`. Unique index on `(tx_hash, log_index)`.
- **`balances`**: `token_address`, `holder_address`, `balance` (`CHECK balance >= 0`), `last_updated_block`. Primary key on `(token_address, holder_address)`.
- **`indexer_state`**: Single-row checkpoint table storing `last_processed_block` and `updated_at`.

No database dumps or runtime database files are tracked in Git. The database is 100% reproducible from [database/schema.sql](file:///c:/ELYSIUM/elysium-market-readiness/database/schema.sql) and the migration command.

---

## 6. Local Setup & Usage

### Prerequisites
- Node.js >= 20.12
- PostgreSQL 14+

### Installation
```bash
cd indexer
npm install
```

### PostgreSQL Setup & Migration
Create a PostgreSQL database (e.g. `market_readiness`), then configure your `.env`:
```bash
cp .env.example .env
```
Edit `.env` with your database credentials:
```env
RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz
CHAIN_ID=99801
DATABASE_URL=postgresql://elysium:CHANGE_ME@localhost:5432/market_readiness

START_BLOCK=
BLOCK_BATCH_SIZE=2000
CONFIRMATION_BLOCKS=5

RPC_CONCURRENCY=2
RPC_RETRY_BASE_DELAY_MS=1500

LOG_LEVEL=info
```

Run migrations idempotently:
```bash
npm run migrate
```

### Health Check (Doctor)
Run the diagnostic doctor to verify Elysium RPC connectivity, chain ID verification, database connectivity, and checkpoint state:
```bash
npm run doctor
```

### Building & Running the Indexer
Run in development mode (live indexing with tsx):
```bash
npm run dev
```

Build for production:
```bash
npm run build
npm start
```

### Checkpoint & Resume Behavior
The indexer maintains atomic state in the `indexer_state` table.
- When started with an empty database and no `START_BLOCK`, indexing begins at block `0`.
- If interrupted (e.g. SIGINT, crash, or deployment restart), restarting with `npm run dev` or `npm start` automatically queries `indexer_state` and resumes from `last_processed_block + 1`.
- Transfers and balances within each batch are committed in a single PostgreSQL transaction together with the updated checkpoint. If any step fails, the transaction is rolled back and no blocks are marked processed.

---

## 7. Known RPC Rate-Limit Limitation & Resilience

The Elysium Testnet public RPC (`https://testnet-rpc.elysium.kinetiq.xyz`) is hosted on Conduit infrastructure with tight request concurrency and payload boundaries.

### Known Limitations:
1. **Conduit Rate Limit (`-32017`)**: High concurrency or excessive block ranges return JSON-RPC error code `-32017` ("Rate limit exceeded").
2. **Log Query Range Caps**: Requesting large block ranges during high-activity periods can trigger gateway timeouts (`504 Gateway Timeout`) or HTTP 429.

### Built-in Mitigations:
- **Adaptive Batch Halving**: When an `eth_getLogs` query fails with a rate limit or timeout, the range is automatically halved (down to `MIN_BLOCK_BATCH_SIZE=10`) and retried immediately.
- **Adaptive Batch Growth**: Once 5 consecutive queries succeed without issues, the batch size gradually doubles back toward `BLOCK_BATCH_SIZE`.
- **Exponential Backoff with Jitter**: Transient network errors and rate limits back off exponentially (`RPC_RETRY_BASE_DELAY_MS=1500`, up to `RPC_MAX_RETRIES=5`).
- **Throttled Concurrency**: Controlled concurrent RPC calls (`RPC_CONCURRENCY=2`) prevent saturating the public endpoint.

---

## 8. Verification & Quality Assurance

### Automated Test Suite
The repository includes 54 automated unit and integration tests across 5 test suites:
- [tests/config.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/config.test.ts): Environment variable parsing, validation rules, chain ID assertions, and log password masking.
- [tests/holder-engine.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/holder-engine.test.ts): Mint/burn accounting, self-transfers, zero-balance transitions, and non-negative invariants.
- [tests/transfer-processor.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/transfer-processor.test.ts): 3-topic Transfer log decoding, data boundary validation, and deduplication.
- [tests/checkpoint.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/checkpoint.test.ts): Crash recovery, transaction atomicity, idempotent resume, and target range planning.
- [tests/rpc-resilience.test.ts](file:///c:/ELYSIUM/elysium-market-readiness/indexer/tests/rpc-resilience.test.ts): Exponential backoff with jitter, Conduit `-32017` handling, and adaptive batch halving/growth.

```bash
npm run test
npm run typecheck
npm run build
npm run doctor
```

### Verified Onchain Results (Phase 1 Baseline)
- **Chain ID**: `99801` (Verified onchain)
- **Blocks Scanned**: Blocks `0` through `30,000`
- **ERC-20 Contracts Validated**: `12` contracts (e.g. WHYPE, Elysium Bridge Test / EBT)
- **Transfer Events Indexed**: `198` real onchain transfers stored
- **Holder Balances Maintained**: `81` distinct active holders
- **Balance Invariant**: `0` balance anomalies
- **Checkpoint**: Successfully reached and persisted at block `30,000`
