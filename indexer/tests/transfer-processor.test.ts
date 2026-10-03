import { describe, expect, it } from 'vitest';
import { decodeTransferLog, dedupeTransfers, normalizeAddress, normalizeTxHash } from '../src/transfer-processor.js';
import { ADDR, erc721Log, transferLog } from './helpers/fakes.js';

describe('3. address normalization', () => {
  it('lowercases checksummed addresses', () => {
    expect(normalizeAddress('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01')).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });
  it('rejects malformed addresses', () => {
    expect(() => normalizeAddress('0x1234')).toThrow(/invalid address/);
    expect(() => normalizeAddress('not-an-address')).toThrow();
  });
  it('lowercases and validates tx hashes', () => {
    const h = '0x' + 'AB'.repeat(32);
    expect(normalizeTxHash(h)).toBe('0x' + 'ab'.repeat(32));
    expect(() => normalizeTxHash('0x1234')).toThrow(/invalid tx hash/);
  });
});

describe('4. transfer decoding', () => {
  it('decodes a standard ERC-20 Transfer log', () => {
    const log = transferLog({ token: ADDR.tokenA.toUpperCase().replace('0X', '0x'), from: ADDR.alice, to: ADDR.bob, amount: 123456789n * 10n ** 18n, block: 42n, logIndex: 7, timestamp: 1_800_000_000n });
    const r = decodeTransferLog(log);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transfer).toEqual({
      tokenAddress: ADDR.tokenA,
      txHash: log.transactionHash,
      logIndex: 7,
      blockNumber: 42n,
      logTimestamp: 1_800_000_000n,
      from: ADDR.alice,
      to: ADDR.bob,
      amount: 123456789n * 10n ** 18n,
    });
  });

  it('handles uint256 max amounts without precision loss', () => {
    const max = 2n ** 256n - 1n;
    const r = decodeTransferLog(transferLog({ token: ADDR.tokenA, from: ADDR.alice, to: ADDR.bob, amount: max, block: 1n, logIndex: 0 }));
    expect(r.ok && r.transfer.amount).toBe(max);
  });

  it('rejects ERC-721 Transfer logs (4 topics, same signature)', () => {
    expect(decodeTransferLog(erc721Log(ADDR.nft, ADDR.alice, ADDR.bob, 5n, 1n, 0))).toEqual({ ok: false, reason: 'not-erc20-shape' });
  });

  it('rejects removed, pending and foreign-topic logs', () => {
    const base = transferLog({ token: ADDR.tokenA, from: ADDR.alice, to: ADDR.bob, amount: 1n, block: 1n, logIndex: 0 });
    expect(decodeTransferLog({ ...base, removed: true })).toEqual({ ok: false, reason: 'removed' });
    expect(decodeTransferLog({ ...base, blockNumber: null })).toEqual({ ok: false, reason: 'pending' });
    expect(decodeTransferLog({ ...base, topics: ['0x' + '00'.repeat(32), ...base.topics.slice(1)] })).toEqual({ ok: false, reason: 'wrong-topic' });
    expect(decodeTransferLog({ ...base, data: '0x' })).toEqual({ ok: false, reason: 'not-erc20-shape' });
  });

  it('returns null timestamp when the node omits blockTimestamp', () => {
    const r = decodeTransferLog(transferLog({ token: ADDR.tokenA, from: ADDR.alice, to: ADDR.bob, amount: 1n, block: 1n, logIndex: 0, timestamp: null }));
    expect(r.ok && r.transfer.logTimestamp).toBeNull();
  });

  it('dedupes by (txHash, logIndex) and sorts in chain order', () => {
    const a = { txHash: '0x01', logIndex: 1, blockNumber: 5n };
    const b = { txHash: '0x02', logIndex: 0, blockNumber: 3n };
    expect(dedupeTransfers([a, b, { ...a }])).toEqual([b, a]);
  });
});
