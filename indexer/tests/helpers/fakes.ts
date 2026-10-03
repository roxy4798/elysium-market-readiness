/**
 * Test-only fakes for chain access and contract reads, plus a log builder that produces
 * correctly ABI-encoded Transfer logs. Used only by unit tests; never by the real indexer.
 */
import { encodeAbiParameters, encodeEventTopics, pad, toHex, type Address, type Hex } from 'viem';
import { erc20Abi } from '../../src/abi/erc20.js';
import type { ChainReader } from '../../src/scanner.js';
import type { ContractReader } from '../../src/token-validator.js';
import type { RawLog } from '../../src/transfer-processor.js';

export const ADDR = {
  zero: '0x0000000000000000000000000000000000000000',
  tokenA: '0x1111111111111111111111111111111111111111',
  tokenB: '0x2222222222222222222222222222222222222222',
  nft: '0x3333333333333333333333333333333333333333',
  alice: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bob: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  carol: '0xcccccccccccccccccccccccccccccccccccccccc',
} as const;

let txCounter = 0;
export const txHash = (n = ++txCounter): string => pad(toHex(n), { size: 32 });

export interface LogSpec {
  token: string;
  from: string;
  to: string;
  amount: bigint;
  block: bigint;
  logIndex: number;
  tx?: string;
  timestamp?: bigint | null;
}

export function transferLog(s: LogSpec): RawLog {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { from: s.from as Address, to: s.to as Address },
  }) as Hex[];
  return {
    address: s.token,
    topics,
    data: encodeAbiParameters([{ type: 'uint256' }], [s.amount]),
    blockNumber: toHex(s.block),
    blockHash: pad(toHex(s.block), { size: 32 }),
    transactionHash: s.tx ?? txHash(),
    logIndex: toHex(s.logIndex),
    blockTimestamp: s.timestamp === null ? null : toHex(s.timestamp ?? 1_700_000_000n + s.block),
    removed: false,
  };
}

/** ERC-721 style Transfer: same signature, tokenId indexed => 4 topics, empty data. */
export function erc721Log(token: string, from: string, to: string, tokenId: bigint, block: bigint, logIndex: number): RawLog {
  const base = transferLog({ token, from, to, amount: 0n, block, logIndex });
  return { ...base, topics: [...base.topics, pad(toHex(tokenId), { size: 32 })], data: '0x' };
}

export class FakeChain implements ChainReader {
  logs: RawLog[] = [];
  head = 1000n;
  chainId = 99801;
  /** If set, getTransferLogs rejects ranges wider than this with a "range too large" error. */
  maxRange: number | null = null;
  /** Queue of errors to throw on the next getTransferLogs calls. */
  logErrors: Error[] = [];
  getLogsCalls: Array<[bigint, bigint]> = [];
  blockCalls: bigint[] = [];

  async getChainId(): Promise<number> {
    return this.chainId;
  }
  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }
  async getTransferLogs(from: bigint, to: bigint): Promise<RawLog[]> {
    this.getLogsCalls.push([from, to]);
    const e = this.logErrors.shift();
    if (e) throw e;
    if (this.maxRange !== null && Number(to - from + 1n) > this.maxRange) {
      throw new Error(`eth_getLogs block range ${to - from + 1n} exceeds maximum of ${this.maxRange}`);
    }
    return this.logs.filter((l) => {
      const b = BigInt(l.blockNumber ?? '0x0');
      return b >= from && b <= to;
    });
  }
  async getBlockTimestamp(n: bigint): Promise<bigint> {
    this.blockCalls.push(n);
    return 1_700_000_000n + n;
  }
}

export type FakeToken = { name?: unknown; symbol?: unknown; decimals?: unknown; totalSupply?: unknown } | 'no-code';

export const revert = (): Error => new Error('execution reverted');

export class FakeContracts implements ContractReader {
  constructor(public tokens: Record<string, FakeToken> = {}) {}
  calls = 0;
  async read(address: string, fn: 'name' | 'symbol' | 'decimals' | 'totalSupply', variant: 'string' | 'bytes32' = 'string'): Promise<unknown> {
    this.calls++;
    const t = this.tokens[address];
    if (t === undefined || t === 'no-code') {
      const e = new Error('returned no data ("0x")');
      e.name = 'ContractFunctionZeroDataError';
      throw e;
    }
    const v = t[fn];
    if (v === undefined || v instanceof Error) throw v instanceof Error ? v : revert();
    if ((fn === 'name' || fn === 'symbol') && variant === 'bytes32' && typeof v === 'string' && !v.startsWith('0x')) throw revert();
    if ((fn === 'name' || fn === 'symbol') && variant === 'string' && typeof v === 'string' && v.startsWith('0x')) {
      const e = new Error('Data size of 32 bytes is too small');
      e.name = 'AbiDecodingDataSizeTooSmallError';
      throw e;
    }
    return v;
  }
}

export const standardToken = (symbol: string, supply = 10n ** 24n): FakeToken => ({
  name: `${symbol} Token`,
  symbol,
  decimals: 18,
  totalSupply: supply,
});

export const noSleep = async (): Promise<void> => {};
