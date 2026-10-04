-- Elysium Market Readiness — Schema (Phase 1 indexer + Phase 2A daily metrics)
-- Independent developer project. Not an official Ascend / Elysium product.
-- Idempotent: safe to apply multiple times.

CREATE TABLE IF NOT EXISTS tokens (
    address           VARCHAR(42) PRIMARY KEY,
    name              TEXT,
    symbol            TEXT,
    decimals          INTEGER,
    total_supply      NUMERIC,
    first_seen_block  BIGINT NOT NULL,
    last_seen_block   BIGINT NOT NULL,
    -- Number of transfers whose balance mutation was rejected because it would
    -- have made a holder balance negative (usually: indexing started after the
    -- token was deployed, or the token is non-standard e.g. rebasing).
    balance_anomalies INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMP DEFAULT NOW(),
    updated_at        TIMESTAMP DEFAULT NOW(),
    CONSTRAINT tokens_address_lowercase CHECK (address = LOWER(address))
);

CREATE TABLE IF NOT EXISTS transfers (
    id               BIGSERIAL PRIMARY KEY,
    token_address    VARCHAR(42) NOT NULL REFERENCES tokens(address),
    tx_hash          VARCHAR(66) NOT NULL,
    log_index        INTEGER NOT NULL,
    block_number     BIGINT NOT NULL,
    block_timestamp  TIMESTAMP NOT NULL,
    from_address     VARCHAR(42) NOT NULL,
    to_address       VARCHAR(42) NOT NULL,
    amount           NUMERIC NOT NULL CHECK (amount >= 0),
    created_at       TIMESTAMP DEFAULT NOW(),
    -- Mandatory for idempotency: one row per onchain log.
    CONSTRAINT transfers_tx_hash_log_index_key UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS transfers_token_block_idx ON transfers (token_address, block_number);
CREATE INDEX IF NOT EXISTS transfers_block_idx ON transfers (block_number);

CREATE TABLE IF NOT EXISTS balances (
    token_address       VARCHAR(42) NOT NULL REFERENCES tokens(address),
    holder_address      VARCHAR(42) NOT NULL,
    balance             NUMERIC NOT NULL DEFAULT 0 CHECK (balance >= 0),
    last_updated_block  BIGINT NOT NULL,
    PRIMARY KEY (token_address, holder_address),
    CONSTRAINT balances_no_zero_address CHECK (holder_address <> '0x0000000000000000000000000000000000000000')
);

CREATE TABLE IF NOT EXISTS indexer_state (
    id                    INTEGER PRIMARY KEY,
    last_processed_block  BIGINT NOT NULL,
    updated_at            TIMESTAMP DEFAULT NOW()
);

-- Historical token-scoped replay has its own contiguous cursor. It never rewinds
-- or advances the normal chain-wide indexer checkpoint.
CREATE TABLE IF NOT EXISTS historical_backfill_state (
    token_address              VARCHAR(42) PRIMARY KEY REFERENCES tokens(address),
    start_block                BIGINT NOT NULL CHECK (start_block >= 0),
    target_block               BIGINT NOT NULL CHECK (target_block >= start_block),
    next_block                 BIGINT NOT NULL CHECK (next_block >= start_block),
    reconciled_through_block   BIGINT,
    updated_at                 TIMESTAMP DEFAULT NOW()
);

-- Phase 2A: Deterministic daily market metrics
CREATE TABLE IF NOT EXISTS daily_metrics (
    token_address       VARCHAR(42) NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
    date                DATE NOT NULL,
    holder_count        INTEGER NOT NULL DEFAULT 0,
    new_holders         INTEGER NOT NULL DEFAULT 0,
    active_holders      INTEGER NOT NULL DEFAULT 0,
    transfer_count      INTEGER NOT NULL DEFAULT 0,
    unique_senders      INTEGER NOT NULL DEFAULT 0,
    unique_receivers    INTEGER NOT NULL DEFAULT 0,
    top1_concentration  NUMERIC,
    top5_concentration  NUMERIC,
    top10_concentration NUMERIC,
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (token_address, date)
);

CREATE INDEX IF NOT EXISTS daily_metrics_date_idx ON daily_metrics (date);
CREATE INDEX IF NOT EXISTS daily_metrics_token_idx ON daily_metrics (token_address);

-- Phase 2B / 3A: Market Health Score V1 & Canonical Verification Assessments
CREATE TABLE IF NOT EXISTS market_assessments (
    token_address       VARCHAR(42) NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,
    assessment_date     DATE NOT NULL,
    health_score        NUMERIC(5, 2),
    status              VARCHAR(20) NOT NULL,
    momentum            NUMERIC(5, 2),
    holder_health       NUMERIC(5, 2),
    transfer_activity   NUMERIC(5, 2),
    address_activity    NUMERIC(5, 2),
    concentration_score NUMERIC(5, 2),
    consistency_score   NUMERIC(5, 2),
    data_window_days    INTEGER NOT NULL DEFAULT 0,
    reason              TEXT,
    assessment_id       VARCHAR(66),
    schema_version      VARCHAR(10),
    methodology_version VARCHAR(20),
    assessment_hash     VARCHAR(64),
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (token_address, assessment_date)
);

-- Idempotent schema migrations for Phase 3A
ALTER TABLE market_assessments ADD COLUMN IF NOT EXISTS assessment_id VARCHAR(66);
ALTER TABLE market_assessments ADD COLUMN IF NOT EXISTS schema_version VARCHAR(10);
ALTER TABLE market_assessments ADD COLUMN IF NOT EXISTS methodology_version VARCHAR(20);
ALTER TABLE market_assessments ADD COLUMN IF NOT EXISTS assessment_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS market_assessments_date_idx ON market_assessments (assessment_date);
CREATE INDEX IF NOT EXISTS market_assessments_token_idx ON market_assessments (token_address);
CREATE INDEX IF NOT EXISTS market_assessments_id_idx ON market_assessments (assessment_id);

-- Phase 3B: Onchain Assessment Attestations
CREATE TABLE IF NOT EXISTS assessment_attestations (
    id                BIGSERIAL PRIMARY KEY,
    assessment_id     VARCHAR(66) NOT NULL UNIQUE,
    contract_address  VARCHAR(42) NOT NULL,
    chain_id          BIGINT NOT NULL,
    transaction_hash  VARCHAR(66) NOT NULL UNIQUE,
    block_number      BIGINT NOT NULL,
    attester_address  VARCHAR(42) NOT NULL,
    attested_at       TIMESTAMP NOT NULL,
    created_at        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS assessment_attestations_assessment_id_idx ON assessment_attestations (assessment_id);
CREATE INDEX IF NOT EXISTS assessment_attestations_tx_idx ON assessment_attestations (transaction_hash);
CREATE INDEX IF NOT EXISTS assessment_attestations_contract_idx ON assessment_attestations (contract_address);

