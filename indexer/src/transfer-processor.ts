/**
 * Transfer processing:
 *  1. Decode & normalize raw Transfer logs (strict ERC-20 shape).
 *  2. Commit one block range atomically: tokens -> transfers -> balances -> checkpoint.
 */
import { decodeEventLog, isAddress, type Hex } from 'viem';
import { TRANSFER_TOPIC, erc20Abi } from './abi/erc20.js';
import type { Store, StoredTransfer, TokenUpsert } from './database.js';
import { applyTransfers, balanceKeysFor, compareTransfers, type BalanceAnomaly } from './holder-engine.js';

/** Raw eth_getLogs entry (hex-encoded quantities, as returned by the node). */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string | null;
  readonly blockHash?: string | null;
  readonly transactionHash: string | null;
  readonly logIndex: string | null;
  readonly blockTimestamp?: string | null;
  readonly removed?: boolean;
}

export interface DecodedTransfer {
  readonly tokenAddress: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  /** Unix seconds if the node included `blockTimestamp` in the log, else null. */
  readonly logTimestamp: bigint | null;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const WORD_DATA_RE = /^0x[0-9a-fA-F]{64}$/;

/** Validate and lowercase an EVM address. Throws on malformed input. */
export function normalizeAddress(address: string): string {
  if (!isAddress(address, { strict: false })) throw new Error(`invalid address: ${address}`);
  return address.toLowerCase();
}

/** Validate and lowercase a 32-byte transaction hash. Throws on malformed input. */
export function normalizeTxHash(hash: string): string {
  if (!HASH_RE.test(hash)) throw new Error(`invalid tx hash: ${hash}`);
  return hash.toLowerCase();
}

export type DecodeSkipReason = 'removed' | 'pending' | 'wrong-topic' | 'not-erc20-shape' | 'undecodable';

/**
 * Decode a Transfer log as an ERC-20 transfer.
 * ERC-20: 3 topics (sig, from, to) + 32-byte data (value).
 * ERC-721 uses the same signature with 4 topics (tokenId indexed) and is rejected here.
 */
export function decodeTransferLog(log: RawLog): { ok: true; transfer: DecodedTransfer } | { ok: false; reason: DecodeSkipReason } {
  if (log.removed === true) return { ok: false, reason: 'removed' };
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    return { ok: false, reason: 'pending' };
  }
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return { ok: false, reason: 'wrong-topic' };
  if (log.topics.length !== 3 || !WORD_DATA_RE.test(log.data)) return { ok: false, reason: 'not-erc20-shape' };

  let args: { from: string; to: string; value: bigint };
  try {
    const decoded = decodeEventLog({
      abi: erc20Abi,
      eventName: 'Transfer',
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data as Hex,
      strict: true,
    });
    args = decoded.args;
  } catch {
    return { ok: false, reason: 'undecodable' };
  }

  return {
    ok: true,
    transfer: {
      tokenAddress: normalizeAddress(log.address),
      txHash: normalizeTxHash(log.transactionHash),
      logIndex: Number(BigInt(log.logIndex)),
      blockNumber: BigInt(log.blockNumber),
      logTimestamp: log.blockTimestamp ? BigInt(log.blockTimestamp) : null,
      from: normalizeAddress(args.from),
      to: normalizeAddress(args.to),
      amount: args.value,
    },
  };
}

/** Drop duplicate (txHash, logIndex) entries (defensive against a misbehaving RPC) and sort in chain order. */
export function dedupeTransfers<T extends { txHash: string; logIndex: number; blockNumber: bigint }>(items: readonly T[]): T[] {
  const m = new Map<string, T>();
  for (const t of items) m.set(`${t.txHash}:${t.logIndex}`, t);
  return [...m.values()].sort((a, b) =>
    a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex,
  );
}

// ---------------------------------------------------------------------------
// Atomic range commit
// ---------------------------------------------------------------------------

export interface RangeCommitInput {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /** Checkpoint value the range was planned from (fromBlock - 1), or null for the very first range. */
  readonly expectedPrevCheckpoint: bigint | null;
  readonly tokens: readonly TokenUpsert[];
  readonly transfers: readonly StoredTransfer[];
}

export interface RangeCommitResult {
  readonly newTokens: number;
  readonly insertedTransfers: number;
  readonly duplicateTransfers: number;
  readonly updatedHolders: number;
  readonly selfTransfers: number;
  readonly anomalies: readonly BalanceAnomaly[];
}

export async function commitRange(store: Store, input: RangeCommitInput): Promise<RangeCommitResult> {
  const { fromBlock, toBlock, expectedPrevCheckpoint } = input;
  if (toBlock < fromBlock) throw new Error(`invalid range ${fromBlock} -> ${toBlock}`);
  if (expectedPrevCheckpoint !== null && expectedPrevCheckpoint !== fromBlock - 1n) {
    throw new Error(`range ${fromBlock} does not follow checkpoint ${expectedPrevCheckpoint}`);
  }
  const tokenSet = new Set(input.tokens.map((t) => t.address));
  for (const t of input.transfers) {
    if (t.blockNumber < fromBlock || t.blockNumber > toBlock) {
      throw new Error(`transfer ${t.txHash}:${t.logIndex} at block ${t.blockNumber} outside range ${fromBlock}-${toBlock}`);
    }
    if (!tokenSet.has(t.tokenAddress)) throw new Error(`transfer for unregistered token ${t.tokenAddress}`);
  }
  const transfers = dedupeTransfers(input.transfers);

  return store.transaction(async (repo) => {
    const newTokens = input.tokens.length > 0 ? await repo.upsertTokens(input.tokens) : new Set<string>();

    // Only transfers that were genuinely inserted may mutate balances => idempotent re-processing.
    const inserted = transfers.length > 0 ? await repo.insertTransfers(transfers) : [];
    inserted.sort(compareTransfers);

    const current = await repo.loadBalances(balanceKeysFor(inserted));
    const result = applyTransfers(current, inserted);
    if (result.updates.length > 0) await repo.saveBalances(result.updates);

    if (result.anomalies.length > 0) {
      const counts = new Map<string, number>();
      for (const a of result.anomalies) counts.set(a.tokenAddress, (counts.get(a.tokenAddress) ?? 0) + 1);
      await repo.addBalanceAnomalies(counts);
    }

    // Last statement before COMMIT.
    await repo.writeCheckpoint(expectedPrevCheckpoint, toBlock);

    return {
      newTokens: newTokens.size,
      insertedTransfers: inserted.length,
      duplicateTransfers: transfers.length - inserted.length,
      updatedHolders: result.updates.length,
      selfTransfers: result.skippedSelfTransfers,
      anomalies: result.anomalies,
    };
  });
}
