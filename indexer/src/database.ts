/**
 * PostgreSQL persistence.
 *
 * `Store` / `TxRepo` are small interfaces so the commit orchestration in
 * transfer-processor.ts is identical in production (PgStore) and in tests.
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { readCheckpoint, writeCheckpoint } from './checkpoint.js';
import { applyTransfers, balanceKey, type BalanceTransfer, type BalanceUpdate } from './holder-engine.js';
import { logger } from './logger.js';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface TokenUpsert {
  readonly address: string;
  /** null = unknown / keep existing value */
  readonly name: string | null;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly totalSupply: bigint | null;
  readonly firstSeenBlock: bigint;
  readonly lastSeenBlock: bigint;
}

export interface StoredTransfer {
  readonly tokenAddress: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockTimestamp: Date;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

export interface HistoricalBackfillState {
  readonly tokenAddress: string;
  readonly startBlock: bigint;
  readonly targetBlock: bigint;
  /** First block not yet committed by this token-scoped replay. */
  readonly nextBlock: bigint;
  readonly reconciledThroughBlock: bigint | null;
}

export interface HistoricalRangeCommit {
  readonly insertedTransfers: number;
  readonly duplicateTransfers: number;
}

export interface BalanceRebuildResult {
  readonly transferCount: number;
  readonly balanceRows: number;
  readonly anomalyCount: number;
  readonly reconciledThroughBlock: bigint;
}

export interface TxRepo {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
  /** Returns addresses that were newly inserted. */
  upsertTokens(tokens: readonly TokenUpsert[]): Promise<Set<string>>;
  /** Inserts with ON CONFLICT DO NOTHING; returns only rows that were actually inserted. */
  insertTransfers(transfers: readonly StoredTransfer[]): Promise<StoredTransfer[]>;
  /** Locks and returns current balances for the given pairs (missing pairs omitted). */
  loadBalances(keys: ReadonlyArray<{ token: string; holder: string }>): Promise<Map<string, bigint>>;
  saveBalances(updates: readonly BalanceUpdate[]): Promise<void>;
  addBalanceAnomalies(countsByToken: ReadonlyMap<string, number>): Promise<void>;
  writeCheckpoint(expectedPrev: bigint | null, next: bigint): Promise<void>;
}

export interface Store {
  getCheckpoint(): Promise<bigint | null>;
  getKnownTokens(addresses: readonly string[]): Promise<Set<string>>;
  transaction<T>(fn: (repo: TxRepo) => Promise<T>): Promise<T>;
  /** Dedicated token history cursor; intentionally separate from indexer_state. */
  prepareHistoricalBackfill(tokenAddress: string, startBlock: bigint, targetBlock: bigint): Promise<HistoricalBackfillState>;
  commitHistoricalBackfillRange(input: {
    token: TokenUpsert;
    expectedNextBlock: bigint;
    fromBlock: bigint;
    toBlock: bigint;
    transfers: readonly StoredTransfer[];
  }): Promise<HistoricalRangeCommit>;
  /** Atomically replace one token's balances from its complete persisted transfer ledger. */
  rebuildTokenBalances(tokenAddress: string): Promise<BalanceRebuildResult>;
  /** Mutual exclusion for normal forward indexing and historical backfill. */
  acquireIndexerLock(): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export const REQUIRED_TABLES = [
  'tokens',
  'transfers',
  'balances',
  'indexer_state',
  'historical_backfill_state',
  'daily_metrics',
  'market_assessments',
  'assessment_attestations',
] as const;

const CHUNK = 2000;

function chunks<T>(arr: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function expectedPgTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, -1).replace('T', ' ')}000`;
}

/** Existing unique keys are accepted only when every persisted event field agrees with the RPC replay. */
async function verifyStoredTransfers(q: Queryable, transfers: readonly StoredTransfer[]): Promise<void> {
  for (const part of chunks(transfers, 1000)) {
    const result = await q.query<{
      tx_hash: string; log_index: number; token_address: string; block_number: string;
      block_timestamp: string; from_address: string; to_address: string; amount: string;
    }>(
      `SELECT t.tx_hash, t.log_index, t.token_address, t.block_number::text,
              to_char(t.block_timestamp, 'YYYY-MM-DD HH24:MI:SS.US') AS block_timestamp,
              t.from_address, t.to_address, t.amount::text
       FROM transfers t
       JOIN unnest($1::varchar[], $2::int[]) AS expected(tx_hash, log_index)
         ON t.tx_hash = expected.tx_hash AND t.log_index = expected.log_index`,
      [part.map((t) => t.txHash), part.map((t) => t.logIndex)],
    );
    const byKey = new Map(result.rows.map((r) => [`${r.tx_hash}:${r.log_index}`, r]));
    for (const expected of part) {
      const actual = byKey.get(`${expected.txHash}:${expected.logIndex}`);
      if (!actual) throw new Error(`historical transfer ${expected.txHash}:${expected.logIndex} was not persisted`);
      const matches = actual.token_address === expected.tokenAddress
        && BigInt(actual.block_number) === expected.blockNumber
        && actual.block_timestamp === expectedPgTimestamp(expected.blockTimestamp)
        && actual.from_address === expected.from
        && actual.to_address === expected.to
        && BigInt(actual.amount) === expected.amount;
      if (!matches) throw new Error(`persisted transfer ${expected.txHash}:${expected.logIndex} conflicts with the canonical RPC event`);
    }
  }
}

/** UTC wall-clock string for TIMESTAMP (without time zone) columns. */
export const toPgTimestamp = (d: Date): string => d.toISOString().replace('Z', '');

class PgTxRepo implements TxRepo {
  constructor(private readonly q: Queryable) {}

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.q.query<R>(text, values);
  }

  async upsertTokens(tokens: readonly TokenUpsert[]): Promise<Set<string>> {
    const inserted = new Set<string>();
    for (const part of chunks(tokens)) {
      const res = await this.q.query<{ address: string; inserted: boolean }>(
        `INSERT INTO tokens (address, name, symbol, decimals, total_supply, first_seen_block, last_seen_block)
         SELECT * FROM unnest($1::varchar[], $2::text[], $3::text[], $4::int[], $5::numeric[], $6::bigint[], $7::bigint[])
         ON CONFLICT (address) DO UPDATE SET
           name             = COALESCE(EXCLUDED.name, tokens.name),
           symbol           = COALESCE(EXCLUDED.symbol, tokens.symbol),
           decimals         = COALESCE(EXCLUDED.decimals, tokens.decimals),
           total_supply     = COALESCE(EXCLUDED.total_supply, tokens.total_supply),
           first_seen_block = LEAST(tokens.first_seen_block, EXCLUDED.first_seen_block),
           last_seen_block  = GREATEST(tokens.last_seen_block, EXCLUDED.last_seen_block),
           updated_at       = NOW()
         RETURNING address, (xmax = 0) AS inserted`,
        [
          part.map((t) => t.address),
          part.map((t) => t.name),
          part.map((t) => t.symbol),
          part.map((t) => t.decimals),
          part.map((t) => (t.totalSupply === null ? null : t.totalSupply.toString())),
          part.map((t) => t.firstSeenBlock.toString()),
          part.map((t) => t.lastSeenBlock.toString()),
        ],
      );
      for (const r of res.rows) if (r.inserted) inserted.add(r.address);
    }
    return inserted;
  }

  async insertTransfers(transfers: readonly StoredTransfer[]): Promise<StoredTransfer[]> {
    const byKey = new Map(transfers.map((t) => [`${t.txHash}:${t.logIndex}`, t]));
    const inserted: StoredTransfer[] = [];
    for (const part of chunks(transfers)) {
      const res = await this.q.query<{ tx_hash: string; log_index: number }>(
        `INSERT INTO transfers (token_address, tx_hash, log_index, block_number, block_timestamp, from_address, to_address, amount)
         SELECT * FROM unnest($1::varchar[], $2::varchar[], $3::int[], $4::bigint[], $5::timestamp[], $6::varchar[], $7::varchar[], $8::numeric[])
         ON CONFLICT (tx_hash, log_index) DO NOTHING
         RETURNING tx_hash, log_index`,
        [
          part.map((t) => t.tokenAddress),
          part.map((t) => t.txHash),
          part.map((t) => t.logIndex),
          part.map((t) => t.blockNumber.toString()),
          part.map((t) => toPgTimestamp(t.blockTimestamp)),
          part.map((t) => t.from),
          part.map((t) => t.to),
          part.map((t) => t.amount.toString()),
        ],
      );
      for (const r of res.rows) {
        const t = byKey.get(`${r.tx_hash}:${r.log_index}`);
        if (t) inserted.push(t);
      }
    }
    return inserted;
  }

  async loadBalances(keys: ReadonlyArray<{ token: string; holder: string }>): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const part of chunks(keys)) {
      const res = await this.q.query<{ token_address: string; holder_address: string; balance: string }>(
        `SELECT b.token_address, b.holder_address, b.balance::text AS balance
         FROM balances b
         JOIN unnest($1::varchar[], $2::varchar[]) AS k(token, holder)
           ON b.token_address = k.token AND b.holder_address = k.holder
         FOR UPDATE OF b`,
        [part.map((k) => k.token), part.map((k) => k.holder)],
      );
      for (const r of res.rows) out.set(balanceKey(r.token_address, r.holder_address), BigInt(r.balance));
    }
    return out;
  }

  async saveBalances(updates: readonly BalanceUpdate[]): Promise<void> {
    for (const part of chunks(updates)) {
      await this.q.query(
        `INSERT INTO balances (token_address, holder_address, balance, last_updated_block)
         SELECT * FROM unnest($1::varchar[], $2::varchar[], $3::numeric[], $4::bigint[])
         ON CONFLICT (token_address, holder_address) DO UPDATE SET
           balance            = EXCLUDED.balance,
           last_updated_block = GREATEST(balances.last_updated_block, EXCLUDED.last_updated_block)`,
        [
          part.map((u) => u.tokenAddress),
          part.map((u) => u.holderAddress),
          part.map((u) => u.balance.toString()),
          part.map((u) => u.lastUpdatedBlock.toString()),
        ],
      );
    }
  }

  async addBalanceAnomalies(countsByToken: ReadonlyMap<string, number>): Promise<void> {
    if (countsByToken.size === 0) return;
    await this.q.query(
      `UPDATE tokens t SET balance_anomalies = t.balance_anomalies + k.c, updated_at = NOW()
       FROM unnest($1::varchar[], $2::int[]) AS k(a, c) WHERE t.address = k.a`,
      [[...countsByToken.keys()], [...countsByToken.values()]],
    );
  }

  writeCheckpoint(expectedPrev: bigint | null, next: bigint): Promise<void> {
    return writeCheckpoint(this.q, expectedPrev, next);
  }
}

export class PgStore implements Store {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      // Store and read TIMESTAMP columns as UTC regardless of server locale.
      options: '-c timezone=UTC',
    });
    // Idle-client errors (e.g. DB restart) must not crash the process; the next query will reconnect.
    this.pool.on('error', (err) => logger.warn('postgres idle client error', { error: err }));
  }

  async getCheckpoint(): Promise<bigint | null> {
    return readCheckpoint(this.pool);
  }

  async getKnownTokens(addresses: readonly string[]): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const res = await this.pool.query<{ address: string }>(
      'SELECT address FROM tokens WHERE address = ANY($1::varchar[])',
      [addresses],
    );
    return new Set(res.rows.map((r) => r.address));
  }

  async acquireIndexerLock(): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    const lockKey = '810809299801';
    try {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked', [lockKey],
      );
      if (!result.rows[0]?.locked) throw new Error('another indexer or historical backfill operation already holds the database lock');
    } catch (err) {
      client.release();
      throw err;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
      } finally {
        client.release();
      }
    };
  }

  async prepareHistoricalBackfill(tokenAddress: string, startBlock: bigint, targetBlock: bigint): Promise<HistoricalBackfillState> {
    if (startBlock < 0n || targetBlock < startBlock) throw new Error('invalid historical backfill bounds');
    const result = await this.pool.query<{
      token_address: string; start_block: string; target_block: string; next_block: string; reconciled_through_block: string | null;
    }>(
      `INSERT INTO historical_backfill_state (token_address, start_block, target_block, next_block)
       SELECT address, $2, $3, $2 FROM tokens WHERE address = LOWER($1)
       ON CONFLICT (token_address) DO UPDATE SET
         start_block = LEAST(historical_backfill_state.start_block, EXCLUDED.start_block),
         target_block = GREATEST(historical_backfill_state.target_block, EXCLUDED.target_block),
         next_block = CASE WHEN EXCLUDED.start_block < historical_backfill_state.start_block
                           THEN EXCLUDED.start_block ELSE historical_backfill_state.next_block END,
         reconciled_through_block = CASE
           WHEN EXCLUDED.start_block < historical_backfill_state.start_block
             OR EXCLUDED.target_block > historical_backfill_state.target_block THEN NULL
           ELSE historical_backfill_state.reconciled_through_block END,
         updated_at = NOW()
       RETURNING token_address, start_block::text, target_block::text, next_block::text,
                 reconciled_through_block::text`,
      [tokenAddress.toLowerCase(), startBlock.toString(), targetBlock.toString()],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`token ${tokenAddress} is not present in the indexed token table`);
    return {
      tokenAddress: row.token_address,
      startBlock: BigInt(row.start_block),
      targetBlock: BigInt(row.target_block),
      nextBlock: BigInt(row.next_block),
      reconciledThroughBlock: row.reconciled_through_block === null ? null : BigInt(row.reconciled_through_block),
    };
  }

  async commitHistoricalBackfillRange(input: {
    token: TokenUpsert; expectedNextBlock: bigint; fromBlock: bigint; toBlock: bigint; transfers: readonly StoredTransfer[];
  }): Promise<HistoricalRangeCommit> {
    if (input.fromBlock !== input.expectedNextBlock || input.toBlock < input.fromBlock) {
      throw new Error('historical backfill range is not contiguous');
    }
    for (const transfer of input.transfers) {
      if (transfer.tokenAddress !== input.token.address || transfer.blockNumber < input.fromBlock || transfer.blockNumber > input.toBlock) {
        throw new Error('historical transfer does not match its token/range');
      }
    }
    return this.transaction(async (repo) => {
      const lock = await repo.query<{ address: string }>(
        'SELECT address FROM tokens WHERE address = $1 FOR UPDATE', [input.token.address],
      );
      if (!lock.rows[0]) throw new Error(`token ${input.token.address} is not present in the indexed token table`);
      const cursor = await repo.query<{ next_block: string }>(
        'SELECT next_block::text FROM historical_backfill_state WHERE token_address = $1 FOR UPDATE', [input.token.address],
      );
      if (!cursor.rows[0] || BigInt(cursor.rows[0].next_block) !== input.expectedNextBlock) {
        throw new Error('historical backfill cursor changed; refusing to skip or replay an unverified range');
      }

      if (input.transfers.length) await repo.upsertTokens([input.token]);
      const inserted = await repo.insertTransfers(input.transfers);
      await verifyStoredTransfers(repo, input.transfers);

      const advanced = await repo.query(
        `UPDATE historical_backfill_state SET next_block = $3, reconciled_through_block = NULL, updated_at = NOW()
         WHERE token_address = $1 AND next_block = $2`,
        [input.token.address, input.expectedNextBlock.toString(), (input.toBlock + 1n).toString()],
      );
      if (advanced.rowCount !== 1) throw new Error('historical backfill cursor compare-and-set failed');
      return { insertedTransfers: inserted.length, duplicateTransfers: input.transfers.length - inserted.length };
    });
  }

  async rebuildTokenBalances(tokenAddress: string): Promise<BalanceRebuildResult> {
    const address = tokenAddress.toLowerCase();
    return this.transaction(async (repo) => {
      const token = await repo.query<{ address: string }>(
        'SELECT address FROM tokens WHERE address = $1 FOR UPDATE', [address],
      );
      if (!token.rows[0]) throw new Error(`token ${address} is not present in the indexed token table`);
      const state = await repo.query<{ start_block: string; target_block: string; next_block: string }>(
        'SELECT start_block::text, target_block::text, next_block::text FROM historical_backfill_state WHERE token_address = $1 FOR UPDATE', [address],
      );
      const cursor = state.rows[0];
      if (!cursor || BigInt(cursor.next_block) <= BigInt(cursor.target_block)) {
        throw new Error('historical replay is incomplete; balances cannot be reconciled yet');
      }

      const balances = new Map<string, bigint>();
      const lastUpdates = new Map<string, BalanceUpdate>();
      let transferCount = 0;
      let anomalyCount = 0;
      let lastBlock = BigInt(cursor.start_block);
      let pageBlock = -1n;
      let pageLogIndex = -1;
      const pageSize = 5000;
      for (;;) {
        const page = await repo.query<{
          token_address: string; block_number_text: string; log_index: number; tx_hash: string;
          from_address: string; to_address: string; amount: string;
        }>(
          `SELECT token_address, block_number::text AS block_number_text, log_index, tx_hash, from_address, to_address, amount::text
           FROM transfers
           WHERE token_address = $1 AND (block_number > $2 OR (block_number = $2 AND log_index > $3))
           ORDER BY transfers.block_number ASC, transfers.log_index ASC LIMIT $4`,
          [address, pageBlock.toString(), pageLogIndex, pageSize],
        );
        if (!page.rows.length) break;
        const transfers: BalanceTransfer[] = page.rows.map((row) => ({
          tokenAddress: row.token_address,
          blockNumber: BigInt(row.block_number_text),
          logIndex: row.log_index,
          txHash: row.tx_hash,
          from: row.from_address,
          to: row.to_address,
          amount: BigInt(row.amount),
        }));
        const result = applyTransfers(balances, transfers);
        for (const update of result.updates) {
          const key = balanceKey(update.tokenAddress, update.holderAddress);
          balances.set(key, update.balance);
          lastUpdates.set(key, update);
        }
        transferCount += transfers.length;
        anomalyCount += result.anomalies.length;
        const final = page.rows[page.rows.length - 1]!;
        pageBlock = BigInt(final.block_number_text);
        pageLogIndex = final.log_index;
        lastBlock = pageBlock;
      }

      // All new state is computed before existing balances are touched. The delete,
      // replacement, anomaly count, and reconciliation marker commit atomically.
      await repo.query('DELETE FROM balances WHERE token_address = $1', [address]);
      await repo.saveBalances([...lastUpdates.values()]);
      await repo.query(
        'UPDATE tokens SET balance_anomalies = $2, updated_at = NOW() WHERE address = $1',
        [address, anomalyCount],
      );
      const reconciledThroughBlock = lastBlock > BigInt(cursor.target_block) ? lastBlock : BigInt(cursor.target_block);
      await repo.query(
        'UPDATE historical_backfill_state SET reconciled_through_block = $2, updated_at = NOW() WHERE token_address = $1',
        [address, reconciledThroughBlock.toString()],
      );
      return { transferCount, balanceRows: lastUpdates.size, anomalyCount, reconciledThroughBlock };
    });
  }

  async transaction<T>(fn: (repo: TxRepo) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await fn(new PgTxRepo(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        broken = true;
        logger.warn('rollback failed (connection likely lost); transaction is discarded by the server', { error: rbErr });
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async ping(): Promise<{ version: string }> {
    const res = await this.pool.query<{ version: string }>('SELECT version()');
    return { version: res.rows[0]?.version ?? 'unknown' };
  }

  async missingTables(): Promise<string[]> {
    const res = await this.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [[...REQUIRED_TABLES]],
    );
    const present = new Set(res.rows.map((r) => r.table_name));
    return REQUIRED_TABLES.filter((t) => !present.has(t));
  }

  async applySchema(schemaPath: string | URL): Promise<void> {
    const sql = await readFile(schemaPath, 'utf8');
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
