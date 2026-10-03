import { HttpRequestError, RpcRequestError, TimeoutError } from 'viem';
import { describe, expect, it } from 'vitest';
import { backoffDelay, isContractLogicError, isRangeTooLargeError, isTransientError, withRetry } from '../src/client.js';
import { AdaptiveLogFetcher, BlockTimestampCache, Scanner, type ScannerConfig } from '../src/scanner.js';
import { TokenValidator } from '../src/token-validator.js';
import { ADDR, FakeChain, FakeContracts, noSleep, revert, standardToken, transferLog } from './helpers/fakes.js';
import { MemoryStore } from './helpers/memory-store.js';

const http503 = () => new HttpRequestError({ url: 'https://rpc', status: 503 });
const retryOpts = { maxRetries: 3, baseDelayMs: 10, sleep: noSleep, onRetry: () => {} };

describe('13. RPC retry logic', () => {
  it('retries transient failures and then succeeds', async () => {
    let calls = 0;
    const delays: number[] = [];
    const v = await withRetry(async () => {
      if (++calls < 3) throw http503();
      return 'ok';
    }, { ...retryOpts, onRetry: (_a, d) => delays.push(d) });
    expect(v).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it('stops after maxRetries (bounded, never endless)', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new TimeoutError({ body: {}, url: 'https://rpc' }); }, retryOpts)).rejects.toBeInstanceOf(TimeoutError);
    expect(calls).toBe(4); // 1 + 3 retries
  });

  it('does not retry permanent errors', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw revert(); }, retryOpts)).rejects.toThrow(/reverted/);
    expect(calls).toBe(1);
  });

  it('uses exponential backoff with a cap', () => {
    const d = [0, 1, 2, 3].map((a) => backoffDelay(a, 100, 10_000));
    expect(d[0]).toBeGreaterThanOrEqual(80);
    expect(d[0]).toBeLessThanOrEqual(120);
    expect(d[3]).toBeGreaterThanOrEqual(640);
    expect(d[3]).toBeLessThanOrEqual(960);
    expect(backoffDelay(30, 100, 5000)).toBeLessThanOrEqual(5000);
  });

  it('classifies errors', () => {
    expect(isTransientError(http503())).toBe(true);
    expect(isTransientError(new HttpRequestError({ url: 'x', status: 429 }))).toBe(true);
    expect(isTransientError(new HttpRequestError({ url: 'x', status: 400 }))).toBe(false);
    expect(isTransientError(new TimeoutError({ body: {}, url: 'x' }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('db down'), { code: '57P01' }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('RPC Request failed.'), { code: -32017, details: 'Rate Limit Exceeded.' }))).toBe(true);
    expect(isTransientError(new RpcRequestError({ body: {}, error: { code: -32017, message: 'Rate Limit Exceeded' }, url: 'https://rpc' }))).toBe(true);
    expect(isTransientError(revert())).toBe(false);
    expect(isContractLogicError(revert())).toBe(true);
    expect(isRangeTooLargeError(new Error('eth_getLogs block range 7000 exceeds maximum of 2000; narrow fromBlock-toBlock'))).toBe(true);
    expect(isRangeTooLargeError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeTooLargeError(http503())).toBe(false);
  });

  it('a transient failure during token validation propagates (range retried) instead of rejecting the token', async () => {
    const contracts = new FakeContracts({ [ADDR.tokenA]: { ...(standardToken('AAA') as object), decimals: http503() } });
    const v = new TokenValidator(contracts, { maxRetries: 1, baseDelayMs: 0, sleep: noSleep, onRetry: () => {} });
    await expect(v.validate(ADDR.tokenA)).rejects.toBeInstanceOf(HttpRequestError);
    expect(v.isKnownInvalid(ADDR.tokenA)).toBe(false);
  });
});

describe('14. batch-size reduction on RPC failure', () => {
  it('halves 2000 -> 1000 -> 500 -> 250 until the node accepts the range', async () => {
    const chain = new FakeChain();
    chain.maxRange = 300;
    const f = new AdaptiveLogFetcher(chain, 2000, 10, retryOpts);
    const r = await f.fetch(0n, 10_000n);
    expect(chain.getLogsCalls.map(([a, b]) => Number(b - a + 1n))).toEqual([2000, 1000, 500, 250]);
    expect(r).toMatchObject({ fromBlock: 0n, toBlock: 249n, batchSize: 250 });
    expect(f.currentBatchSize).toBe(250);
  });

  it('shrinks on persistent timeouts too, after bounded retries', async () => {
    const chain = new FakeChain();
    const timeout = () => new TimeoutError({ body: {}, url: 'x' });
    chain.logErrors = [timeout(), timeout(), timeout(), timeout()]; // exhausts 1 + 3 retries at 2000
    const f = new AdaptiveLogFetcher(chain, 2000, 10, retryOpts);
    const r = await f.fetch(0n, 10_000n);
    expect(r.batchSize).toBe(1000);
    expect(chain.getLogsCalls).toHaveLength(5);
  });

  it('fails the range (no skipping) when even the minimum size is rejected', async () => {
    const chain = new FakeChain();
    chain.maxRange = 5;
    const f = new AdaptiveLogFetcher(chain, 40, 10, retryOpts);
    await expect(f.fetch(0n, 1000n)).rejects.toMatchObject({ name: 'RangeFetchError', fromBlock: 0n, toBlock: 9n });
    expect(chain.getLogsCalls.map(([a, b]) => Number(b - a + 1n))).toEqual([40, 20, 10]);
  });

  it('does not shrink on permanent non-range errors', async () => {
    const chain = new FakeChain();
    chain.logErrors = [new Error('invalid argument')];
    const f = new AdaptiveLogFetcher(chain, 2000, 10, retryOpts);
    await expect(f.fetch(0n, 10_000n)).rejects.toThrow(/eth_getLogs failed/);
    expect(chain.getLogsCalls).toHaveLength(1);
  });

  it('grows back toward the configured size after consecutive successes', async () => {
    const chain = new FakeChain();
    chain.logErrors = [new Error('block range exceeds maximum')];
    const f = new AdaptiveLogFetcher(chain, 2000, 10, retryOpts);
    let from = 0n;
    for (let i = 0; i < 1 + AdaptiveLogFetcher.GROW_AFTER; i++) from = (await f.fetch(from, 1_000_000n)).toBlock + 1n;
    expect(f.currentBatchSize).toBe(2000);
  });

  it('scanner commits the reduced range and checkpoints exactly its end', async () => {
    const chain = new FakeChain();
    chain.head = 5000n;
    chain.maxRange = 300;
    chain.logs = [transferLog({ token: ADDR.tokenA, from: ADDR.zero, to: ADDR.alice, amount: 1n, block: 260n, logIndex: 0 })];
    const store = new MemoryStore();
    const cfg: ScannerConfig = { startBlock: 0n, stopBlock: null, blockBatchSize: 2000, minBlockBatchSize: 10, confirmationBlocks: 5, rpcConcurrency: 2, rpcMaxRetries: 1, rpcRetryBaseDelayMs: 0 };
    const scanner = new Scanner(chain, store, new TokenValidator(new FakeContracts({ [ADDR.tokenA]: standardToken('A') }), retryOpts), cfg, { sleep: noSleep });
    expect(await scanner.processNextRange()).toMatchObject({ fromBlock: 0n, toBlock: 249n, transferLogs: 0 });
    expect(store.state.checkpoint).toBe(249n);
    expect(await scanner.processNextRange()).toMatchObject({ fromBlock: 250n, toBlock: 499n, transferLogs: 1 });
  });
});

describe('block timestamps & token validation', () => {
  it('fetches each block timestamp once, and not at all when logs carry blockTimestamp', async () => {
    const chain = new FakeChain();
    const cache = new BlockTimestampCache(chain, retryOpts, 4);
    const m = await cache.resolve([5n, 5n, 6n, 5n, 6n]);
    expect(m.get(5n)).toBe(1_700_000_005n);
    expect(chain.blockCalls.sort()).toEqual([5n, 6n]);
    await cache.resolve([5n, 6n]);
    expect(chain.blockCalls).toHaveLength(2);
    cache.seed(7n, 123n);
    expect((await cache.resolve([7n])).get(7n)).toBe(123n);
    expect(chain.blockCalls).toHaveLength(2);
  });

  it('end-to-end: only validated ERC-20s are stored; NFTs and non-tokens are ignored', async () => {
    const chain = new FakeChain();
    chain.head = 105n;
    const notToken = '0x4444444444444444444444444444444444444444';
    chain.logs = [
      transferLog({ token: ADDR.tokenA, from: ADDR.zero, to: ADDR.alice, amount: 100n, block: 1n, logIndex: 0, timestamp: null }),
      transferLog({ token: ADDR.tokenA, from: ADDR.alice, to: ADDR.bob, amount: 30n, block: 1n, logIndex: 1, timestamp: null }),
      transferLog({ token: ADDR.tokenA, from: ADDR.bob, to: ADDR.bob, amount: 5n, block: 2n, logIndex: 0, timestamp: null }),
      transferLog({ token: ADDR.tokenB, from: ADDR.zero, to: ADDR.carol, amount: 9n, block: 3n, logIndex: 0 }),
      transferLog({ token: notToken, from: ADDR.zero, to: ADDR.carol, amount: 9n, block: 3n, logIndex: 1 }),
    ];
    const contracts = new FakeContracts({
      [ADDR.tokenA]: standardToken('AAA', 100n),
      // bytes32 metadata (legacy) + reverting name: still a valid ERC-20
      [ADDR.tokenB]: { name: new Error('execution reverted'), symbol: '0x4242420000000000000000000000000000000000000000000000000000000000', decimals: 6, totalSupply: 9n },
      [notToken]: { name: 'X', symbol: 'X', totalSupply: 1n }, // decimals() reverts
    });
    const store = new MemoryStore();
    const cfg: ScannerConfig = { startBlock: 0n, stopBlock: null, blockBatchSize: 2000, minBlockBatchSize: 10, confirmationBlocks: 5, rpcConcurrency: 2, rpcMaxRetries: 1, rpcRetryBaseDelayMs: 0 };
    const scanner = new Scanner(chain, store, new TokenValidator(contracts, retryOpts), cfg, { sleep: noSleep });
    const r = await scanner.processNextRange();

    expect(r).toMatchObject({ status: 'processed', candidates: 3, rejectedCandidates: 1, newTokens: 2, transferLogs: 4, insertedTransfers: 4 });
    expect([...store.state.tokens.keys()].sort()).toEqual([ADDR.tokenA, ADDR.tokenB]);
    expect(store.state.tokens.get(ADDR.tokenB)).toMatchObject({ name: null, symbol: 'BBB', decimals: 6 });
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(70n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.bob)).toBe(30n); // self-transfer stored, balance untouched
    expect(store.state.transfers.size).toBe(4);
    expect(chain.blockCalls.sort()).toEqual([1n, 2n]); // one getBlock per block lacking a log timestamp
  });
});
