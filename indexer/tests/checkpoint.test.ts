import { describe, expect, it } from 'vitest';
import { nextBlockToProcess, safeTargetBlock } from '../src/checkpoint.js';
import { Scanner, runIndexer, type ScannerConfig } from '../src/scanner.js';
import { TokenValidator } from '../src/token-validator.js';
import { commitRange } from '../src/transfer-processor.js';
import type { StoredTransfer, TokenUpsert } from '../src/database.js';
import { ADDR, FakeChain, FakeContracts, noSleep, standardToken, transferLog, txHash } from './helpers/fakes.js';
import { MemoryStore } from './helpers/memory-store.js';

const token = (address: string, block: bigint): TokenUpsert => ({
  address, name: 'A', symbol: 'A', decimals: 18, totalSupply: 1000n, firstSeenBlock: block, lastSeenBlock: block,
});
const stored = (from: string, to: string, amount: bigint, block: bigint, logIndex = 0, tx = txHash()): StoredTransfer => ({
  tokenAddress: ADDR.tokenA, txHash: tx, logIndex, blockNumber: block, blockTimestamp: new Date(1_700_000_000_000), from, to, amount,
});

const cfg = (over: Partial<ScannerConfig> = {}): ScannerConfig => ({
  startBlock: 0n, stopBlock: null, blockBatchSize: 100, minBlockBatchSize: 10, confirmationBlocks: 5,
  rpcConcurrency: 4, rpcMaxRetries: 2, rpcRetryBaseDelayMs: 0, ...over,
});

function setup(over: Partial<ScannerConfig> = {}) {
  const chain = new FakeChain();
  const store = new MemoryStore();
  const contracts = new FakeContracts({ [ADDR.tokenA]: standardToken('AAA'), [ADDR.tokenB]: standardToken('BBB') });
  const validator = new TokenValidator(contracts, { maxRetries: 1, baseDelayMs: 0, sleep: noSleep });
  const scanner = new Scanner(chain, store, validator, cfg(over), { sleep: noSleep });
  return { chain, store, contracts, scanner };
}

describe('9. duplicate transfer prevention', () => {
  it('re-committing the same transfer neither duplicates rows nor double-counts balances', async () => {
    const store = new MemoryStore();
    const mint = stored(ADDR.zero, ADDR.alice, 100n, 10n, 0);
    const send = stored(ADDR.alice, ADDR.bob, 40n, 10n, 1);
    const r1 = await commitRange(store, { fromBlock: 0n, toBlock: 10n, expectedPrevCheckpoint: null, tokens: [token(ADDR.tokenA, 10n)], transfers: [mint, send] });
    expect(r1.insertedTransfers).toBe(2);

    // Replay of overlapping data in the next range (e.g. operator reset): DB constraint swallows duplicates.
    const r2 = await commitRange(store, { fromBlock: 11n, toBlock: 20n, expectedPrevCheckpoint: 10n, tokens: [token(ADDR.tokenA, 15n)], transfers: [{ ...send, blockNumber: 15n }] });
    expect(r2.insertedTransfers).toBe(0);
    expect(r2.duplicateTransfers).toBe(1);
    expect(store.state.transfers.size).toBe(2);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(60n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.bob)).toBe(40n);
  });

  it('dedupes identical logs returned twice within one response', async () => {
    const store = new MemoryStore();
    const mint = stored(ADDR.zero, ADDR.alice, 100n, 1n);
    const r = await commitRange(store, { fromBlock: 0n, toBlock: 5n, expectedPrevCheckpoint: null, tokens: [token(ADDR.tokenA, 1n)], transfers: [mint, { ...mint }] });
    expect(r.insertedTransfers).toBe(1);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(100n);
  });

  it('scanning the same chain data twice from a reset checkpoint is idempotent', async () => {
    const { chain, store, scanner } = setup();
    chain.head = 105n;
    chain.logs = [
      transferLog({ token: ADDR.tokenA, from: ADDR.zero, to: ADDR.alice, amount: 500n, block: 3n, logIndex: 0 }),
      transferLog({ token: ADDR.tokenA, from: ADDR.alice, to: ADDR.bob, amount: 200n, block: 50n, logIndex: 0 }),
    ];
    await scanner.processNextRange();
    store.state.checkpoint = null; // simulate an operator rewinding the checkpoint
    const r = await scanner.processNextRange();
    expect(r.status === 'processed' && r.insertedTransfers).toBe(0);
    expect(r.status === 'processed' && r.duplicateTransfers).toBe(2);
    expect(store.state.transfers.size).toBe(2);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(300n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.bob)).toBe(200n);
  });
});

describe('10. checkpoint advancement', () => {
  it('advances to the range end inside the commit', async () => {
    const { chain, store, scanner } = setup();
    chain.head = 255n; // safe target 250
    const r1 = await scanner.processNextRange();
    expect(r1).toMatchObject({ status: 'processed', fromBlock: 0n, toBlock: 99n, checkpoint: 99n });
    expect(store.state.checkpoint).toBe(99n);
    const r2 = await scanner.processNextRange();
    expect(r2).toMatchObject({ fromBlock: 100n, toBlock: 199n });
    const r3 = await scanner.processNextRange();
    expect(r3).toMatchObject({ fromBlock: 200n, toBlock: 250n }); // capped at head - confirmations
    expect(await scanner.processNextRange()).toMatchObject({ status: 'idle', checkpoint: 250n });
  });

  it('never processes unconfirmed blocks', () => {
    expect(safeTargetBlock(1000n, 5, null)).toBe(995n);
    expect(safeTargetBlock(3n, 5, null)).toBeNull();
    expect(safeTargetBlock(1000n, 5, 900n)).toBe(900n);
  });

  it('rejects non-contiguous or backwards checkpoint writes', async () => {
    const store = new MemoryStore();
    await commitRange(store, { fromBlock: 0n, toBlock: 10n, expectedPrevCheckpoint: null, tokens: [], transfers: [] });
    await expect(commitRange(store, { fromBlock: 20n, toBlock: 30n, expectedPrevCheckpoint: 10n, tokens: [], transfers: [] })).rejects.toThrow(/does not follow/);
    await expect(commitRange(store, { fromBlock: 6n, toBlock: 8n, expectedPrevCheckpoint: 5n, tokens: [], transfers: [] })).rejects.toThrow(/expected 5/);
    expect(store.state.checkpoint).toBe(10n);
  });
});

describe('11. checkpoint does not advance after a failed transaction', () => {
  it.each(['insertTransfers', 'saveBalances', 'writeCheckpoint'] as const)('rolls back everything when %s fails', async (at) => {
    const { chain, store, scanner } = setup();
    chain.head = 105n;
    chain.logs = [transferLog({ token: ADDR.tokenA, from: ADDR.zero, to: ADDR.alice, amount: 7n, block: 2n, logIndex: 0 })];
    store.failNext = { at, error: new Error(`simulated ${at} failure`) };
    await expect(scanner.processNextRange()).rejects.toThrow(/processing failed for range 0-99/);
    expect(store.state.checkpoint).toBeNull();
    expect(store.state.transfers.size).toBe(0);
    expect(store.state.tokens.size).toBe(0);
    expect(store.state.balances.size).toBe(0);
    expect(store.rollbacks).toBe(1);

    // The same range is retried and then succeeds — no block skipped.
    const r = await scanner.processNextRange();
    expect(r).toMatchObject({ status: 'processed', fromBlock: 0n, toBlock: 99n, insertedTransfers: 1 });
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(7n);
  });

  it('does not advance when the RPC fails permanently for a range', async () => {
    const { chain, store, scanner } = setup({ minBlockBatchSize: 100 });
    chain.head = 105n;
    chain.logErrors = [new Error('invalid argument 0: hex string without 0x prefix')];
    await expect(scanner.processNextRange()).rejects.toThrow(/range 0-99/);
    expect(store.state.checkpoint).toBeNull();
  });

  it('runIndexer retries a failed range and never skips it', async () => {
    const { chain, store, scanner } = setup({ stopBlock: 150n });
    chain.head = 1000n;
    chain.logs = [transferLog({ token: ADDR.tokenA, from: ADDR.zero, to: ADDR.alice, amount: 9n, block: 120n, logIndex: 0 })];
    store.failNext = { at: 'saveBalances', error: Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' }) };
    const ranges: string[] = [];
    const summary = await runIndexer(scanner, { pollIntervalMs: 0, maxPermanentFailures: 3, sleep: noSleep, onRange: (r) => ranges.push(`${r.fromBlock}-${r.toBlock}`) });
    expect(ranges).toEqual(['0-99', '100-150']);
    expect(summary.lastCheckpoint).toBe(150n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(9n);
  });

  it('runIndexer gives up on a permanently failing range after the configured attempts', async () => {
    const { chain, store, scanner } = setup({ minBlockBatchSize: 100 });
    chain.head = 1000n;
    chain.logErrors = Array.from({ length: 10 }, () => new Error('method handler crashed: invalid params'));
    await expect(runIndexer(scanner, { pollIntervalMs: 0, maxPermanentFailures: 3, sleep: noSleep })).rejects.toThrow(/range 0-99/);
    expect(chain.getLogsCalls).toHaveLength(3);
    expect(store.state.checkpoint).toBeNull();
  });
});

describe('12. resume behavior', () => {
  it('resumes at checkpoint + 1, or START_BLOCK when no checkpoint exists', () => {
    expect(nextBlockToProcess(1_250_000n, 0n)).toBe(1_250_001n);
    expect(nextBlockToProcess(null, 2_000_000n)).toBe(2_000_000n);
    expect(nextBlockToProcess(5n, 2_000_000n)).toBe(6n); // checkpoint wins over START_BLOCK
  });

  it('a fresh process (new scanner, same store) continues from the checkpoint, not from genesis', async () => {
    const first = setup({ startBlock: 1_250_000n });
    first.chain.head = 1_250_305n;
    await first.scanner.processNextRange();
    expect(first.store.state.checkpoint).toBe(1_250_099n);

    // "Restart": brand-new scanner/validator/chain client, persistent store survives.
    const chain2 = new FakeChain();
    chain2.head = 1_250_305n;
    const validator2 = new TokenValidator(new FakeContracts(), { maxRetries: 0, baseDelayMs: 0 });
    const scanner2 = new Scanner(chain2, first.store, validator2, cfg({ startBlock: 1_250_000n }), { sleep: noSleep });
    const r = await scanner2.processNextRange();
    expect(r).toMatchObject({ status: 'processed', fromBlock: 1_250_100n, toBlock: 1_250_199n });
    expect(chain2.getLogsCalls[0]).toEqual([1_250_100n, 1_250_199n]);
  });

  it('stops cleanly at STOP_BLOCK and reports stopped on the next run', async () => {
    const { chain, scanner } = setup({ stopBlock: 120n });
    chain.head = 10_000n;
    const s = await runIndexer(scanner, { pollIntervalMs: 0, maxPermanentFailures: 1, sleep: noSleep });
    expect(s.lastCheckpoint).toBe(120n);
    expect(await scanner.processNextRange()).toMatchObject({ status: 'stopped', checkpoint: 120n });
  });
});
