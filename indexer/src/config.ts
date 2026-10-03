/**
 * Configuration loading and validation.
 * All settings come from environment variables (optionally from a local .env).
 * No secrets are hard-coded.
 */
import { existsSync } from 'node:fs';

/** Elysium Testnet chain id. The indexer refuses to run against any other chain. */
export const ELYSIUM_TESTNET_CHAIN_ID = 99801;
export const ELYSIUM_TESTNET_DEFAULT_RPC = 'https://testnet-rpc.elysium.kinetiq.xyz';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface IndexerConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly databaseUrl: string;
  /** First block when no checkpoint exists. */
  readonly startBlock: bigint;
  /** Optional upper bound; the indexer stops after committing this block. */
  readonly stopBlock: bigint | null;
  readonly blockBatchSize: number;
  readonly minBlockBatchSize: number;
  readonly confirmationBlocks: number;
  readonly logLevel: LogLevel;
  readonly rpcTimeoutMs: number;
  readonly rpcMaxRetries: number;
  readonly rpcRetryBaseDelayMs: number;
  readonly rpcConcurrency: number;
  readonly pollIntervalMs: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

function str(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function int(env: Env, key: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = str(env, key);
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be a non-negative integer, got "${raw}"`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${key} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function block(env: Env, key: string): bigint | null {
  const raw = str(env, key);
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be a non-negative integer block number, got "${raw}"`);
  return BigInt(raw);
}

/** Parse and validate configuration from an env-like object. Pure; used by tests. */
export function parseConfig(env: Env): IndexerConfig {
  const rpcUrl = str(env, 'RPC_URL') ?? ELYSIUM_TESTNET_DEFAULT_RPC;
  if (!/^https?:\/\//i.test(rpcUrl)) throw new ConfigError(`RPC_URL must be an http(s) URL`);

  const chainId = int(env, 'CHAIN_ID', ELYSIUM_TESTNET_CHAIN_ID, 1);
  if (chainId !== ELYSIUM_TESTNET_CHAIN_ID) {
    throw new ConfigError(`CHAIN_ID must be ${ELYSIUM_TESTNET_CHAIN_ID} (Elysium Testnet), got ${chainId}`);
  }

  const databaseUrl = str(env, 'DATABASE_URL');
  if (databaseUrl === undefined) throw new ConfigError('DATABASE_URL is required');
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) throw new ConfigError('DATABASE_URL must be a postgresql:// URL');

  const startBlock = block(env, 'START_BLOCK') ?? 0n;
  const stopBlock = block(env, 'STOP_BLOCK');
  if (stopBlock !== null && stopBlock < startBlock) {
    throw new ConfigError(`STOP_BLOCK (${stopBlock}) must be >= START_BLOCK (${startBlock})`);
  }

  const blockBatchSize = int(env, 'BLOCK_BATCH_SIZE', 2000, 1, 1_000_000);
  const minBlockBatchSize = Math.min(int(env, 'MIN_BLOCK_BATCH_SIZE', 10, 1, 1_000_000), blockBatchSize);

  const logLevelRaw = (str(env, 'LOG_LEVEL') ?? 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevelRaw)) {
    throw new ConfigError(`LOG_LEVEL must be one of debug|info|warn|error, got "${logLevelRaw}"`);
  }

  return {
    rpcUrl,
    chainId,
    databaseUrl,
    startBlock,
    stopBlock,
    blockBatchSize,
    minBlockBatchSize,
    confirmationBlocks: int(env, 'CONFIRMATION_BLOCKS', 5, 0, 10_000),
    logLevel: logLevelRaw as LogLevel,
    rpcTimeoutMs: int(env, 'RPC_TIMEOUT_MS', 20_000, 100),
    rpcMaxRetries: int(env, 'RPC_MAX_RETRIES', 5, 0, 100),
    rpcRetryBaseDelayMs: int(env, 'RPC_RETRY_BASE_DELAY_MS', 500, 0),
    rpcConcurrency: int(env, 'RPC_CONCURRENCY', 8, 1, 256),
    pollIntervalMs: int(env, 'POLL_INTERVAL_MS', 5000, 100),
  };
}

/** Load .env (if present, without overriding real env vars) and parse config. */
export function loadConfig(envFile = '.env'): IndexerConfig {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return parseConfig(process.env);
}

/** Database URL with the password masked, for logging. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@');
}
