# Elysium Market Readiness

**Independent, transparent, onchain market-health and market-progression assessment layer for assets building on Elysium.**

> [!IMPORTANT]
> **CRITICAL DISCLAIMERS:**
> - This is an **INDEPENDENT** project built for the Ascend Elysium Builder Competition.
> - This is **NOT** an official Ascend or Elysium product.
> - This does **NOT** predict token prices, investment returns, or financial outcomes.
> - This does **NOT** provide a token safety or liquidity guarantee.
> - This does **NOT** rank, endorse, certify, or approve token launches.
> - Preserved disclaimer: *"Independent assessment layer. Not an official Ascend or Elysium ranking, approval, or investment recommendation."*

---

## 1. What It Is

Elysium Market Readiness is an open-source, deterministic evaluation and verification system for tokens on the **Elysium Testnet (Chain ID: 99801)**. It indexes raw onchain ERC-20 transfers, reconstructs verifiable daily holder balances and transfer metrics, computes reproducible **Market Health** (0–100) and **Activity Momentum** (-100 to +100) scores with zero lookahead bias, and anchors the resulting cryptographic assessment hash to an immutable onchain smart contract registry.

---

## 2. Problem

In emerging L1/L2 ecosystems, market participants and builders struggle with:
1. **Opaque and Inconsistent Metrics**: Offchain analytics vendors use black-box heuristics, synthetic estimations, or wall-clock inconsistent aggregations.
2. **Hype-Driven Noise**: Speculative social sentiment is often conflated with authentic network utility and decentralized holder distribution.
3. **Unverifiable Claims**: Offchain analytics can be quietly mutated retroactively; there is no immutable audit trail proving what an asset's observed health was on any given calendar date.
4. **Lookahead & Data Snooping**: Many scoring models leak future data into historical evaluations, invalidating historical backtests and readiness milestones.

---

## 3. How It Works

1. **Onchain Log Ingestion**: Scans Elysium Testnet blocks for standard 3-topic ERC-20 `Transfer(address,address,uint256)` events.
2. **Strict Contract Validation**: Validates candidate tokens via multicall (`decimals()`, `totalSupply()`, `name()`, `symbol()`), safely rejecting non-ERC20 contracts and NFTs.
3. **Daily Metrics Reconstruction**: Groups valid transfers by strict UTC calendar boundaries (`00:00:00` to `23:59:59.999 UTC`) to produce daily metrics (holders, new holders, active participants, transfer counts, and BigInt-based onchain concentration).
4. **Deterministic Health & Momentum Engine**: Evaluates a 7-day rolling baseline strictly preceding the assessment date to calculate normalized component scores and activity momentum.
5. **Canonical Serialization & Cryptographic Hashing**: Serializes a 13-field fixed JSON payload, computing a Keccak-256 Assessment ID and SHA-256 integrity hash.
6. **Onchain Attestation**: Submits the canonical assessment hash to the `ElysiumAssessmentAttestation` smart contract on Elysium Testnet.
7. **Public Verification**: A REST API and modern web dashboard allow anyone to independently verify the assessment hash against both PostgreSQL and onchain contract storage.

---

## 4. Health Score

The Market Health Score is a deterministic index scaled from **0 to 100**, computed as a weighted sum of five normalized components:

$$\text{Health Score} = (\text{Holder Health} \times 0.25) + (\text{Transfer Activity} \times 0.25) + (\text{Address Activity} \times 0.20) + (\text{Concentration Score} \times 0.20) + (\text{Consistency Score} \times 0.10)$$

| Component | Weight | Definition & Baseline | What It Measures |
|---|---|---|---|
| **Holder Health** | **25%** | $\frac{\text{new\_holders}}{\text{previous\_holder\_count}}$ | Daily holder base growth rate |
| **Transfer Activity** | **25%** | $\frac{\text{today\_transfers}}{\text{7d\_median\_transfers}}$ | Token velocity vs 7-day rolling median |
| **Address Activity** | **20%** | $\frac{\text{today\_active\_holders}}{\text{7d\_median\_active\_holders}}$ | Active transacting addresses vs 7-day median |
| **Onchain Concentration** | **20%** | $100 \times (1 - [0.50 \cdot \text{top1} + 0.30 \cdot \text{top5} + 0.20 \cdot \text{top10}])$ | Balance distribution across tracked holders |
| **Activity Consistency** | **10%** | $\frac{\text{days\_with\_transfers}}{7} \times 100$ | Consistency of transfer activity over prior 7 days |

### Status Boundaries:
- `0–39`: **`EARLY`**
- `40–59`: **`BUILDING`**
- `60–74`: **`DEVELOPING`**
- `75–89`: **`MATURE`**
- `90–100`: **`READY`**

> [!NOTE]
> **Explicit Boundaries**: Health Score is **NOT** a safety score and **NOT** a liquidity score. Concentration is based strictly on observable onchain wallet balances, not verified human identity.

---

## 5. Momentum

**Activity Momentum** measures the velocity change in observable onchain activity relative to the token's prior 7-day rolling baseline:
- Scaled from **`-100.00` to `+100.00`**.
- Evaluates three dimensions: `transfer_count`, `active_holders`, and `new_holders` vs their 7-day rolling medians.
- Negative values (`< 0`) reflect cooling activity; positive values (`> 0`) reflect accelerating activity.

> [!WARNING]
> **Momentum is NOT price momentum.** It is **NOT a trading signal**, does not consider market price or volume, and carries zero directional financial prediction.

---

## 6. Verification

The verification layer allows reviewers and auditors to verify assessments without trusting the database:
- **Assessment ID**: $\text{keccak256}(\text{schema\_version} : \text{methodology\_version} : \text{token\_address} : \text{assessment\_date})$.
- **Assessment Hash**: $\text{SHA-256}(\text{canonical\_json\_payload})$.
- **Independent Recalculation**: The verification endpoint (`GET /v1/assessments/:assessmentId/verify`) loads persisted metric inputs, deterministically reconstructs the canonical payload, recalculates the SHA-256 hash, and compares it against stored records.
- If any metric, weight, or score is altered by even one bit, the hash immediately diverges (`valid: false`).

---

## 7. Onchain Attestation

To establish immutable public provenance, the assessment hash is committed to the Elysium Testnet:
- **Contract Name**: `ElysiumAssessmentAttestation`
- **Contract Address**: [`0x149832ec7f9eb3729ec1682b86e026c0af5a9d61`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x149832ec7f9eb3729ec1682b86e026c0af5a9d61)
- **Design**: Non-upgradeable, no proxies, no admin keys, passive onchain registry with zero offchain computation or scoring logic inside EVM bytecode.
- **Idempotency**: Re-attesting identical data is completely idempotent; conflicting duplicate data reverts with `AssessmentAlreadyAttestedWithDifferentData`.
- **Public Verification**: Anyone can read `isAttested(assessmentId)` and `getAttestation(assessmentId)` directly from the Elysium Testnet RPC.

---

## 8. Architecture

```text
Elysium Testnet
       ↓
Transfer Indexer
       ↓
PostgreSQL
       ↓
Daily Metrics
       ↓
Health + Momentum Engine
       ↓
Canonical Assessment
       ↓
SHA-256 Integrity Hash
       ↓
Elysium Attestation Contract
       ↓
Verification API
       ↓
Dashboard
```

### Production API Reference
Base URL: `https://elysium-market-readiness-api.elysium-market-readiness-indexer.workers.dev`

| Method | Endpoint | Description | Access |
|---|---|---|---|
| `GET` | `/health` / `/v1/health` | Service health status | Public |
| `GET` | `/v1/tokens` | Discovered tokens & latest assessment summary | Public |
| `GET` | `/v1/tokens/:address/overview` | Token details, latest assessment, 7-day metrics, & attestation | Public |
| `GET` | `/v1/tokens/:address/metrics` | Historical daily metrics series | Public |
| `GET` | `/v1/tokens/:address/momentum` | Historical activity momentum series | Public |
| `GET` | `/v1/assessments/:assessmentId/verify` | Cryptographic canonical & onchain verification proof | Public |
| `POST` | `/v1/assessments/:assessmentId/attest` | Onchain attestation submission | Restricted (CLI only; 403 on public Worker) |

---

## 9. Elysium Testnet Deployment

The system is deployed and verified on **Elysium Testnet**:

| Parameter | Verified Value |
|---|---|
| **Network** | Elysium Testnet |
| **Chain ID** | `99801` |
| **RPC Endpoint** | `https://testnet-rpc.elysium.kinetiq.xyz` |
| **Native Gas Token** | `HYPE` |
| **Official Explorer** | `https://elysium.kinetiq.xyz/testnet-explorer` |
| **Official Faucet** | `https://elysium.kinetiq.xyz/testnet-faucet` |
| **Production API** | `https://elysium-market-readiness-api.elysium-market-readiness-indexer.workers.dev` |
| **Production Dashboard** | `https://elysium-market-readiness-dashboard.pages.dev` |
| **Attestation Contract** | [`0x149832ec7f9eb3729ec1682b86e026c0af5a9d61`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x149832ec7f9eb3729ec1682b86e026c0af5a9d61) |
| **Contract Deployment Tx**| `0xe498ed954d1f8b9d8f9024fbe2c8dd3517d5d376a0a71a176bb60aa955574e12` (Block `2491307`) |
| **Verified Attester** | `0xfa438c93705aa9AD78f9EDdca0db140F198fE3C9` |

### Verified Live Assessment Record (ELYS):
- **Token**: `0x245bfe8c6c2429f6a7743d53377ae39b98500459` (ELYS)
- **Assessment Date**: `2026-10-03`
- **Health Score**: `34.00`
- **Activity Momentum**: `+4.50`
- **Status**: `EARLY`
- **Methodology**: `health-v1`
- **Assessment ID**: `0x2ffe882456f2f43d66ce8c4049d55bcacf80a1393afc2cd467a746cec4d18ef3`
- **Assessment Hash**: `180f144a819cdcd22d9244feef524dc7f75a80f73505410b9e2efba78d05193c`
- **Attestation Tx**: `0x35ae5707f0fa98b758afa5a486be6ef5a9f71f43efe73437169a7872f2debd79`
- **Attestation Block**: `2492705`
- **Attestation Timestamp**: `2026-10-04T04:59:38.000Z` (`1791089978`)
- **Onchain Check**: `isAttested` $\to$ `true`, `onchain_data_matches` $\to$ `true`.

---

## 10. Limitations

1. **Historical Window**: Requires at least 7 completed daily observation periods before computing a numerical assessment; tokens with insufficient history report `INSUFFICIENT_DATA` rather than fabricated zeroes.
2. **Onchain Observation Scope**: Relies purely on indexed ERC-20 `Transfer` events; does not incorporate CEX volume, offchain order books, social media metrics, or private transactions.
3. **Holder Entity Resolution**: Concentration reflects raw wallet addresses; multiple addresses controlled by a single entity, treasury, or liquidity pool contract are not separated.
4. **Public RPC Rate Limits**: Public testnet RPC nodes enforce tight rate limits; handled cleanly via built-in exponential backoff and adaptive batch halving.

---

## 11. Non-Goals

- **Price Prediction**: This engine does **not** predict token prices, future returns, or market valuation.
- **Safety / Audit Guarantees**: A high Health Score does **not** guarantee smart contract security, absence of exploits, or regulatory compliance.
- **Official Approval / Ranking**: This system does **not** rank or endorse token launches on behalf of Ascend or Elysium.
- **DEX Trading Automation**: Zero integration with automated trade execution or liquidity provision.

---

## 12. Running Locally

### Prerequisites:
- Node.js `>= 20.12`
- PostgreSQL 16+ running locally (``DATABASE_URL=<your-local-postgres-connection-string>``)

### Setup:
```bash
# 1. Clone repository
git clone https://github.com/roxy4798/elysium-market-readiness.git
cd elysium-market-readiness

# 2. Setup Indexer & API
cd indexer
npm install
npm run migrate
npm run doctor

# 3. Run Test Suites
npm test                  # 181 indexer & canonical verification tests
npm run typecheck         # TypeScript check
npm run build             # Production compilation

# 4. Start API Server (Port 3000)
npm run serve

# 5. Start Dashboard (In a separate terminal)
cd ../dashboard
npm install
npm test                  # 13 dashboard verification tests
npm run build
npm run dev               # Serves UI at http://localhost:5173
```

---

## 13. Competition Demo Flow (2–3 Minutes)

> [!TIP]
> **Live Production Dashboard**: [https://elysium-market-readiness-dashboard.pages.dev](https://elysium-market-readiness-dashboard.pages.dev)
>
> **Production API**: [https://elysium-market-readiness-api.elysium-market-readiness-indexer.workers.dev](https://elysium-market-readiness-api.elysium-market-readiness-indexer.workers.dev)

Follow this step-by-step path to demonstrate the entire trust chain during a review or presentation (using the live production dashboard or local development server):

- **STEP 1 — Open Dashboard**:
  Navigate to the live production dashboard:
  **Live Demo**: [https://elysium-market-readiness-dashboard.pages.dev](https://elysium-market-readiness-dashboard.pages.dev)
  *(Or `http://localhost:5173` if running locally)*. Notice the clean dark/light UI, clear disclaimers, the **Get Testnet HYPE** CTA, and the **Verified Demo Asset** banner for **ELYS**.

- **STEP 2 — Select ELYS**:
  Click on **ELYS** (`0x245bfe8c6c2429f6a7743d53377ae39b98500459`) to open its Token Overview.

- **STEP 3 — Review Core Assessment**:
  Inspect the top hero metrics:
  - **Health Score**: `34.00 / 100`
  - **Activity Momentum**: `+4.50`
  - **Status**: `EARLY`
  - **Methodology**: `health-v1`

- **STEP 4 — Inspect Historical Activity Metrics**:
  Scroll to the **Onchain Activity** section. Show the 7-day transfer activity chart and metrics (holder count, unique senders/receivers, active holders, and onchain concentration).

- **STEP 5 — Open Methodology**:
  Click **Methodology** in the top navigation or page header. Show the five weighted components (Holder Health 25%, Transfer Activity 25%, Address Activity 20%, Concentration 20%, Consistency 10%) and the explicit disclaimers: *Momentum is NOT price momentum; Health Score is NOT a safety score.*

- **STEP 6 — Open Verification Proof**:
  Return to ELYS and click **View latest assessment proof →** (or open date `2026-10-03`).

- **STEP 7 — Review Cryptographic Verification**:
  In the **Trust Stack**:
  - **1 · ASSESSMENT**: Shows persisted score `34.00`, momentum `+4.50`, and status `EARLY`.
  - **2 · CANONICAL VERIFICATION**: Displays **`VALID`** badge. The canonical payload hash `180f144a...` is verified deterministically against the assessment ID `0x2ffe88...`.

- **STEP 8 — Inspect Onchain Attestation Proof**:
  - **3 · ONCHAIN ATTESTATION**: Shows **`ATTESTED`** badge.
  - Review the verified proof hierarchy:
    - **Network**: Elysium Testnet
    - **Chain ID**: `99801`
    - **Contract**: [`0x149832ec7f9eb3729ec1682b86e026c0af5a9d61`](https://elysium.kinetiq.xyz/testnet-explorer/address/0x149832ec7f9eb3729ec1682b86e026c0af5a9d61) (with copy button)
    - **Transaction**: `0x35ae5707f0fa98b758afa5a486be6ef5a9f71f43efe73437169a7872f2debd79` (with copy button)
    - **Block**: `2492705`
    - **Attester**: `0xfa438c93705aa9AD78f9EDdca0db140F198fE3C9` (with copy button)
    - Click **Official Elysium Testnet Explorer ↗** to view the live explorer link.

- **STEP 9 — Summary Statement**:
  *"The score is generated deterministically from indexed Elysium activity. The resulting assessment is hashed and the hash is attested onchain, allowing the published assessment to be independently verified."*
