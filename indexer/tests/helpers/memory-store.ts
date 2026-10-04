/**
 * Test-only in-memory Store with real transactional semantics:
 * snapshot on BEGIN, restore on failure, UNIQUE(tx_hash, log_index) emulation,
 * non-negative balance and zero-address guards, compare-and-set checkpoint.
 * Lets the production commit orchestration run unchanged without PostgreSQL.
 */
import { CheckpointConflictError, assertMonotonic } from '../../src/checkpoint.js';
import type { BalanceRebuildResult, HistoricalBackfillState, HistoricalRangeCommit, Store, StoredTransfer, TokenUpsert, TxRepo } from '../../src/database.js';
import { ZERO_ADDRESS } from '../../src/abi/erc20.js';
import { applyTransfers, balanceKey, type BalanceUpdate } from '../../src/holder-engine.js';

interface TokenRow extends TokenUpsert {
  balanceAnomalies: number;
}

interface State {
  tokens: Map<string, TokenRow>;
  transfers: Map<string, StoredTransfer>;
  balances: Map<string, { token: string; holder: string; balance: bigint; lastUpdatedBlock: bigint }>;
  checkpoint: bigint | null;
  historicalBackfills: Map<string, HistoricalBackfillState>;
}

type FailPoint = keyof TxRepo;

const clone = (s: State): State => ({
  tokens: new Map([...s.tokens].map(([k, v]) => [k, { ...v }])),
  transfers: new Map(s.transfers),
  balances: new Map([...s.balances].map(([k, v]) => [k, { ...v }])),
  checkpoint: s.checkpoint,
  historicalBackfills: new Map(s.historicalBackfills),
});

export class MemoryStore implements Store {
  state: State = { tokens: new Map(), transfers: new Map(), balances: new Map(), checkpoint: null, historicalBackfills: new Map() };
  /** Inject a one-shot failure at a given repo method (simulates a DB error mid-transaction). */
  failNext: { at: FailPoint; error: Error } | null = null;
  commits = 0;
  rollbacks = 0;
  failBackfillNext: 'afterTransferInsert' | 'duringRebuild' | null = null;

  async getCheckpoint(): Promise<bigint | null> {
    return this.state.checkpoint;
  }

  async getKnownTokens(addresses: readonly string[]): Promise<Set<string>> {
    return new Set(addresses.filter((a) => this.state.tokens.has(a)));
  }

  async transaction<T>(fn: (repo: TxRepo) => Promise<T>): Promise<T> {
    const working = clone(this.state);
    const maybeFail = (at: FailPoint) => {
      if (this.failNext?.at === at) {
        const e = this.failNext.error;
        this.failNext = null;
        throw e;
      }
    };
    const repo: TxRepo = {
      async query() { throw new Error('raw SQL is unavailable in MemoryStore'); },
      async upsertTokens(tokens) {
        maybeFail('upsertTokens');
        const inserted = new Set<string>();
        for (const t of tokens) {
          const cur = working.tokens.get(t.address);
          if (!cur) {
            working.tokens.set(t.address, { ...t, balanceAnomalies: 0 });
            inserted.add(t.address);
          } else {
            working.tokens.set(t.address, {
              ...cur,
              name: t.name ?? cur.name,
              symbol: t.symbol ?? cur.symbol,
              decimals: t.decimals ?? cur.decimals,
              totalSupply: t.totalSupply ?? cur.totalSupply,
              firstSeenBlock: t.firstSeenBlock < cur.firstSeenBlock ? t.firstSeenBlock : cur.firstSeenBlock,
              lastSeenBlock: t.lastSeenBlock > cur.lastSeenBlock ? t.lastSeenBlock : cur.lastSeenBlock,
            });
          }
        }
        return inserted;
      },
      async insertTransfers(transfers) {
        maybeFail('insertTransfers');
        const out: StoredTransfer[] = [];
        for (const t of transfers) {
          if (!working.tokens.has(t.tokenAddress)) throw new Error('FK violation: token not registered');
          const key = `${t.txHash}:${t.logIndex}`;
          if (working.transfers.has(key)) continue; // ON CONFLICT DO NOTHING
          working.transfers.set(key, t);
          out.push(t);
        }
        return out;
      },
      async loadBalances(keys) {
        maybeFail('loadBalances');
        const m = new Map<string, bigint>();
        for (const k of keys) {
          const row = working.balances.get(balanceKey(k.token, k.holder));
          if (row) m.set(balanceKey(k.token, k.holder), row.balance);
        }
        return m;
      },
      async saveBalances(updates: readonly BalanceUpdate[]) {
        maybeFail('saveBalances');
        for (const u of updates) {
          if (u.balance < 0n) throw new Error('CHECK violation: negative balance');
          if (u.holderAddress === ZERO_ADDRESS) throw new Error('CHECK violation: zero address holder');
          working.balances.set(balanceKey(u.tokenAddress, u.holderAddress), {
            token: u.tokenAddress,
            holder: u.holderAddress,
            balance: u.balance,
            lastUpdatedBlock: u.lastUpdatedBlock,
          });
        }
      },
      async addBalanceAnomalies(counts) {
        maybeFail('addBalanceAnomalies');
        for (const [a, c] of counts) {
          const t = working.tokens.get(a);
          if (t) t.balanceAnomalies += c;
        }
      },
      async writeCheckpoint(expectedPrev, next) {
        maybeFail('writeCheckpoint');
        assertMonotonic(expectedPrev, next);
        if (working.checkpoint !== expectedPrev) {
          throw new CheckpointConflictError(`expected ${expectedPrev}, found ${working.checkpoint}`);
        }
        working.checkpoint = next;
      },
    };

    try {
      const result = await fn(repo);
      this.state = working; // COMMIT
      this.commits++;
      return result;
    } catch (err) {
      this.rollbacks++; // ROLLBACK: working copy discarded
      throw err;
    }
  }

  async acquireIndexerLock(): Promise<() => Promise<void>> { return async () => {}; }

  async prepareHistoricalBackfill(tokenAddress: string, startBlock: bigint, targetBlock: bigint): Promise<HistoricalBackfillState> {
    if (startBlock < 0n || targetBlock < startBlock) throw new Error('invalid historical backfill bounds');
    const address = tokenAddress.toLowerCase();
    if (!this.state.tokens.has(address)) throw new Error(`token ${address} is not present in the indexed token table`);
    const current = this.state.historicalBackfills.get(address);
    const state: HistoricalBackfillState = current
      ? {
          tokenAddress: address,
          startBlock: current.startBlock < startBlock ? current.startBlock : startBlock,
          targetBlock: current.targetBlock > targetBlock ? current.targetBlock : targetBlock,
          nextBlock: startBlock < current.startBlock ? startBlock : current.nextBlock,
          reconciledThroughBlock: startBlock < current.startBlock || targetBlock > current.targetBlock ? null : current.reconciledThroughBlock,
        }
      : { tokenAddress: address, startBlock, targetBlock, nextBlock: startBlock, reconciledThroughBlock: null };
    this.state.historicalBackfills.set(address, state);
    return state;
  }

  async commitHistoricalBackfillRange(input: {
    token: TokenUpsert; expectedNextBlock: bigint; fromBlock: bigint; toBlock: bigint; transfers: readonly StoredTransfer[];
  }): Promise<HistoricalRangeCommit> {
    const working = clone(this.state);
    const address = input.token.address.toLowerCase();
    const cursor = working.historicalBackfills.get(address);
    if (!cursor || cursor.nextBlock !== input.expectedNextBlock || input.fromBlock !== cursor.nextBlock || input.toBlock < input.fromBlock) {
      throw new Error('historical backfill cursor changed or range is not contiguous');
    }
    if (!working.tokens.has(address)) throw new Error(`token ${address} is not present in the indexed token table`);
    if (input.transfers.length) {
      const current = working.tokens.get(address)!;
      working.tokens.set(address, {
        ...current,
        name: input.token.name ?? current.name,
        symbol: input.token.symbol ?? current.symbol,
        decimals: input.token.decimals ?? current.decimals,
        totalSupply: input.token.totalSupply ?? current.totalSupply,
        firstSeenBlock: input.token.firstSeenBlock < current.firstSeenBlock ? input.token.firstSeenBlock : current.firstSeenBlock,
        lastSeenBlock: input.token.lastSeenBlock > current.lastSeenBlock ? input.token.lastSeenBlock : current.lastSeenBlock,
      });
    }
    let insertedTransfers = 0;
    for (const transfer of input.transfers) {
      if (transfer.tokenAddress !== address || transfer.blockNumber < input.fromBlock || transfer.blockNumber > input.toBlock) {
        throw new Error('historical transfer does not match its token/range');
      }
      const key = `${transfer.txHash}:${transfer.logIndex}`;
      const existing = working.transfers.get(key);
      if (existing) {
        if (existing.tokenAddress !== transfer.tokenAddress || existing.blockNumber !== transfer.blockNumber
          || existing.blockTimestamp.toISOString() !== transfer.blockTimestamp.toISOString()
          || existing.from !== transfer.from || existing.to !== transfer.to || existing.amount !== transfer.amount) {
          throw new Error(`persisted transfer ${transfer.txHash}:${transfer.logIndex} conflicts with the canonical RPC event`);
        }
      } else {
        working.transfers.set(key, transfer);
        insertedTransfers++;
      }
    }
    if (this.failBackfillNext === 'afterTransferInsert') {
      this.failBackfillNext = null;
      this.rollbacks++;
      throw new Error('simulated backfill transaction failure');
    }
    working.historicalBackfills.set(address, { ...cursor, nextBlock: input.toBlock + 1n, reconciledThroughBlock: null });
    this.state = working;
    this.commits++;
    return { insertedTransfers, duplicateTransfers: input.transfers.length - insertedTransfers };
  }

  async rebuildTokenBalances(tokenAddress: string): Promise<BalanceRebuildResult> {
    const working = clone(this.state);
    const address = tokenAddress.toLowerCase();
    const cursor = working.historicalBackfills.get(address);
    if (!working.tokens.has(address)) throw new Error(`token ${address} is not present in the indexed token table`);
    if (!cursor || cursor.nextBlock <= cursor.targetBlock) throw new Error('historical replay is incomplete; balances cannot be reconciled yet');
    if (this.failBackfillNext === 'duringRebuild') {
      this.failBackfillNext = null;
      this.rollbacks++;
      throw new Error('simulated balance rebuild failure');
    }
    const transfers = [...working.transfers.values()]
      .filter((t) => t.tokenAddress === address)
      .sort((a, b) => a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex)
      .map((t) => ({ tokenAddress: t.tokenAddress, blockNumber: t.blockNumber, logIndex: t.logIndex, txHash: t.txHash, from: t.from, to: t.to, amount: t.amount }));
    const result = applyTransfers(new Map(), transfers);
    for (const [key, row] of working.balances) if (row.token === address) working.balances.delete(key);
    for (const update of result.updates) {
      if (update.balance < 0n || update.holderAddress === ZERO_ADDRESS) throw new Error('balance invariant violated during reconstruction');
      working.balances.set(balanceKey(address, update.holderAddress), {
        token: address, holder: update.holderAddress, balance: update.balance, lastUpdatedBlock: update.lastUpdatedBlock,
      });
    }
    const token = working.tokens.get(address)!;
    token.balanceAnomalies = result.anomalies.length;
    const reconciledThroughBlock = transfers.reduce((max, t) => t.blockNumber > max ? t.blockNumber : max, cursor.targetBlock);
    working.historicalBackfills.set(address, { ...cursor, reconciledThroughBlock });
    this.state = working;
    this.commits++;
    return { transferCount: transfers.length, balanceRows: result.updates.length, anomalyCount: result.anomalies.length, reconciledThroughBlock };
  }

  async close(): Promise<void> {}

  balanceOf(token: string, holder: string): bigint | undefined {
    return this.state.balances.get(balanceKey(token, holder))?.balance;
  }
}
