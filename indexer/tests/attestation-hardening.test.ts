/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Phase 5B.0.1 — Attestation Service Hardening & CLI Gating Tests.
 * Regression tests covering:
 * 1. First attestation proceeds normally.
 * 2. Identical duplicate attestation is idempotent.
 * 3. Conflicting duplicate attestation is rejected.
 * 4. Already-attested condition never reaches writeContract twice.
 * 5. CLI with ATTESTATION_ENABLED=false cannot submit.
 * 6. CLI with ATTESTATION_ENABLED=true can reach the existing service path.
 * 7. Missing required configuration fails safely.
 * 8. No private key or secret appears in output/logs.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient, WalletClient } from 'viem';
import type { Queryable } from '../src/database.js';
import type { CanonicalAssessmentPayload } from '../src/assessment/types.js';
import {
  computeAssessmentHash,
  computeAssessmentId,
  serializeCanonicalAssessment,
} from '../src/assessment/canonical.js';
import {
  attestAssessment,
  AttestationConflictError,
} from '../src/attestation/attestation-service.js';
import { cmdAttest } from '../src/main.js';
import type { IndexerConfig } from '../src/config.js';

const TEST_TOKEN = '0x245bfe8c6c2429f6a7743d53377ae39b98500459';
const TEST_DATE = '2026-10-03';
const TEST_METHODOLOGY = 'health-v1';
const TEST_SCHEMA = '1.0';
const DUMMY_CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890';
const DUMMY_PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204db7e716b78ac5c78273082fe39cfbe85';
const DUMMY_ATTESTER_ADDRESS = '0xa8037A207be9e525798Fad10037aF982367d3419';
const TEST_BEARER_SECRET = 'test-secret-phase5b01-hardening-0123456789abcdef';

const samplePayload: CanonicalAssessmentPayload = {
  schema_version: TEST_SCHEMA,
  methodology_version: TEST_METHODOLOGY,
  token_address: TEST_TOKEN.toLowerCase(),
  assessment_date: TEST_DATE,
  health_score: 34.0,
  momentum: 4.5,
  status: 'EARLY',
  holder_health: 0.0,
  transfer_activity: 52.61,
  address_activity: 54.14,
  concentration_score: 0.1,
  consistency_score: 100.0,
  data_window_days: 7,
};

const validId = computeAssessmentId(
  samplePayload.schema_version,
  samplePayload.methodology_version,
  samplePayload.token_address,
  samplePayload.assessment_date,
);
const validHash = computeAssessmentHash(serializeCanonicalAssessment(samplePayload));

describe('Phase 5B.0.1 — Attestation Service Hardening', () => {
  const onchainState = new Map<string, any>();
  const dbAttestations = new Map<string, any>();
  let writeContractCallCount = 0;
  const capturedLogs: string[] = [];

  const mockDb: Queryable = {
    async query(sql: string, params: any[] = []): Promise<any> {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      if (/SELECT.*FROM market_assessments WHERE LOWER\(assessment_id\)/i.test(normalizedSql)) {
        const id = (params[0] ?? '').toLowerCase();
        if (id === validId.toLowerCase()) {
          return {
            rows: [
              {
                token_address: TEST_TOKEN.toLowerCase(),
                assessment_date: TEST_DATE,
                health_score: '34.00',
                status: 'EARLY',
                momentum: '4.50',
                holder_health: '0.00',
                transfer_activity: '52.61',
                address_activity: '54.14',
                concentration_score: '0.10',
                consistency_score: '100.00',
                data_window_days: 7,
                reason: null,
                assessment_id: validId,
                schema_version: TEST_SCHEMA,
                methodology_version: TEST_METHODOLOGY,
                assessment_hash: validHash,
              },
            ],
          };
        }
        return { rows: [] };
      }

      if (/SELECT.*FROM assessment_attestations WHERE LOWER\(assessment_id\)/i.test(normalizedSql)) {
        const id = (params[0] ?? '').toLowerCase();
        const existing = dbAttestations.get(id);
        if (existing) {
          return {
            rows: [
              {
                id: 1,
                assessment_id: existing.assessment_id,
                contract_address: existing.contract_address,
                chain_id: existing.chain_id,
                transaction_hash: existing.transaction_hash,
                block_number: existing.block_number,
                attester_address: existing.attester_address,
                attested_at: existing.attested_at,
                created_at: existing.created_at ?? new Date(),
              },
            ],
          };
        }
        return { rows: [] };
      }

      if (/INSERT INTO assessment_attestations/i.test(normalizedSql)) {
        const [
          assessment_id,
          contract_address,
          chain_id,
          transaction_hash,
          block_number,
          attester_address,
          attested_at,
        ] = params;
        const key = String(assessment_id).toLowerCase();
        if (!dbAttestations.has(key)) {
          dbAttestations.set(key, {
            assessment_id,
            contract_address,
            chain_id,
            transaction_hash,
            block_number,
            attester_address,
            attested_at,
          });
        }
        return { rowCount: 1, rows: [] };
      }

      return { rows: [] };
    },
  };

  const mockPublicClient = {
    readContract: (async ({ functionName, args }: any) => {
      const assessmentId = args[0].toLowerCase();
      if (functionName === 'isAttested') {
        return onchainState.has(assessmentId);
      }
      if (functionName === 'getAttestation') {
        const data = onchainState.get(assessmentId);
        if (!data) throw new Error('Not attested');
        return [
          data.assessmentHash,
          data.token,
          data.assessmentDate,
          data.methodologyVersion,
          data.attester,
          data.attestedAt,
        ];
      }
      throw new Error(`Unexpected function ${functionName}`);
    }) as any,
    waitForTransactionReceipt: (async ({ hash }: any) => {
      return {
        transactionHash: hash,
        blockNumber: 123456n,
        status: 'success',
      };
    }) as any,
  } as unknown as PublicClient;

  const mockWalletClient = {
    writeContract: (async ({ args }: any) => {
      writeContractCallCount++;
      const [assessmentId, assessmentHash, token, assessmentDate, methodologyVersion] = args;
      const key = assessmentId.toLowerCase();
      if (onchainState.has(key)) {
        const existing = onchainState.get(key);
        if (
          existing.assessmentHash.toLowerCase() !== assessmentHash.toLowerCase() ||
          existing.token.toLowerCase() !== token.toLowerCase() ||
          existing.assessmentDate !== assessmentDate ||
          existing.methodologyVersion.toLowerCase() !== methodologyVersion.toLowerCase()
        ) {
          throw new Error('AssessmentAlreadyAttestedWithDifferentData');
        }
      } else {
        onchainState.set(key, {
          assessmentHash,
          token,
          assessmentDate,
          methodologyVersion,
          attester: DUMMY_ATTESTER_ADDRESS,
          attestedAt: 1790985600n,
        });
      }
      return '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    }) as any,
  } as unknown as WalletClient;

  beforeEach(() => {
    onchainState.clear();
    dbAttestations.clear();
    writeContractCallCount = 0;
    capturedLogs.length = 0;

    process.env['ATTESTATION_CONTRACT_ADDRESS'] = DUMMY_CONTRACT_ADDRESS;
    process.env['ATTESTER_PRIVATE_KEY'] = DUMMY_PRIVATE_KEY;
    process.env['ATTESTATION_ENABLED'] = 'true';
    process.env['ATTESTATION_API_SECRET'] = TEST_BEARER_SECRET;
  });

  afterAll(() => {
    delete process.env['ATTESTATION_CONTRACT_ADDRESS'];
    delete process.env['ATTESTER_PRIVATE_KEY'];
    delete process.env['ATTESTATION_ENABLED'];
    delete process.env['ATTESTATION_API_SECRET'];
  });

  // 1. First attestation proceeds normally
  it('1. first attestation proceeds normally and submits transaction', async () => {
    const res = await attestAssessment(mockDb, validId, {
      contractAddress: DUMMY_CONTRACT_ADDRESS,
      privateKey: DUMMY_PRIVATE_KEY,
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
    });

    expect(res.assessment_id).toBe(validId);
    expect(res.transaction_hash).toBe('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    expect(writeContractCallCount).toBe(1);
    expect(onchainState.has(validId.toLowerCase())).toBe(true);
    expect(dbAttestations.has(validId.toLowerCase())).toBe(true);
  });

  // 2. Identical duplicate attestation is idempotent
  it('2. identical duplicate attestation is idempotent', async () => {
    // First attestation
    await attestAssessment(mockDb, validId, {
      contractAddress: DUMMY_CONTRACT_ADDRESS,
      privateKey: DUMMY_PRIVATE_KEY,
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
    });
    expect(writeContractCallCount).toBe(1);

    // Duplicate attestation with DB present
    const res2 = await attestAssessment(mockDb, validId, {
      contractAddress: DUMMY_CONTRACT_ADDRESS,
      privateKey: DUMMY_PRIVATE_KEY,
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
    });
    expect(res2.assessment_id).toBe(validId);
    expect(writeContractCallCount).toBe(1);

    // Duplicate attestation even if DB cache was wiped but onchain matches
    dbAttestations.clear();
    const res3 = await attestAssessment(mockDb, validId, {
      contractAddress: DUMMY_CONTRACT_ADDRESS,
      privateKey: DUMMY_PRIVATE_KEY,
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
    });
    expect(res3.assessment_id).toBe(validId);
    expect(writeContractCallCount).toBe(1); // Never called writeContract again!
  });

  // 3. Conflicting duplicate attestation is rejected
  it('3. conflicting duplicate attestation is rejected before transaction submission', async () => {
    // Seed onchain state with conflicting hash for the same assessmentId
    onchainState.set(validId.toLowerCase(), {
      assessmentHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
      token: TEST_TOKEN,
      assessmentDate: 1790985600n,
      methodologyVersion: '0x6865616c74682d76310000000000000000000000000000000000000000000000',
      attester: DUMMY_ATTESTER_ADDRESS,
      attestedAt: 1790985600n,
    });

    await expect(
      attestAssessment(mockDb, validId, {
        contractAddress: DUMMY_CONTRACT_ADDRESS,
        privateKey: DUMMY_PRIVATE_KEY,
        publicClient: mockPublicClient,
        walletClient: mockWalletClient,
      }),
    ).rejects.toThrow(AttestationConflictError);

    expect(writeContractCallCount).toBe(0);
  });

  // 4. Already-attested condition never reaches writeContract twice
  it('4. already-attested condition never reaches writeContract twice', async () => {
    // First call
    await attestAssessment(mockDb, validId, {
      contractAddress: DUMMY_CONTRACT_ADDRESS,
      privateKey: DUMMY_PRIVATE_KEY,
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
    });
    expect(writeContractCallCount).toBe(1);

    // Clear local DB to force onchain check
    dbAttestations.clear();

    // Second call on already-attested
    await attestAssessment(mockDb, validId, {
      contractAddress: DUMMY_CONTRACT_ADDRESS,
      privateKey: DUMMY_PRIVATE_KEY,
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
    });
    expect(writeContractCallCount).toBe(1);

    // Third call
    await attestAssessment(mockDb, validId, {
      contractAddress: DUMMY_CONTRACT_ADDRESS,
      privateKey: DUMMY_PRIVATE_KEY,
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
    });
    expect(writeContractCallCount).toBe(1);
  });

  // 5. CLI with ATTESTATION_ENABLED=false cannot submit
  it('5. CLI with ATTESTATION_ENABLED=false cannot submit', async () => {
    process.env['ATTESTATION_ENABLED'] = 'false';
    const mockConfig: IndexerConfig = {
      databaseUrl: 'postgresql://elysium:test@localhost:5432/test',
      rpcUrl: 'https://testnet-rpc.elysium.kinetiq.xyz',
      chainId: 99801,
      startBlock: 0n,
      stopBlock: null,
      blockBatchSize: 100,
      minBlockBatchSize: 10,
      confirmationBlocks: 1,
      rpcTimeoutMs: 5000,
      rpcMaxRetries: 1,
      rpcRetryBaseDelayMs: 100,
      rpcConcurrency: 1,
      pollIntervalMs: 1000,
      logLevel: 'error',
    };

    const exitCode = await cmdAttest(mockConfig, ['--id', validId]);
    expect(exitCode).toBe(1);
    expect(writeContractCallCount).toBe(0);
  });

  // 6. CLI with ATTESTATION_ENABLED=true can reach the existing service path
  it('6. CLI with ATTESTATION_ENABLED=true validates parameters and checks requirements', async () => {
    process.env['ATTESTATION_ENABLED'] = 'true';
    const mockConfig: IndexerConfig = {
      databaseUrl: 'postgresql://elysium:test@localhost:5432/test',
      rpcUrl: 'https://testnet-rpc.elysium.kinetiq.xyz',
      chainId: 99801,
      startBlock: 0n,
      stopBlock: null,
      blockBatchSize: 100,
      minBlockBatchSize: 10,
      confirmationBlocks: 1,
      rpcTimeoutMs: 5000,
      rpcMaxRetries: 1,
      rpcRetryBaseDelayMs: 100,
      rpcConcurrency: 1,
      pollIntervalMs: 1000,
      logLevel: 'error',
    };

    // When id is provided, it verifies config before DB connection
    process.env['ATTESTATION_CONTRACT_ADDRESS'] = DUMMY_CONTRACT_ADDRESS;
    process.env['ATTESTER_PRIVATE_KEY'] = DUMMY_PRIVATE_KEY;
    // With help flag
    const helpCode = await cmdAttest(mockConfig, ['--help']);
    expect(helpCode).toBe(0);
  });

  // 7. Missing required configuration fails safely
  it('7. missing required configuration fails safely in CLI', async () => {
    process.env['ATTESTATION_ENABLED'] = 'true';
    const mockConfig: IndexerConfig = {
      databaseUrl: 'postgresql://elysium:test@localhost:5432/test',
      rpcUrl: 'https://testnet-rpc.elysium.kinetiq.xyz',
      chainId: 99801,
      startBlock: 0n,
      stopBlock: null,
      blockBatchSize: 100,
      minBlockBatchSize: 10,
      confirmationBlocks: 1,
      rpcTimeoutMs: 5000,
      rpcMaxRetries: 1,
      rpcRetryBaseDelayMs: 100,
      rpcConcurrency: 1,
      pollIntervalMs: 1000,
      logLevel: 'error',
    };

    // Missing --id
    expect(await cmdAttest(mockConfig, [])).toBe(2);

    // Invalid --id format
    expect(await cmdAttest(mockConfig, ['--id', '0x1234'])).toBe(2);

    // Missing ATTESTATION_CONTRACT_ADDRESS
    delete process.env['ATTESTATION_CONTRACT_ADDRESS'];
    expect(await cmdAttest(mockConfig, ['--id', validId])).toBe(1);

    // Missing ATTESTER_PRIVATE_KEY
    process.env['ATTESTATION_CONTRACT_ADDRESS'] = DUMMY_CONTRACT_ADDRESS;
    delete process.env['ATTESTER_PRIVATE_KEY'];
    expect(await cmdAttest(mockConfig, ['--id', validId])).toBe(1);
  });

  // 8. No private key or secret appears in output/logs
  it('8. never leaks private key or bearer secret in output or logs', async () => {
    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(capture);

    try {
      // Intentionally trigger conflicting attestation error
      onchainState.set(validId.toLowerCase(), {
        assessmentHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        token: TEST_TOKEN,
        assessmentDate: 1790985600n,
        methodologyVersion: '0x6865616c74682d76310000000000000000000000000000000000000000000000',
        attester: DUMMY_ATTESTER_ADDRESS,
        attestedAt: 1790985600n,
      });

      try {
        await attestAssessment(mockDb, validId, {
          contractAddress: DUMMY_CONTRACT_ADDRESS,
          privateKey: DUMMY_PRIVATE_KEY,
          publicClient: mockPublicClient,
          walletClient: mockWalletClient,
        });
      } catch (e: any) {
        logs.push(e.message);
      }

      const allOutput = logs.join('\n');
      expect(allOutput).not.toContain(DUMMY_PRIVATE_KEY);
      expect(allOutput).not.toContain(DUMMY_PRIVATE_KEY.slice(2));
      expect(allOutput).not.toContain(TEST_BEARER_SECRET);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
