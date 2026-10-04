/**
 * Block-range scanner: plans the next confirmed range, fetches Transfer logs with
 * adaptive range sizing, validates token candidates, resolves timestamps and commits.
 */
import { isAddress, toHex, type PublicClient } from 'viem';
import { TRANSFER_TOPIC } from './abi/erc20.js';
import { nextBlockToProcess, safeTargetBlock } from './checkpoint.js';
import { isRangeTooLargeError, isTransientError, sleep, withRetry, type RetryOptions } from './client.js';
import type { IndexerConfig } from './config.js';
import type { HistoricalBackfillState, Store, StoredTransfer, TokenUpsert } from './database.js';
import { logger } from './logger.js';
import type { TokenValidator } from './token-validator.js';
import { commitRange, decodeTransferLog, normalizeAddress, type DecodedTransfer, type RawLog } from './transfer-processor.js';

// ---------------------------------------------------------------------------
// Chain access abstraction
// ---------------------------------------------------------------------------

export interface ChainReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransferLogs(fromBlock: bigint, toBlock: bigint, address?: string): Promise<RawLog[]>;
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
}

export function viemChainReader(client: PublicClient): ChainReader {
  return {
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getTransferLogs(fromBlock, toBlock, address) {
      // Raw request: keeps node-provided fields such as `blockTimestamp` intact.
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [{ fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), ...(address ? { address: address as `0x${string}` } : {}), topics: [TRANSFER_TOPIC] }],
      });
      return logs as unknown as RawLog[];
    },
    async getBlockTimestamp(blockNumber) {
      const block = await client.getBlock({ blockNumber, includeTransactions: false });
      return block.timestamp;
    },
  };
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Adaptive eth_getLogs
// ---------------------------------------------------------------------------

export class RangeFetchError extends Error {
  override readonly name = 'RangeFetchError';
  constructor(message: string, readonly fromBlock: bigint, readonly toBlock: bigint, override readonly cause: unknown) {
    super(message);
  }
}

export interface FetchResult {
  readonly logs: RawLog[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly batchSize: number;
}

/**
 * Fetches logs for [from, min(from + size - 1, maxTo)].
 * On "range too large" / timeout / exhausted transient retries the range is halved
 * (2000 -> 1000 -> 500 -> 250 ...) down to `minBatchSize`. After a run of successes the
 * size grows back towards the configured maximum.
 */
export class AdaptiveLogFetcher {
  private size: number;
  private successStreak = 0;
  static readonly GROW_AFTER = 5;

  constructor(
    private readonly chain: ChainReader,
    private readonly maxBatchSize: number,
    private readonly minBatchSize: number,
    private readonly retry: Omit<RetryOptions, 'label'>,
  ) {
    this.size = maxBatchSize;
  }

  get currentBatchSize(): number {
    return this.size;
  }

  async fetch(fromBlock: bigint, maxTo: bigint, address?: string): Promise<FetchResult> {
    for (;;) {
      const span = BigInt(this.size - 1);
      const toBlock = fromBlock + span < maxTo ? fromBlock + span : maxTo;
      try {
        const logs = await withRetry(() => this.chain.getTransferLogs(fromBlock, toBlock, address), {
          ...this.retry,
          // Range errors are handled by shrinking, not by retrying the same request.
          isRetryable: (e) => !isRangeTooLargeError(e) && isTransientError(e),
          label: `eth_getLogs ${fromBlock}-${toBlock}`,
        });
        this.onSuccess();
        return { logs, fromBlock, toBlock, batchSize: this.size };
      } catch (err) {
        const shrinkable = isRangeTooLargeError(err) || isTransientError(err);
        const width = Number(toBlock - fromBlock + 1n);
        if (!shrinkable || width <= this.minBatchSize) {
          logger.error('eth_getLogs failed for range', { from: fromBlock, to: toBlock, error: err });
          throw new RangeFetchError(`eth_getLogs failed for ${fromBlock}-${toBlock}`, fromBlock, toBlock, err);
        }
        const next = Math.max(this.minBatchSize, Math.floor(Math.min(this.size, width) / 2));
        logger.warn('eth_getLogs failed; reducing batch size', { from: fromBlock, to: toBlock, batchSize: `${this.size} -> ${next}`, error: err });
        this.size = next;
        this.successStreak = 0;
      }
    }
  }

  private onSuccess(): void {
    if (this.size >= this.maxBatchSize) return;
    if (++this.successStreak >= AdaptiveLogFetcher.GROW_AFTER) {
      this.size = Math.min(this.maxBatchSize, this.size * 2);
      this.successStreak = 0;
      logger.debug('increasing batch size', { batchSize: this.size });
    }
  }
}

// ---------------------------------------------------------------------------
// Block timestamps
// ---------------------------------------------------------------------------

/** In-memory block -> unix-seconds cache. Each block is fetched at most once per scan. */
export class BlockTimestampCache {
  private readonly cache = new Map<bigint, bigint>();
  private readonly inflight = new Map<bigint, Promise<bigint>>();
  fetches = 0;

  constructor(
    private readonly chain: ChainReader,
    private readonly retry: Omit<RetryOptions, 'label'>,
    private readonly concurrency: number,
  ) {}

  /** Seed from timestamps the node already included in logs (avoids any getBlock call). */
  seed(blockNumber: bigint, timestamp: bigint): void {
    if (!this.cache.has(blockNumber)) this.cache.set(blockNumber, timestamp);
  }

  get size(): number {
    return this.cache.size;
  }

  private get(blockNumber: bigint): Promise<bigint> {
    const hit = this.cache.get(blockNumber);
    if (hit !== undefined) return Promise.resolve(hit);
    let p = this.inflight.get(blockNumber);
    if (!p) {
      this.fetches++;
      p = withRetry(() => this.chain.getBlockTimestamp(blockNumber), { ...this.retry, label: `getBlock ${blockNumber}` })
        .then((ts) => {
          this.cache.set(blockNumber, ts);
          return ts;
        })
        .finally(() => this.inflight.delete(blockNumber));
      this.inflight.set(blockNumber, p);
    }
    return p;
  }

  async resolve(blockNumbers: Iterable<bigint>): Promise<Map<bigint, bigint>> {
    const unique = [...new Set(blockNumbers)];
    const values = await mapLimit(unique, this.concurrency, (b) => this.get(b));
    return new Map(unique.map((b, i) => [b, values[i] as bigint]));
  }

  /** Drop entries below `blockNumber` to keep memory bounded during long scans. */
  pruneBelow(blockNumber: bigint): void {
    for (const k of this.cache.keys()) if (k < blockNumber) this.cache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Range processing
// ---------------------------------------------------------------------------

export interface RangeReport {
  readonly status: 'processed';
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly latestBlock: bigint;
  readonly targetBlock: bigint;
  readonly batchSize: number;
  readonly rawLogs: number;
  readonly erc20Logs: number;
  readonly nonErc20Logs: number;
  readonly candidates: number;
  readonly rejectedCandidates: number;
  readonly transferLogs: number;
  readonly insertedTransfers: number;
  readonly duplicateTransfers: number;
  readonly newTokens: number;
  readonly updatedHolders: number;
  readonly anomalies: number;
  readonly checkpoint: bigint;
}

export interface IdleReport {
  readonly status: 'idle' | 'stopped';
  readonly latestBlock: bigint;
  readonly targetBlock: bigint | null;
  readonly checkpoint: bigint | null;
}

export class RangeProcessingError extends Error {
  override readonly name = 'RangeProcessingError';
  constructor(readonly fromBlock: bigint, readonly toBlock: bigint, override readonly cause: unknown) {
    super(`processing failed for range ${fromBlock}-${toBlock}: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`);
  }
}

export type ScannerConfig = Pick<
  IndexerConfig,
  'startBlock' | 'stopBlock' | 'blockBatchSize' | 'minBlockBatchSize' | 'confirmationBlocks' | 'rpcConcurrency' | 'rpcMaxRetries' | 'rpcRetryBaseDelayMs'
>;

export class Scanner {
  readonly fetcher: AdaptiveLogFetcher;
  readonly timestamps: BlockTimestampCache;
  private readonly retry: Omit<RetryOptions, 'label'>;

  constructor(
    private readonly chain: ChainReader,
    private readonly store: Store,
    private readonly validator: TokenValidator,
    private readonly config: ScannerConfig,
    retryOverrides: Partial<Omit<RetryOptions, 'label'>> = {},
  ) {
    this.retry = { maxRetries: config.rpcMaxRetries, baseDelayMs: config.rpcRetryBaseDelayMs, ...retryOverrides };
    this.fetcher = new AdaptiveLogFetcher(chain, config.blockBatchSize, config.minBlockBatchSize, this.retry);
    this.timestamps = new BlockTimestampCache(chain, this.retry, config.rpcConcurrency);
  }

  async latestBlock(): Promise<bigint> {
    return withRetry(() => this.chain.getBlockNumber(), { ...this.retry, label: 'eth_blockNumber' });
  }

  /** Process exactly one range (or report idle/stopped). Never advances the checkpoint unless the range committed. */
  async processNextRange(): Promise<RangeReport | IdleReport> {
    const checkpoint = await this.store.getCheckpoint();
    const latestBlock = await this.latestBlock();
    const targetBlock = safeTargetBlock(latestBlock, this.config.confirmationBlocks, this.config.stopBlock);
    const fromBlock = nextBlockToProcess(checkpoint, this.config.startBlock);

    if (this.config.stopBlock !== null && checkpoint !== null && checkpoint >= this.config.stopBlock) {
      return { status: 'stopped', latestBlock, targetBlock, checkpoint };
    }
    if (targetBlock === null || fromBlock > targetBlock) {
      return { status: 'idle', latestBlock, targetBlock, checkpoint };
    }

    let toBlock = targetBlock;
    try {
      const fetched = await this.fetcher.fetch(fromBlock, targetBlock);
      toBlock = fetched.toBlock;
      return await this.processLogs(fetched, checkpoint, latestBlock, targetBlock);
    } catch (err) {
      const to = err instanceof RangeFetchError ? err.toBlock : toBlock;
      throw new RangeProcessingError(fromBlock, to, err);
    }
  }

  private async processLogs(fetched: FetchResult, checkpoint: bigint | null, latestBlock: bigint, targetBlock: bigint): Promise<RangeReport> {
    const { fromBlock, toBlock } = fetched;

    // 1. Decode (strict ERC-20 shape) and sanity-check the RPC response.
    const decoded: DecodedTransfer[] = [];
    let nonErc20Logs = 0;
    for (const log of fetched.logs) {
      const r = decodeTransferLog(log);
      if (!r.ok) {
        nonErc20Logs++;
        continue;
      }
      if (r.transfer.blockNumber < fromBlock || r.transfer.blockNumber > toBlock) {
        throw new Error(`RPC returned log at block ${r.transfer.blockNumber} outside requested range ${fromBlock}-${toBlock}`);
      }
      decoded.push(r.transfer);
    }

    // 2. Validate token candidates.
    const candidateAddrs = [...new Set(decoded.map((t) => t.tokenAddress))];
    const known = await this.store.getKnownTokens(candidateAddrs);
    const unknown = candidateAddrs.filter((a) => !known.has(a));
    const validations = await mapLimit(unknown, this.config.rpcConcurrency, (a) => this.validator.validate(a));
    const supplies = await mapLimit([...known], this.config.rpcConcurrency, async (a) => [a, await this.validator.refreshTotalSupply(a)] as const);

    const valid = new Set<string>(known);
    const newMeta = new Map<string, { name: string | null; symbol: string | null; decimals: number; totalSupply: bigint }>();
    let rejectedCandidates = 0;
    for (const v of validations) {
      if (v.valid) {
        valid.add(v.metadata.address);
        newMeta.set(v.metadata.address, v.metadata);
      } else rejectedCandidates++;
    }
    const transfers = decoded.filter((t) => valid.has(t.tokenAddress));

    // 3. Timestamps: prefer node-provided log timestamps, otherwise one cached getBlock per block.
    for (const t of transfers) if (t.logTimestamp !== null) this.timestamps.seed(t.blockNumber, t.logTimestamp);
    const tsByBlock = await this.timestamps.resolve(transfers.map((t) => t.blockNumber));

    // 4. Token rows (first/last seen within this range).
    const seen = new Map<string, { first: bigint; last: bigint }>();
    for (const t of transfers) {
      const s = seen.get(t.tokenAddress);
      if (!s) seen.set(t.tokenAddress, { first: t.blockNumber, last: t.blockNumber });
      else {
        if (t.blockNumber < s.first) s.first = t.blockNumber;
        if (t.blockNumber > s.last) s.last = t.blockNumber;
      }
    }
    const supplyByToken = new Map(supplies);
    const tokens: TokenUpsert[] = [...seen.entries()].map(([address, s]) => {
      const m = newMeta.get(address);
      return {
        address,
        name: m?.name ?? null,
        symbol: m?.symbol ?? null,
        decimals: m?.decimals ?? null,
        totalSupply: m?.totalSupply ?? supplyByToken.get(address) ?? null,
        firstSeenBlock: s.first,
        lastSeenBlock: s.last,
      };
    });

    const stored: StoredTransfer[] = transfers.map((t) => {
      const ts = tsByBlock.get(t.blockNumber);
      if (ts === undefined) throw new Error(`missing timestamp for block ${t.blockNumber}`);
      return {
        tokenAddress: t.tokenAddress,
        txHash: t.txHash,
        logIndex: t.logIndex,
        blockNumber: t.blockNumber,
        blockTimestamp: new Date(Number(ts) * 1000),
        from: t.from,
        to: t.to,
        amount: t.amount,
      };
    });

    if (logger.enabled('debug')) {
      for (const t of stored) logger.debug('transfer', { token: t.tokenAddress, tx: t.txHash, logIndex: t.logIndex, from: t.from, to: t.to, amount: t.amount });
    }

    // 5. Atomic commit (tokens -> transfers -> balances -> checkpoint).
    const res = await commitRange(this.store, {
      fromBlock,
      toBlock,
      expectedPrevCheckpoint: checkpoint,
      tokens,
      transfers: stored,
    });

    for (const a of res.anomalies.slice(0, 20)) {
      logger.warn('balance mutation rejected (would go negative)', {
        token: a.tokenAddress, tx: a.txHash, logIndex: a.logIndex, holder: a.holder, balance: a.balance, amount: a.amount,
      });
    }
    if (res.anomalies.length > 20) logger.warn(`... ${res.anomalies.length - 20} more balance anomalies in range`);

    this.timestamps.pruneBelow(toBlock);

    return {
      status: 'processed',
      fromBlock,
      toBlock,
      latestBlock,
      targetBlock,
      batchSize: fetched.batchSize,
      rawLogs: fetched.logs.length,
      erc20Logs: decoded.length,
      nonErc20Logs,
      candidates: candidateAddrs.length,
      rejectedCandidates,
      transferLogs: stored.length,
      insertedTransfers: res.insertedTransfers,
      duplicateTransfers: res.duplicateTransfers,
      newTokens: res.newTokens,
      updatedHolders: res.updatedHolders,
      anomalies: res.anomalies.length,
      checkpoint: toBlock,
    };
  }
}

export interface HistoricalBackfillReport {
  readonly tokenAddress: string;
  readonly startBlock: bigint;
  readonly targetBlock: bigint;
  readonly ranges: number;
  readonly blocks: bigint;
  readonly insertedTransfers: number;
  readonly duplicateTransfers: number;
  readonly reconciliation: Awaited<ReturnType<Store['rebuildTokenBalances']>>;
}

/**
 * Token-scoped historical replay. Its cursor is independent of the normal global
 * checkpoint; the final balance replacement is serialized with normal indexing by
 * PgStore's shared advisory lock.
 */
export class HistoricalBackfiller {
  readonly fetcher: AdaptiveLogFetcher;
  readonly timestamps: BlockTimestampCache;
  private readonly retry: Omit<RetryOptions, 'label'>;

  constructor(
    private readonly chain: ChainReader,
    private readonly store: Store,
    private readonly validator: TokenValidator,
    private readonly config: ScannerConfig,
    retryOverrides: Partial<Omit<RetryOptions, 'label'>> = {},
  ) {
    this.retry = { maxRetries: config.rpcMaxRetries, baseDelayMs: config.rpcRetryBaseDelayMs, ...retryOverrides };
    this.fetcher = new AdaptiveLogFetcher(chain, config.blockBatchSize, config.minBlockBatchSize, this.retry);
    this.timestamps = new BlockTimestampCache(chain, this.retry, config.rpcConcurrency);
  }

  async run(
    rawAddress: string,
    startBlock: bigint,
    requestedTargetBlock: bigint,
    onRange?: (range: FetchResult & { insertedTransfers: number; duplicateTransfers: number }) => void,
  ): Promise<HistoricalBackfillReport> {
    if (!isAddress(rawAddress)) throw new Error(`invalid token address: ${rawAddress}`);
    if (startBlock < 0n || requestedTargetBlock < startBlock) throw new Error('invalid historical backfill bounds');
    const address = normalizeAddress(rawAddress);
    const releaseLock = await this.store.acquireIndexerLock();
    try {
      const validation = await this.validator.validate(address);
      if (!validation.valid) throw new Error(`historical backfill token validation failed: ${validation.reason}`);
      const state: HistoricalBackfillState = await this.store.prepareHistoricalBackfill(address, startBlock, requestedTargetBlock);
      let nextBlock = state.nextBlock;
      let ranges = 0;
      let blocks = 0n;
      let insertedTransfers = 0;
      let duplicateTransfers = 0;

      while (nextBlock <= state.targetBlock) {
        const fetched = await this.fetcher.fetch(nextBlock, state.targetBlock, address);
        const decoded: DecodedTransfer[] = [];
        for (const log of fetched.logs) {
          const result = decodeTransferLog(log);
          if (!result.ok) continue;
          if (result.transfer.tokenAddress !== address) throw new Error('RPC returned a historical log for a different token address');
          if (result.transfer.blockNumber < fetched.fromBlock || result.transfer.blockNumber > fetched.toBlock) {
            throw new Error(`RPC returned log outside requested range ${fetched.fromBlock}-${fetched.toBlock}`);
          }
          decoded.push(result.transfer);
        }

        for (const transfer of decoded) if (transfer.logTimestamp !== null) this.timestamps.seed(transfer.blockNumber, transfer.logTimestamp);
        const timestamps = await this.timestamps.resolve(decoded.map((transfer) => transfer.blockNumber));
        const transfers: StoredTransfer[] = decoded.map((transfer) => {
          const timestamp = timestamps.get(transfer.blockNumber);
          if (timestamp === undefined) throw new Error(`missing timestamp for block ${transfer.blockNumber}`);
          return {
            tokenAddress: address,
            txHash: transfer.txHash,
            logIndex: transfer.logIndex,
            blockNumber: transfer.blockNumber,
            blockTimestamp: new Date(Number(timestamp) * 1000),
            from: transfer.from,
            to: transfer.to,
            amount: transfer.amount,
          };
        });
        const token: TokenUpsert = {
          address,
          name: validation.metadata.name,
          symbol: validation.metadata.symbol,
          decimals: validation.metadata.decimals,
          totalSupply: validation.metadata.totalSupply,
          firstSeenBlock: transfers.length ? transfers.reduce((min, t) => t.blockNumber < min ? t.blockNumber : min, transfers[0]!.blockNumber) : state.startBlock,
          lastSeenBlock: transfers.length ? transfers.reduce((max, t) => t.blockNumber > max ? t.blockNumber : max, transfers[0]!.blockNumber) : state.startBlock,
        };
        const stored = await this.store.commitHistoricalBackfillRange({
          token, expectedNextBlock: nextBlock, fromBlock: fetched.fromBlock, toBlock: fetched.toBlock, transfers,
        });
        ranges++;
        blocks += fetched.toBlock - fetched.fromBlock + 1n;
        insertedTransfers += stored.insertedTransfers;
        duplicateTransfers += stored.duplicateTransfers;
        onRange?.({ ...fetched, insertedTransfers: stored.insertedTransfers, duplicateTransfers: stored.duplicateTransfers });
        this.timestamps.pruneBelow(fetched.toBlock);
        nextBlock = fetched.toBlock + 1n;
      }

      const reconciliation = await this.store.rebuildTokenBalances(address);
      return {
        tokenAddress: address,
        startBlock: state.startBlock,
        targetBlock: state.targetBlock,
        ranges,
        blocks,
        insertedTransfers,
        duplicateTransfers,
        reconciliation,
      };
    } finally {
      await releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

export interface RunOptions {
  readonly pollIntervalMs: number;
  readonly maxPermanentFailures: number;
  readonly maxBackoffMs?: number;
  readonly shouldStop?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRange?: (r: RangeReport) => void;
  readonly onIdle?: (r: IdleReport) => void;
}

export interface RunSummary {
  ranges: number;
  blocks: bigint;
  transferLogs: number;
  insertedTransfers: number;
  newTokens: number;
  updatedHolders: number;
  lastCheckpoint: bigint | null;
}

/**
 * Main loop. Transient failures (RPC/DB outage) are retried indefinitely with capped
 * exponential backoff — the same range is re-planned from the unchanged checkpoint.
 * Non-transient failures are retried `maxPermanentFailures` times, then thrown (process exits)
 * so a permanently invalid request is never retried forever and no block is ever skipped.
 */
export async function runIndexer(scanner: Scanner, opts: RunOptions): Promise<RunSummary> {
  const doSleep = opts.sleep ?? sleep;
  const maxBackoff = opts.maxBackoffMs ?? 60_000;
  const summary: RunSummary = { ranges: 0, blocks: 0n, transferLogs: 0, insertedTransfers: 0, newTokens: 0, updatedHolders: 0, lastCheckpoint: null };
  let transientFailures = 0;
  let permanentFailures = 0;

  while (!(opts.shouldStop?.() ?? false)) {
    try {
      const r = await scanner.processNextRange();
      transientFailures = 0;
      permanentFailures = 0;
      if (r.status === 'processed') {
        summary.ranges++;
        summary.blocks += r.toBlock - r.fromBlock + 1n;
        summary.transferLogs += r.transferLogs;
        summary.insertedTransfers += r.insertedTransfers;
        summary.newTokens += r.newTokens;
        summary.updatedHolders += r.updatedHolders;
        summary.lastCheckpoint = r.checkpoint;
        opts.onRange?.(r);
        continue;
      }
      summary.lastCheckpoint = r.checkpoint;
      opts.onIdle?.(r);
      if (r.status === 'stopped') break;
      await doSleep(opts.pollIntervalMs);
    } catch (err) {
      const range = err instanceof RangeProcessingError ? `${err.fromBlock}-${err.toBlock}` : 'n/a';
      const root = err instanceof RangeProcessingError ? err.cause : err;
      const transient = isTransientError(root) || (root as Error)?.name === 'CheckpointConflictError';
      if (transient) {
        transientFailures++;
        const delay = Math.min(maxBackoff, 1000 * 2 ** Math.min(transientFailures - 1, 16));
        logger.error('range failed (transient); checkpoint NOT advanced, will retry', { range, attempt: transientFailures, retryInMs: delay, error: root });
        await doSleep(delay);
      } else {
        permanentFailures++;
        logger.error('range failed (non-transient); checkpoint NOT advanced', { range, attempt: permanentFailures, of: opts.maxPermanentFailures, error: root });
        if (permanentFailures >= opts.maxPermanentFailures) throw err;
        await doSleep(Math.min(maxBackoff, 1000 * 2 ** permanentFailures));
      }
    }
  }
  return summary;
}
