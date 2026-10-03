/**
 * Activity metrics for a specific date:
 * - transfer_count: Number of valid Transfer events stored for the token on the date.
 * - unique_senders: Unique non-zero from_address values.
 * - unique_receivers: Unique non-zero to_address values.
 * - active_holders: Unique non-zero addresses in unique(from_address) UNION unique(to_address).
 */
import { ZERO_ADDRESS, type ActivityMetrics, type MetricTransfer } from './types.js';

export function calculateActivityMetrics(transfersOnDay: readonly MetricTransfer[]): ActivityMetrics {
  let transferCount = 0;
  const senders = new Set<string>();
  const receivers = new Set<string>();
  const active = new Set<string>();

  for (const t of transfersOnDay) {
    transferCount++;
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();

    if (from !== ZERO_ADDRESS) {
      senders.add(from);
      active.add(from);
    }

    if (to !== ZERO_ADDRESS) {
      receivers.add(to);
      active.add(to);
    }
  }

  return {
    transferCount,
    uniqueSenders: senders.size,
    uniqueReceivers: receivers.size,
    activeHolders: active.size,
  };
}
