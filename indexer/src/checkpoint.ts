/**
 * Indexing checkpoint.
 *
 * The checkpoint (`indexer_state.last_processed_block`, id = 1) is written in the SAME
 * database transaction as the transfers / balances of the range it covers, as the last
 * statement before COMMIT. It can therefore never advance ahead of committed data.
 *
 * Writes are compare-and-set: the update only succeeds if the stored checkpoint still
 * equals the value the range was planned from. This prevents gaps, double-processing and
 * concurrent indexers clobbering each other.
 */
import type { Queryable } from './database.js';

export const CHECKPOINT_ID = 1;

export class CheckpointConflictError extends Error {
  override readonly name = 'CheckpointConflictError';
}

export async function readCheckpoint(q: Queryable): Promise<bigint | null> {
  const res = await q.query<{ last_processed_block: string }>(
    'SELECT last_processed_block FROM indexer_state WHERE id = $1',
    [CHECKPOINT_ID],
  );
  const row = res.rows[0];
  return row ? BigInt(row.last_processed_block) : null;
}

export async function writeCheckpoint(q: Queryable, expectedPrev: bigint | null, next: bigint): Promise<void> {
  assertMonotonic(expectedPrev, next);
  const res =
    expectedPrev === null
      ? await q.query(
          `INSERT INTO indexer_state (id, last_processed_block, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [CHECKPOINT_ID, next.toString()],
        )
      : await q.query(
          `UPDATE indexer_state SET last_processed_block = $3, updated_at = NOW()
           WHERE id = $1 AND last_processed_block = $2`,
          [CHECKPOINT_ID, expectedPrev.toString(), next.toString()],
        );
  if (res.rowCount !== 1) {
    throw new CheckpointConflictError(
      `checkpoint changed concurrently (expected ${expectedPrev ?? 'none'}, writing ${next}); range will be re-planned`,
    );
  }
}

export function assertMonotonic(expectedPrev: bigint | null, next: bigint): void {
  if (next < 0n) throw new CheckpointConflictError(`invalid checkpoint ${next}`);
  if (expectedPrev !== null && next <= expectedPrev) {
    throw new CheckpointConflictError(`checkpoint must advance: ${expectedPrev} -> ${next}`);
  }
}

/** Resume rule: next block = checkpoint + 1, or START_BLOCK when no checkpoint exists. */
export function nextBlockToProcess(checkpoint: bigint | null, startBlock: bigint): bigint {
  return checkpoint === null ? startBlock : checkpoint + 1n;
}

/** Highest block considered final enough to index; null if the chain is shorter than the confirmation depth. */
export function safeTargetBlock(latest: bigint, confirmations: number, stopBlock: bigint | null): bigint | null {
  const safe = latest - BigInt(confirmations);
  if (safe < 0n) return null;
  return stopBlock !== null && stopBlock < safe ? stopBlock : safe;
}
