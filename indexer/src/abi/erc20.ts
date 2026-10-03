/**
 * Standard ERC-20 ABI fragments used by the indexer.
 */
import { parseAbi, toEventSelector } from 'viem';

export const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

/** Fallback for legacy tokens (e.g. MKR-style) that return bytes32 for name/symbol. */
export const erc20Bytes32MetadataAbi = parseAbi([
  'function name() view returns (bytes32)',
  'function symbol() view returns (bytes32)',
]);

export const TRANSFER_EVENT_SIGNATURE = 'Transfer(address,address,uint256)';

/**
 * keccak256("Transfer(address,address,uint256)").
 * Computed from the signature (never hand-typed) and pinned in tests.
 * Canonical value: 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
 */
export const TRANSFER_TOPIC = toEventSelector(TRANSFER_EVENT_SIGNATURE);

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
