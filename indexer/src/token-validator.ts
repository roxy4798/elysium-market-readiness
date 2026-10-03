/**
 * ERC-20 candidate validation.
 *
 * Any address emitting a 3-topic Transfer log is only a *candidate*. It becomes a token if:
 *   - decimals()    succeeds and returns an integer in [0, 255]
 *   - totalSupply() succeeds
 * name() and symbol() are called too but are OPTIONAL per EIP-20; failures or non-standard
 * encodings (e.g. bytes32) are tolerated and stored as best-effort / NULL.
 *
 * Contract-level failures (revert, no code, undecodable data) => candidate rejected.
 * Network-level failures (timeout, 5xx, rate limit) => thrown, so the whole block range is
 * retried later instead of silently dropping a token.
 */
import { hexToString, type Address, type PublicClient } from 'viem';
import { erc20Abi, erc20Bytes32MetadataAbi } from './abi/erc20.js';
import { isContractLogicError, withRetry, type RetryOptions } from './client.js';
import { logger } from './logger.js';

export interface TokenMetadata {
  readonly address: string;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly decimals: number;
  readonly totalSupply: bigint;
}

export type ValidationResult =
  | { readonly valid: true; readonly metadata: TokenMetadata }
  | { readonly valid: false; readonly address: string; readonly reason: string };

/** Minimal contract-read surface (implemented by viem in production, by fakes in tests). */
export interface ContractReader {
  read(address: string, fn: 'name' | 'symbol' | 'decimals' | 'totalSupply', abiVariant?: 'string' | 'bytes32'): Promise<unknown>;
}

export function viemContractReader(client: PublicClient): ContractReader {
  return {
    read(address, fn, abiVariant = 'string') {
      const abi = abiVariant === 'bytes32' && (fn === 'name' || fn === 'symbol') ? erc20Bytes32MetadataAbi : erc20Abi;
      return client.readContract({ address: address as Address, abi, functionName: fn } as Parameters<PublicClient['readContract']>[0]);
    },
  };
}

const MAX_TEXT = 256;

/** Remove NUL/control chars (PostgreSQL TEXT cannot store \u0000) and cap length. */
export function sanitizeText(s: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_TEXT);
  return cleaned === '' ? null : cleaned;
}

type FieldOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export class TokenValidator {
  private readonly rejected = new Map<string, string>();

  constructor(
    private readonly reader: ContractReader,
    private readonly retry: Omit<RetryOptions, 'label'>,
  ) {}

  /** Candidates already rejected during this process lifetime (avoids re-calling every batch). */
  isKnownInvalid(address: string): boolean {
    return this.rejected.has(address);
  }

  private async call<T>(address: string, fn: 'name' | 'symbol' | 'decimals' | 'totalSupply', variant?: 'string' | 'bytes32'): Promise<FieldOutcome<T>> {
    try {
      const value = await withRetry(() => this.reader.read(address, fn, variant), { ...this.retry, label: `${fn}() ${address}` });
      return { ok: true, value: value as T };
    } catch (err) {
      if (isContractLogicError(err)) {
        return { ok: false, reason: `${fn}() failed: ${(err as Error).name ?? 'Error'}` };
      }
      throw err; // transient / unknown => do not classify the contract; range is retried
    }
  }

  private async readText(address: string, fn: 'name' | 'symbol'): Promise<string | null> {
    const asString = await this.call<unknown>(address, fn, 'string');
    if (asString.ok && typeof asString.value === 'string') return sanitizeText(asString.value);
    const asBytes = await this.call<unknown>(address, fn, 'bytes32');
    if (asBytes.ok && typeof asBytes.value === 'string') {
      try {
        return sanitizeText(hexToString(asBytes.value as `0x${string}`, { size: 32 }));
      } catch {
        return null;
      }
    }
    return null;
  }

  async validate(address: string): Promise<ValidationResult> {
    const cached = this.rejected.get(address);
    if (cached !== undefined) return { valid: false, address, reason: cached };

    const [decimals, totalSupply] = await Promise.all([
      this.call<unknown>(address, 'decimals'),
      this.call<unknown>(address, 'totalSupply'),
    ]);

    let reason: string | null = null;
    if (!decimals.ok) reason = decimals.reason;
    else if (!totalSupply.ok) reason = totalSupply.reason;
    else {
      const d = Number(decimals.value);
      if (!Number.isInteger(d) || d < 0 || d > 255) reason = `decimals() out of range: ${String(decimals.value)}`;
      else if (typeof totalSupply.value !== 'bigint' || totalSupply.value < 0n) reason = 'totalSupply() not a uint256';
    }
    if (reason !== null || !decimals.ok || !totalSupply.ok) {
      const r = reason ?? 'invalid';
      this.rejected.set(address, r);
      logger.debug('candidate rejected', { address, reason: r });
      return { valid: false, address, reason: r };
    }

    const [name, symbol] = await Promise.all([this.readText(address, 'name'), this.readText(address, 'symbol')]);
    return {
      valid: true,
      metadata: { address, name, symbol, decimals: Number(decimals.value), totalSupply: totalSupply.value as bigint },
    };
  }

  /** Best-effort refresh of totalSupply for an already registered token. Never throws. */
  async refreshTotalSupply(address: string): Promise<bigint | null> {
    try {
      const out = await this.call<unknown>(address, 'totalSupply');
      return out.ok && typeof out.value === 'bigint' ? out.value : null;
    } catch (err) {
      logger.debug('totalSupply refresh failed; keeping previous value', { address, error: err });
      return null;
    }
  }
}
