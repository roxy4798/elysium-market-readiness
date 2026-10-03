/**
 * Daily Raw Market Metrics Engine (Phase 2A).
 * Orchestrates deterministic daily calculations and idempotent PostgreSQL upserts.
 */
import type { Queryable } from '../database.js';
import { calculateActivityMetrics } from './activity-metrics.js';
import { calculateConcentration } from './concentration-metrics.js';
import { calculateHolderMetrics } from './holder-metrics.js';
import type { DailyMetrics, MetricTransfer, TokenInfo } from './types.js';

export * from './types.js';
export * from './activity-metrics.js';
export * from './holder-metrics.js';
export * from './concentration-metrics.js';

/**
 * Validates a YYYY-MM-DD date string strictly against UTC calendar rules.
 */
export function validateDateString(dateStr: string): { valid: boolean; normalized: string; error?: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) {
    return { valid: false, normalized: dateStr, error: `Invalid date format "${dateStr}". Expected YYYY-MM-DD.` };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    return { valid: false, normalized: dateStr, error: `Invalid month "${month}" in date "${dateStr}". Must be 01-12.` };
  }

  if (day < 1 || day > 31) {
    return { valid: false, normalized: dateStr, error: `Invalid day "${day}" in date "${dateStr}". Must be 01-31.` };
  }

  // Ensure calendar validity via UTC Date object
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return { valid: false, normalized: dateStr, error: `Date "${dateStr}" does not exist on the calendar.` };
  }

  const normalized = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  return { valid: true, normalized };
}

/**
 * Returns UTC [start, end] Date boundaries for a YYYY-MM-DD string.
 */
export function getUtcDayBounds(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(`${dateStr}T23:59:59.999Z`);
  return { start, end };
}

/**
 * Generates an array of daily ISO date strings between fromDate and toDate inclusive.
 */
export function generateDateSequence(fromDateStr: string, toDateStr: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${fromDateStr}T00:00:00.000Z`);
  const end = new Date(`${toDateStr}T00:00:00.000Z`);

  if (current.getTime() > end.getTime()) {
    throw new Error(`Start date "${fromDateStr}" cannot be after end date "${toDateStr}".`);
  }

  while (current.getTime() <= end.getTime()) {
    const y = current.getUTCFullYear();
    const m = (current.getUTCMonth() + 1).toString().padStart(2, '0');
    const d = current.getUTCDate().toString().padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

/**
 * Pure function: Computes all raw market metrics for a token given its transfers.
 */
export function computeDailyMetricsForTransfers(
  tokenAddress: string,
  dateStr: string,
  priorTransfers: readonly MetricTransfer[],
  dayTransfers: readonly MetricTransfer[],
): DailyMetrics {
  const activity = calculateActivityMetrics(dayTransfers);
  const holder = calculateHolderMetrics(priorTransfers, dayTransfers);
  const concentration = calculateConcentration(holder.positiveBalances);

  return {
    tokenAddress: tokenAddress.toLowerCase(),
    date: dateStr,
    holderCount: holder.holderCount,
    newHolders: holder.newHolders,
    activeHolders: activity.activeHolders,
    transferCount: activity.transferCount,
    uniqueSenders: activity.uniqueSenders,
    uniqueReceivers: activity.uniqueReceivers,
    top1Concentration: concentration.top1Concentration,
    top5Concentration: concentration.top5Concentration,
    top10Concentration: concentration.top10Concentration,
  };
}

/**
 * Loads all tracked tokens from the tokens table.
 */
export async function loadTokens(q: Queryable, filterAddress?: string): Promise<TokenInfo[]> {
  const text = filterAddress
    ? 'SELECT address, name, symbol, decimals FROM tokens WHERE address = LOWER($1) ORDER BY symbol ASC, address ASC'
    : 'SELECT address, name, symbol, decimals FROM tokens ORDER BY symbol ASC, address ASC';
  const values = filterAddress ? [filterAddress] : [];
  const res = await q.query<{ address: string; name: string | null; symbol: string | null; decimals: number | null }>(text, values);
  return res.rows;
}

/**
 * Fetches indexed transfer date range and checkpoint from the database.
 */
export async function getIndexedDataBounds(q: Queryable): Promise<{
  minDate: string | null;
  maxDate: string | null;
  transferCount: number;
  lastProcessedBlock: bigint | null;
}> {
  const transRes = await q.query<{ min_ts: string | null; max_ts: string | null; count: string }>(
    `SELECT
       MIN(block_timestamp)::text as min_ts,
       MAX(block_timestamp)::text as max_ts,
       COUNT(*)::text as count
     FROM transfers`,
  );
  const cpRes = await q.query<{ last_processed_block: string }>(
    'SELECT last_processed_block FROM indexer_state WHERE id = 1 LIMIT 1',
  );

  const row = transRes.rows[0];
  const minDate = row?.min_ts ? row.min_ts.slice(0, 10) : null;
  const maxDate = row?.max_ts ? row.max_ts.slice(0, 10) : null;
  const count = row?.count ? Number(row.count) : 0;
  const cp = cpRes.rows[0]?.last_processed_block ? BigInt(cpRes.rows[0].last_processed_block) : null;

  return {
    minDate,
    maxDate,
    transferCount: count,
    lastProcessedBlock: cp,
  };
}

/**
 * Loads all transfers for a token up to the specified end of day Date.
 */
export async function loadTransfersUpTo(
  q: Queryable,
  tokenAddress: string,
  endOfDayUtc: Date,
): Promise<MetricTransfer[]> {
  const res = await q.query<{
    from_address: string;
    to_address: string;
    amount: string;
    block_timestamp: Date;
    block_number: string;
    tx_hash: string;
    log_index: number;
  }>(
    `SELECT from_address, to_address, amount, block_timestamp, block_number, tx_hash, log_index
     FROM transfers
     WHERE token_address = LOWER($1)
       AND block_timestamp <= $2
     ORDER BY block_number ASC, log_index ASC`,
    [tokenAddress, endOfDayUtc],
  );

  return res.rows.map((r) => ({
    from: r.from_address,
    to: r.to_address,
    amount: BigInt(r.amount),
    blockTimestamp: r.block_timestamp instanceof Date ? r.block_timestamp : new Date(r.block_timestamp),
    blockNumber: BigInt(r.block_number),
    txHash: r.tx_hash,
    logIndex: r.log_index,
  }));
}

/**
 * Idempotently upserts daily metrics records into the daily_metrics table.
 * Uses ON CONFLICT (token_address, date) DO UPDATE to prevent duplicate rows.
 */
export async function upsertDailyMetrics(
  q: Queryable,
  records: readonly DailyMetrics[],
): Promise<number> {
  if (records.length === 0) return 0;

  let insertedCount = 0;
  for (const m of records) {
    await q.query(
      `INSERT INTO daily_metrics (
         token_address,
         date,
         holder_count,
         new_holders,
         active_holders,
         transfer_count,
         unique_senders,
         unique_receivers,
         top1_concentration,
         top5_concentration,
         top10_concentration,
         updated_at
       )
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (token_address, date) DO UPDATE SET
         holder_count = EXCLUDED.holder_count,
         new_holders = EXCLUDED.new_holders,
         active_holders = EXCLUDED.active_holders,
         transfer_count = EXCLUDED.transfer_count,
         unique_senders = EXCLUDED.unique_senders,
         unique_receivers = EXCLUDED.unique_receivers,
         top1_concentration = EXCLUDED.top1_concentration,
         top5_concentration = EXCLUDED.top5_concentration,
         top10_concentration = EXCLUDED.top10_concentration,
         updated_at = NOW()`,
      [
        m.tokenAddress,
        m.date,
        m.holderCount,
        m.newHolders,
        m.activeHolders,
        m.transferCount,
        m.uniqueSenders,
        m.uniqueReceivers,
        m.top1Concentration,
        m.top5Concentration,
        m.top10Concentration,
      ],
    );
    insertedCount++;
  }

  return insertedCount;
}

/**
 * Calculates and persists daily metrics for all tokens for the given dates.
 */
export async function calculateAndStoreDailyMetrics(
  q: Queryable,
  dates: readonly string[],
  tokenFilter?: string,
): Promise<DailyMetrics[]> {
  const tokens = await loadTokens(q, tokenFilter);
  const results: DailyMetrics[] = [];

  for (const dateStr of dates) {
    const { start: dayStart, end: dayEnd } = getUtcDayBounds(dateStr);

    for (const token of tokens) {
      const allTransfers = await loadTransfersUpTo(q, token.address, dayEnd);

      const priorTransfers: MetricTransfer[] = [];
      const dayTransfers: MetricTransfer[] = [];

      for (const t of allTransfers) {
        if (t.blockTimestamp.getTime() < dayStart.getTime()) {
          priorTransfers.push(t);
        } else if (t.blockTimestamp.getTime() <= dayEnd.getTime()) {
          dayTransfers.push(t);
        }
      }

      // If the token has no history whatsoever by the end of this day, skip or store zero metric row
      // We only store metrics if the token was first seen on or before this day's end
      if (allTransfers.length > 0) {
        const metric = computeDailyMetricsForTransfers(token.address, dateStr, priorTransfers, dayTransfers);
        results.push(metric);
      }
    }
  }

  if (results.length > 0) {
    await upsertDailyMetrics(q, results);
  }

  return results;
}
