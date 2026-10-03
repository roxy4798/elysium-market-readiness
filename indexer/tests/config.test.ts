import { describe, expect, it } from 'vitest';
import { ConfigError, ELYSIUM_TESTNET_CHAIN_ID, parseConfig, redactUrl } from '../src/config.js';
import { elysiumTestnet } from '../src/client.js';
import { TRANSFER_EVENT_SIGNATURE, TRANSFER_TOPIC } from '../src/abi/erc20.js';
import { keccak256, toBytes } from 'viem';

const base = { DATABASE_URL: 'postgresql://u:secret@localhost:5432/db' };

describe('1. chain configuration', () => {
  it('defaults to Elysium Testnet (99801) and spec defaults', () => {
    const c = parseConfig(base);
    expect(ELYSIUM_TESTNET_CHAIN_ID).toBe(99801);
    expect(c.chainId).toBe(99801);
    expect(c.rpcUrl).toBe('https://testnet-rpc.elysium.kinetiq.xyz');
    expect(c.blockBatchSize).toBe(2000);
    expect(c.confirmationBlocks).toBe(5);
    expect(c.startBlock).toBe(0n);
    expect(c.stopBlock).toBeNull();
    expect(c.logLevel).toBe('info');
  });

  it('rejects any other chain id', () => {
    expect(() => parseConfig({ ...base, CHAIN_ID: '1' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, CHAIN_ID: '998' })).toThrow(/99801/);
  });

  it('requires DATABASE_URL and validates numbers', () => {
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
    expect(() => parseConfig({ ...base, BLOCK_BATCH_SIZE: 'abc' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, BLOCK_BATCH_SIZE: '0' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, START_BLOCK: '-5' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, START_BLOCK: '100', STOP_BLOCK: '50' })).toThrow(ConfigError);
  });

  it('parses configurable batch size, start block and blank values', () => {
    const c = parseConfig({ ...base, BLOCK_BATCH_SIZE: '500', START_BLOCK: '1250000', STOP_BLOCK: '', CONFIRMATION_BLOCKS: '12' });
    expect(c.blockBatchSize).toBe(500);
    expect(c.startBlock).toBe(1_250_000n);
    expect(c.stopBlock).toBeNull();
    expect(c.confirmationBlocks).toBe(12);
    expect(c.minBlockBatchSize).toBeLessThanOrEqual(c.blockBatchSize);
  });

  it('builds a viem chain with HYPE native currency', () => {
    const chain = elysiumTestnet('https://testnet-rpc.elysium.kinetiq.xyz', 99801);
    expect(chain.id).toBe(99801);
    expect(chain.nativeCurrency.symbol).toBe('HYPE');
  });

  it('redacts database passwords in logs', () => {
    expect(redactUrl(base.DATABASE_URL)).toBe('postgresql://u:***@localhost:5432/db');
  });
});

describe('2. ERC-20 Transfer topic', () => {
  it('equals keccak256("Transfer(address,address,uint256)")', () => {
    expect(TRANSFER_EVENT_SIGNATURE).toBe('Transfer(address,address,uint256)');
    expect(TRANSFER_TOPIC).toBe(keccak256(toBytes('Transfer(address,address,uint256)')));
    expect(TRANSFER_TOPIC).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  });

  it('is NOT the mistyped literal from the project brief (…55a8df… instead of …55a4df…)', () => {
    // The brief's literal differs by one hex digit; using it would match zero logs on-chain.
    expect(TRANSFER_TOPIC).not.toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a8df523b3ef');
  });
});
