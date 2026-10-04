import { describe, expect, it } from 'vitest';
import { HistoricalBackfiller, Scanner, type ScannerConfig } from '../src/scanner.js';
import { TokenValidator } from '../src/token-validator.js';
import { commitRange, decodeTransferLog } from '../src/transfer-processor.js';
import type { StoredTransfer, TokenUpsert } from '../src/database.js';
import { ADDR, FakeChain, FakeContracts, noSleep, standardToken, transferLog, txHash } from './helpers/fakes.js';
import { MemoryStore } from './helpers/memory-store.js';

const token: TokenUpsert = {
  address: ADDR.tokenA, name: 'ELYS Test', symbol: 'ELYS', decimals: 18, totalSupply: 10_000n,
  firstSeenBlock: 10n, lastSeenBlock: 20n,
};
const cfg: ScannerConfig = {
  startBlock: 0n, stopBlock: null, blockBatchSize: 20, minBlockBatchSize: 2,
  confirmationBlocks: 5, rpcConcurrency: 2, rpcMaxRetries: 1, rpcRetryBaseDelayMs: 0,
};

function log(from: string, to: string, amount: bigint, block: bigint, logIndex: number, tx = txHash(), address: string = ADDR.tokenA) {
  return transferLog({ token: address, from, to, amount, block, logIndex, tx });
}

function stored(raw: ReturnType<typeof log>): StoredTransfer {
  const decoded = decodeTransferLog(raw);
  if (!decoded.ok || !raw.blockTimestamp) throw new Error('invalid test event');
  return {
    tokenAddress: decoded.transfer.tokenAddress,
    txHash: decoded.transfer.txHash,
    logIndex: decoded.transfer.logIndex,
    blockNumber: decoded.transfer.blockNumber,
    blockTimestamp: new Date(Number(BigInt(raw.blockTimestamp)) * 1000),
    from: decoded.transfer.from,
    to: decoded.transfer.to,
    amount: decoded.transfer.amount,
  };
}

function setup(logs: ReturnType<typeof log>[], address: string = ADDR.tokenA) {
  const chain = new FakeChain();
  chain.head = 100n;
  chain.logs = logs;
  const store = new MemoryStore();
  const contracts = new FakeContracts({ [address]: standardToken('ELYS', 10_000n) });
  const validator = new TokenValidator(contracts, { maxRetries: 1, baseDelayMs: 0, sleep: noSleep });
  return { chain, store, validator, contracts };
}

async function runBackfill(
  chain: FakeChain,
  store: MemoryStore,
  validator: TokenValidator,
  start = 10n,
  target = 20n,
) {
  return new HistoricalBackfiller(chain, store, validator, cfg, { sleep: noSleep }).run(ADDR.tokenA, start, target);
}

describe('historical token backfill and balance reconciliation', () => {
  it('replays real-shaped history into an empty transfer ledger without changing the global checkpoint', async () => {
    const mint = log(ADDR.zero, ADDR.alice, 25n, 10n, 0);
    const { chain, store, validator } = setup([mint]);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    const result = await runBackfill(chain, store, validator, 10n, 12n);
    expect(result.insertedTransfers).toBe(1);
    expect(store.state.transfers.size).toBe(1);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(25n);
    expect(store.state.checkpoint).toBe(9n);
  });

  it('repairs an ELYS-like partial history and reconciles eight existing duplicate events', async () => {
    const mint = log(ADDR.zero, ADDR.tokenA, 1000n, 10n, 0);
    const recipients = Array.from({ length: 8 }, (_, i) => `0x${(i + 100).toString(16).padStart(40, '0')}`);
    const outgoing = recipients.map((recipient, i) => log(ADDR.tokenA, recipient, 50n, BigInt(11 + i), 0));
    const self = log(recipients[0]!, recipients[0]!, 7n, 19n, 0);
    const burn = log(recipients[1]!, ADDR.zero, 5n, 19n, 1);
    const allLogs = [mint, ...outgoing, self, burn];
    const { chain, store, validator } = setup(allLogs);

    const partial = await commitRange(store, {
      fromBlock: 0n, toBlock: 20n, expectedPrevCheckpoint: null, tokens: [token], transfers: outgoing.map(stored),
    });
    expect(partial.anomalies).toHaveLength(8);
    expect(store.state.tokens.get(ADDR.tokenA)?.balanceAnomalies).toBe(8);
    expect(store.state.balances.size).toBe(0);
    const checkpointBefore = await store.getCheckpoint();

    const result = await runBackfill(chain, store, validator);
    expect(result.insertedTransfers).toBe(3); // creation mint, self-transfer, and burn
    expect(result.duplicateTransfers).toBe(8);
    expect(result.reconciliation.transferCount).toBe(11);
    expect(result.reconciliation.anomalyCount).toBe(0);
    expect(store.state.tokens.get(ADDR.tokenA)?.balanceAnomalies).toBe(0);
    expect(await store.getCheckpoint()).toBe(checkpointBefore);
    expect(store.state.transfers.size).toBe(11);
    expect(store.balanceOf(ADDR.tokenA, ADDR.zero)).toBeUndefined();
    expect(store.balanceOf(ADDR.tokenA, ADDR.tokenA)).toBe(600n);
    expect(store.balanceOf(ADDR.tokenA, recipients[0]!)).toBe(50n);
    expect(store.balanceOf(ADDR.tokenA, recipients[1]!)).toBe(45n);
  });

  it('applies mint, regular transfer, burn, and self-transfer semantics exactly once', async () => {
    const sameTx = txHash();
    const logs = [
      log(ADDR.zero, ADDR.alice, 100n, 10n, 0, sameTx),
      log(ADDR.alice, ADDR.bob, 30n, 10n, 1, sameTx),
      log(ADDR.bob, ADDR.bob, 8n, 10n, 2, sameTx),
      log(ADDR.bob, ADDR.zero, 10n, 11n, 0),
    ];
    const { chain, store, validator } = setup(logs);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    const result = await runBackfill(chain, store, validator);
    expect(result.reconciliation.transferCount).toBe(4);
    expect(result.reconciliation.anomalyCount).toBe(0);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(70n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.bob)).toBe(20n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.zero)).toBeUndefined();
  });

  it('verifies an existing unique-key row matches every RPC transfer field before accepting it', async () => {
    const original = log(ADDR.zero, ADDR.alice, 100n, 10n, 0);
    const conflicting = log(ADDR.zero, ADDR.alice, 101n, 10n, 0, original.transactionHash!);
    const { chain, store, validator } = setup([conflicting]);
    await commitRange(store, { fromBlock: 0n, toBlock: 20n, expectedPrevCheckpoint: null, tokens: [token], transfers: [stored(original)] });
    await expect(runBackfill(chain, store, validator)).rejects.toThrow(/conflicts with the canonical RPC event/);
    expect(store.state.transfers.size).toBe(1);
    expect(store.state.historicalBackfills.get(ADDR.tokenA)?.nextBlock).toBe(10n);
  });

  it('rolls back a failed historical range and resumes from the exact same cursor', async () => {
    const logs = [log(ADDR.zero, ADDR.alice, 100n, 10n, 0)];
    const { chain, store, validator } = setup(logs);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    store.failBackfillNext = 'afterTransferInsert';
    await expect(runBackfill(chain, store, validator, 10n, 10n)).rejects.toThrow(/simulated backfill transaction failure/);
    expect(store.state.transfers.size).toBe(0);
    expect(store.state.historicalBackfills.get(ADDR.tokenA)?.nextBlock).toBe(10n);
    const retried = await runBackfill(chain, store, validator, 10n, 10n);
    expect(retried.insertedTransfers).toBe(1);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(100n);
  });

  it('rolls back the atomic balance replacement if reconstruction fails and retries cleanly', async () => {
    const { chain, store, validator } = setup([log(ADDR.zero, ADDR.alice, 11n, 10n, 0)]);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    store.state.balances.set(`${ADDR.tokenA}:${ADDR.bob}`, { token: ADDR.tokenA, holder: ADDR.bob, balance: 3n, lastUpdatedBlock: 5n });
    store.failBackfillNext = 'duringRebuild';
    await expect(runBackfill(chain, store, validator, 10n, 10n)).rejects.toThrow(/simulated balance rebuild failure/);
    expect(store.balanceOf(ADDR.tokenA, ADDR.bob)).toBe(3n);
    expect(store.state.historicalBackfills.get(ADDR.tokenA)?.reconciledThroughBlock).toBeNull();
    await runBackfill(chain, store, validator, 10n, 10n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.bob)).toBeUndefined();
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(11n);
  });

  it('is idempotent when the same completed range is run again', async () => {
    const { chain, store, validator } = setup([log(ADDR.zero, ADDR.alice, 15n, 10n, 0)]);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    await runBackfill(chain, store, validator, 10n, 10n);
    const snapshot = JSON.stringify({
      transfers: [...store.state.transfers.keys()],
      balances: [...store.state.balances.entries()].map(([k, v]) => [k, v.balance.toString(), v.lastUpdatedBlock.toString()]),
      anomalies: store.state.tokens.get(ADDR.tokenA)?.balanceAnomalies,
      checkpoint: store.state.checkpoint?.toString(),
    });
    const again = await runBackfill(chain, store, validator, 10n, 10n);
    expect(again.ranges).toBe(0);
    expect(again.insertedTransfers).toBe(0);
    expect(JSON.stringify({
      transfers: [...store.state.transfers.keys()],
      balances: [...store.state.balances.entries()].map(([k, v]) => [k, v.balance.toString(), v.lastUpdatedBlock.toString()]),
      anomalies: store.state.tokens.get(ADDR.tokenA)?.balanceAnomalies,
      checkpoint: store.state.checkpoint?.toString(),
    })).toBe(snapshot);
  });

  it('records a balance anomaly instead of applying an impossible historical debit', async () => {
    const { chain, store, validator } = setup([log(ADDR.bob, ADDR.alice, 1n, 10n, 0)]);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    const result = await runBackfill(chain, store, validator, 10n, 10n);
    expect(result.reconciliation.anomalyCount).toBe(1);
    expect(store.state.tokens.get(ADDR.tokenA)?.balanceAnomalies).toBe(1);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBeUndefined();
  });

  it('keeps the global checkpoint unchanged and permits normal forward indexing afterward', async () => {
    const oldLogs = [log(ADDR.zero, ADDR.alice, 100n, 10n, 0)];
    const nextLog = log(ADDR.alice, ADDR.bob, 20n, 21n, 0);
    const { chain, store, validator, contracts } = setup([...oldLogs, nextLog]);
    await commitRange(store, { fromBlock: 0n, toBlock: 20n, expectedPrevCheckpoint: null, tokens: [token], transfers: oldLogs.map(stored) });
    const before = await store.getCheckpoint();
    await runBackfill(chain, store, validator, 10n, 20n);
    expect(await store.getCheckpoint()).toBe(before);

    chain.head = 26n; // five confirmations => block 21 is safe
    const forward = new Scanner(chain, store, new TokenValidator(contracts, { maxRetries: 1, baseDelayMs: 0, sleep: noSleep }), cfg, { sleep: noSleep });
    const range = await forward.processNextRange();
    expect(range).toMatchObject({ status: 'processed', fromBlock: 21n, toBlock: 21n, checkpoint: 21n });
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(80n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.bob)).toBe(20n);
  });

  it('filters replay requests to the selected token while preserving same-transaction log order', async () => {
    const sameTx = txHash();
    const targetMint = log(ADDR.zero, ADDR.alice, 20n, 10n, 0, sameTx);
    const otherTokenLog = log(ADDR.zero, ADDR.bob, 999n, 10n, 1, sameTx, ADDR.tokenB);
    const targetSend = log(ADDR.alice, ADDR.bob, 7n, 10n, 2, sameTx);
    const { chain, store, validator } = setup([targetMint, otherTokenLog, targetSend]);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    const result = await runBackfill(chain, store, validator, 10n, 10n);
    expect(result.reconciliation.transferCount).toBe(2);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(13n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.bob)).toBe(7n);
    expect(store.state.transfers.has(`${targetMint.transactionHash}:0`)).toBe(true);
  });

  it('does not debit or credit balances for a self-transfer', async () => {
    const events = [log(ADDR.zero, ADDR.alice, 40n, 10n, 0), log(ADDR.alice, ADDR.alice, 9n, 11n, 0)];
    const { chain, store, validator } = setup(events);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    await runBackfill(chain, store, validator, 10n, 11n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(40n);
  });

  it('excludes minted and burned amounts from the zero-address balance', async () => {
    const events = [log(ADDR.zero, ADDR.alice, 40n, 10n, 0), log(ADDR.alice, ADDR.zero, 12n, 11n, 0)];
    const { chain, store, validator } = setup(events);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    await runBackfill(chain, store, validator, 10n, 11n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(28n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.zero)).toBeUndefined();
  });

  it('extends an existing unfinished cursor when the requested target advances', async () => {
    const events = [log(ADDR.zero, ADDR.alice, 1n, 15n, 0)];
    const { chain, store, validator } = setup(events);
    await commitRange(store, { fromBlock: 0n, toBlock: 9n, expectedPrevCheckpoint: null, tokens: [token], transfers: [] });
    await store.prepareHistoricalBackfill(ADDR.tokenA, 10n, 12n);
    const result = await runBackfill(chain, store, validator, 10n, 15n);
    expect(result.reconciliation.reconciledThroughBlock).toBe(15n);
    expect(store.state.historicalBackfills.get(ADDR.tokenA)?.nextBlock).toBe(16n);
    expect(store.balanceOf(ADDR.tokenA, ADDR.alice)).toBe(1n);
  });

  it('rejects replay for a token that is not registered in the indexer database', async () => {
    const { chain, store, validator } = setup([]);
    await expect(new HistoricalBackfiller(chain, store, validator, cfg, { sleep: noSleep }).run(ADDR.tokenA, 10n, 12n))
      .rejects.toThrow(/not present in the indexed token table/);
  });
});
