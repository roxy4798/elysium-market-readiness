/**
 * Test-only in-memory Store with real transactional semantics:
 * snapshot on BEGIN, restore on failure, UNIQUE(tx_hash, log_index) emulation,
 * non-negative balance and zero-address guards, compare-and-set checkpoint.
 * Lets the production commit orchestration run unchanged without PostgreSQL.
 */
import { CheckpointConflictError, assertMonotonic } from '../../src/checkpoint.js';
import type { Store, StoredTransfer, TokenUpsert, TxRepo } from '../../src/database.js';
import { ZERO_ADDRESS } from '../../src/abi/erc20.js';
import { balanceKey, type BalanceUpdate } from '../../src/holder-engine.js';

interface TokenRow extends TokenUpsert {
  balanceAnomalies: number;
}

interface State {
  tokens: Map<string, TokenRow>;
  transfers: Map<string, StoredTransfer>;
  balances: Map<string, { token: string; holder: string; balance: bigint; lastUpdatedBlock: bigint }>;
  checkpoint: bigint | null;
}

type FailPoint = keyof TxRepo;

const clone = (s: State): State => ({
  tokens: new Map([...s.tokens].map(([k, v]) => [k, { ...v }])),
  transfers: new Map(s.transfers),
  balances: new Map([...s.balances].map(([k, v]) => [k, { ...v }])),
  checkpoint: s.checkpoint,
});

export class MemoryStore implements Store {
  state: State = { tokens: new Map(), transfers: new Map(), balances: new Map(), checkpoint: null };
  /** Inject a one-shot failure at a given repo method (simulates a DB error mid-transaction). */
  failNext: { at: FailPoint; error: Error } | null = null;
  commits = 0;
  rollbacks = 0;

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

  async close(): Promise<void> {}

  balanceOf(token: string, holder: string): bigint | undefined {
    return this.state.balances.get(balanceKey(token, holder))?.balance;
  }
}
