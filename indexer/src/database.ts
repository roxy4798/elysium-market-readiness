/**
 * PostgreSQL persistence.
 *
 * `Store` / `TxRepo` are small interfaces so the commit orchestration in
 * transfer-processor.ts is identical in production (PgStore) and in tests.
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { readCheckpoint, writeCheckpoint } from './checkpoint.js';
import { balanceKey, type BalanceUpdate } from './holder-engine.js';
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

export interface TxRepo {
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
  close(): Promise<void>;
}

export const REQUIRED_TABLES = [
  'tokens',
  'transfers',
  'balances',
  'indexer_state',
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

/** UTC wall-clock string for TIMESTAMP (without time zone) columns. */
export const toPgTimestamp = (d: Date): string => d.toISOString().replace('Z', '');

class PgTxRepo implements TxRepo {
  constructor(private readonly q: Queryable) {}

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
