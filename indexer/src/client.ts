/**
 * Elysium RPC client (viem) plus resilience primitives:
 * timeout, bounded retry with exponential backoff + jitter, and error classification.
 */
import {
  BaseError,
  HttpRequestError,
  LimitExceededRpcError,
  ResourceUnavailableRpcError,
  RpcRequestError,
  TimeoutError,
  createPublicClient,
  defineChain,
  http,
  type PublicClient,
} from 'viem';
import type { IndexerConfig } from './config.js';
import { logger } from './logger.js';

export function elysiumTestnet(rpcUrl: string, chainId: number) {
  return defineChain({
    id: chainId,
    name: 'Elysium Testnet',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });
}

/** viem public client. Built-in retries are disabled so that `withRetry` is the single, testable retry policy. */
export function createElysiumClient(config: Pick<IndexerConfig, 'rpcUrl' | 'chainId' | 'rpcTimeoutMs'>): PublicClient {
  return createPublicClient({
    chain: elysiumTestnet(config.rpcUrl, config.chainId),
    transport: http(config.rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: 0 }),
  });
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function messageOf(err: unknown): string {
  if (err instanceof BaseError) return `${err.shortMessage} ${err.details ?? ''} ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function causes(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; cur !== undefined && cur !== null && i < 10; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/** eth_getLogs rejected because the range / result set is too large. */
export function isRangeTooLargeError(err: unknown): boolean {
  const msg = messageOf(err).toLowerCase();
  return (
    /block range|range (is )?too (large|wide)|exceeds max|exceed(s|ed)? (the )?(max|limit)|too many (results|logs|blocks)|query returned more than|response size|result window|log response size/.test(
      msg,
    ) || causes(err).some((c) => c instanceof LimitExceededRpcError)
  );
}

/** Contract call reverted / returned undecodable data: a property of the contract, not of the network. */
export function isContractLogicError(err: unknown): boolean {
  const msg = messageOf(err).toLowerCase();
  if (msg.includes('execution reverted') || msg.includes('reverted')) return true;
  return causes(err).some((c) => {
    const name = (c as { name?: string }).name ?? '';
    return (
      name === 'ContractFunctionRevertedError' ||
      name === 'ContractFunctionZeroDataError' ||
      name.startsWith('AbiDecoding') ||
      name === 'PositionOutOfBoundsError' ||
      name === 'SliceOffsetOutOfBoundsError' ||
      name === 'InvalidBytesBooleanError' ||
      name === 'SizeExceedsPaddingSizeError' ||
      name === 'IntegerOutOfRangeError'
    );
  });
}

const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

/** Transient = worth retrying (network, timeout, rate limit, 5xx, temporary DB unavailability). */
export function isTransientError(err: unknown): boolean {
  if (isContractLogicError(err)) return false;
  for (const c of causes(err)) {
    if (c instanceof TimeoutError) return true;
    if (c instanceof LimitExceededRpcError || c instanceof ResourceUnavailableRpcError) return true;
    if (c instanceof HttpRequestError) {
      const s = c.status;
      return s === undefined || s === 408 || s === 425 || s === 429 || s >= 500;
    }
    if (c instanceof RpcRequestError) {
      // -32017: Conduit / provider rate limit
      // -32603 internal / -32000 generic server errors are typically temporary node issues.
      if (c.code === -32017 || c.code === -32603 || c.code === -32000 || c.code === -32005 || (c.code <= -32000 && c.code >= -32099)) return true;
    }
    const code = (c as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (TRANSIENT_NET_CODES.has(code)) return true;
      // PostgreSQL: 08xxx connection exceptions, 57P0x shutdown/cannot connect, 53xxx insufficient resources,
      // 40001 serialization failure, 40P01 deadlock.
      if (/^(08|53)/.test(code) || /^57P0/.test(code) || code === '40001' || code === '40P01') return true;
    }
    if (typeof code === 'number' && (code === -32017 || (code <= -32000 && code >= -32099) || code === -32603)) {
      return true;
    }
    const details = typeof (c as { details?: unknown }).details === 'string' ? (c as { details: string }).details : '';
    const shortMsg = typeof (c as { shortMessage?: unknown }).shortMessage === 'string' ? (c as { shortMessage: string }).shortMessage : '';
    const m = `${c instanceof Error ? c.message : ''} ${details} ${shortMsg}`.toLowerCase();
    if (/rate limit|too many requests|rpc request failed|fetch failed|socket hang up|network|timeout|timed out|connection terminated|econnrefused|econnreset/.test(m)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs?: number;
  readonly isRetryable?: (err: unknown) => boolean;
  readonly label?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  // +/-20% jitter to avoid thundering herd; never exceed maxDelayMs.
  return Math.min(maxDelayMs, Math.round(exp * (0.8 + Math.random() * 0.4)));
}

/** Run `fn`, retrying only retryable errors up to `maxRetries` extra attempts. Non-retryable errors throw immediately. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const isRetryable = opts.isRetryable ?? isTransientError;
  const doSleep = opts.sleep ?? sleep;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxRetries || !isRetryable(err)) throw err;
      const delay = backoffDelay(attempt, opts.baseDelayMs, maxDelay);
      if (opts.onRetry) opts.onRetry(attempt + 1, delay, err);
      else logger.warn(`retrying ${opts.label ?? 'operation'}`, { attempt: attempt + 1, of: opts.maxRetries, delayMs: delay, error: err });
      await doSleep(delay);
    }
  }
}
