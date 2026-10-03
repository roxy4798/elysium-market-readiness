/**
 * Phase 3B — Onchain Assessment Attestation Service.
 * Manages onchain transaction submission, idempotency, and verification against Elysium Testnet.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Queryable } from '../database.js';
import { ELYSIUM_TESTNET_CHAIN_ID, ELYSIUM_TESTNET_DEFAULT_RPC } from '../config.js';
import { elysiumAssessmentAttestationAbi } from '../abi/attestation.js';
import {
  CURRENT_METHODOLOGY_VERSION,
  CURRENT_SCHEMA_VERSION,
  verifyCanonicalAssessment,
} from '../assessment/canonical.js';
import type { CanonicalAssessmentPayload, MarketStatus } from '../assessment/types.js';
import {
  assessmentIdToBytes32,
  bytes32ToMethodology,
  encodeAttestationArgs,
  utcMidnightTimestampToDate,
} from './encoder.js';
import type {
  AssessmentVerificationResponse,
  AttestationResponse,
  OnchainAttestationData,
  StoredAttestation,
} from './types.js';
import { logger } from '../logger.js';

export class AttestationConfigError extends Error {
  override readonly name = 'AttestationConfigError';
}

export class AssessmentNotFoundError extends Error {
  override readonly name = 'AssessmentNotFoundError';
}

export class AssessmentInsufficientDataError extends Error {
  override readonly name = 'AssessmentInsufficientDataError';
}

export class CanonicalVerificationError extends Error {
  override readonly name = 'CanonicalVerificationError';
}

export interface AttestationServiceOptions {
  contractAddress?: string;
  privateKey?: string;
  rpcUrl?: string;
  chainId?: number;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
}

export const elysiumTestnetChain = {
  id: ELYSIUM_TESTNET_CHAIN_ID,
  name: 'Elysium Testnet',
  nativeCurrency: { name: 'Elysium', symbol: 'ELY', decimals: 18 },
  rpcUrls: {
    default: { http: [ELYSIUM_TESTNET_DEFAULT_RPC] },
    public: { http: [ELYSIUM_TESTNET_DEFAULT_RPC] },
  },
};

/**
 * Loads stored attestation record from PostgreSQL by assessment_id.
 */
export async function getStoredAttestation(
  pool: Queryable,
  assessmentId: string,
): Promise<StoredAttestation | null> {
  const res = await pool.query<{
    id: number;
    assessment_id: string;
    contract_address: string;
    chain_id: string;
    transaction_hash: string;
    block_number: string;
    attester_address: string;
    attested_at: Date;
    created_at: Date;
  }>(
    `SELECT
       id,
       assessment_id,
       contract_address,
       chain_id,
       transaction_hash,
       block_number,
       attester_address,
       attested_at,
       created_at
     FROM assessment_attestations
     WHERE LOWER(assessment_id) = LOWER($1)
     LIMIT 1`,
    [assessmentId],
  );

  if (res.rows.length === 0) return null;
  const r = res.rows[0]!;
  return {
    id: r.id,
    assessment_id: r.assessment_id,
    contract_address: r.contract_address,
    chain_id: Number(r.chain_id),
    transaction_hash: r.transaction_hash,
    block_number: Number(r.block_number),
    attester_address: r.attester_address,
    attested_at: r.attested_at,
    created_at: r.created_at,
  };
}

/**
 * Saves attestation record to PostgreSQL with ON CONFLICT DO NOTHING.
 */
export async function saveStoredAttestation(
  pool: Queryable,
  record: StoredAttestation,
): Promise<void> {
  await pool.query(
    `INSERT INTO assessment_attestations (
       assessment_id,
       contract_address,
       chain_id,
       transaction_hash,
       block_number,
       attester_address,
       attested_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (assessment_id) DO NOTHING`,
    [
      record.assessment_id,
      record.contract_address.toLowerCase(),
      record.chain_id,
      record.transaction_hash,
      record.block_number,
      record.attester_address.toLowerCase(),
      record.attested_at,
    ],
  );
}

/**
 * Performs onchain attestation for an already-computed canonical assessment.
 */
export async function attestAssessment(
  pool: Queryable,
  rawAssessmentId: string,
  options: AttestationServiceOptions = {},
): Promise<AttestationResponse> {
  const contractAddress = options.contractAddress ?? process.env['ATTESTATION_CONTRACT_ADDRESS'];
  const privateKey = options.privateKey ?? process.env['ATTESTER_PRIVATE_KEY'];
  const rpcUrl = options.rpcUrl ?? process.env['RPC_URL'] ?? ELYSIUM_TESTNET_DEFAULT_RPC;
  const chainId = options.chainId ?? Number(process.env['CHAIN_ID'] ?? ELYSIUM_TESTNET_CHAIN_ID);

  if (!privateKey || privateKey.trim() === '') {
    throw new AttestationConfigError('Missing required ATTESTER_PRIVATE_KEY environment variable');
  }

  if (!contractAddress || !isAddress(contractAddress)) {
    throw new AttestationConfigError(
      `Missing or invalid ATTESTATION_CONTRACT_ADDRESS: "${contractAddress ?? ''}"`,
    );
  }

  // 1. Locate assessment in database
  const assessRes = await pool.query<{
    token_address: string;
    assessment_date: string;
    health_score: string | null;
    status: string;
    momentum: string | null;
    holder_health: string | null;
    transfer_activity: string | null;
    address_activity: string | null;
    concentration_score: string | null;
    consistency_score: string | null;
    data_window_days: number;
    reason: string | null;
    assessment_id: string | null;
    schema_version: string | null;
    methodology_version: string | null;
    assessment_hash: string | null;
  }>(
    `SELECT
       token_address,
       assessment_date::text as assessment_date,
       health_score,
       status,
       momentum,
       holder_health,
       transfer_activity,
       address_activity,
       concentration_score,
       consistency_score,
       data_window_days,
       reason,
       assessment_id,
       schema_version,
       methodology_version,
       assessment_hash
     FROM market_assessments
     WHERE LOWER(assessment_id) = LOWER($1)
     LIMIT 1`,
    [rawAssessmentId],
  );

  if (assessRes.rows.length === 0) {
    throw new AssessmentNotFoundError(`Assessment with ID "${rawAssessmentId}" not found`);
  }

  const row = assessRes.rows[0]!;

  if (row.status === 'INSUFFICIENT_DATA') {
    throw new AssessmentInsufficientDataError(
      `Cannot attest assessment with INSUFFICIENT_DATA (${row.reason ?? 'insufficient data'})`,
    );
  }

  if (!row.assessment_id || !row.assessment_hash || row.health_score === null || row.momentum === null) {
    throw new AssessmentInsufficientDataError('Assessment record is incomplete or corrupted');
  }

  // 2. Build canonical payload and verify offchain
  const payload: CanonicalAssessmentPayload = {
    schema_version: (row.schema_version ?? CURRENT_SCHEMA_VERSION) as '1.0',
    methodology_version: (row.methodology_version ?? CURRENT_METHODOLOGY_VERSION) as 'health-v1',
    token_address: row.token_address.toLowerCase(),
    assessment_date: row.assessment_date,
    health_score: Number(row.health_score),
    momentum: Number(row.momentum),
    status: row.status as MarketStatus,
    holder_health: Number(row.holder_health),
    transfer_activity: Number(row.transfer_activity),
    address_activity: Number(row.address_activity),
    concentration_score: Number(row.concentration_score),
    consistency_score: Number(row.consistency_score),
    data_window_days: Number(row.data_window_days),
  };

  const canonicalCheck = verifyCanonicalAssessment(payload, row.assessment_id, row.assessment_hash);
  if (!canonicalCheck.valid) {
    throw new CanonicalVerificationError(
      'Assessment failed offchain canonical verification before attestation',
    );
  }

  // 3. Check if already attested in database
  const existingDb = await getStoredAttestation(pool, row.assessment_id);
  if (existingDb) {
    return {
      assessment_id: row.assessment_id,
      transaction_hash: existingDb.transaction_hash,
      contract_address: existingDb.contract_address,
      chain_id: existingDb.chain_id,
      block_number: existingDb.block_number,
      attester: existingDb.attester_address,
      assessment_hash: row.assessment_hash,
    };
  }

  // 4. Setup viem clients
  const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(formattedKey);

  const chain = {
    ...elysiumTestnetChain,
    id: chainId,
  };

  const publicClient =
    options.publicClient ??
    createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

  const walletClient =
    options.walletClient ??
    createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

  const args = encodeAttestationArgs(payload, row.assessment_id, row.assessment_hash);

  // 5. Check if already attested onchain
  try {
    const alreadyAttested = await publicClient.readContract({
      address: contractAddress as `0x${string}`,
      abi: elysiumAssessmentAttestationAbi,
      functionName: 'isAttested',
      args: [args.assessmentId],
    });

    if (alreadyAttested) {
      throw new AttestationConfigError(
        'Assessment is already present in the configured contract, but no transaction receipt is recorded locally; refusing to invent transaction metadata',
      );
    }
  } catch (err) {
    logger.debug('onchain isAttested pre-check skipped or failed', { error: err });
  }

  // 6. Submit transaction onchain
  const txHash = await walletClient.writeContract({
    address: contractAddress as `0x${string}`,
    abi: elysiumAssessmentAttestationAbi,
    functionName: 'attestAssessment',
    args: [
      args.assessmentId,
      args.assessmentHash,
      args.token,
      args.assessmentDate,
      args.methodologyVersion,
    ],
    account,
    chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const record: StoredAttestation = {
    assessment_id: row.assessment_id,
    contract_address: contractAddress,
    chain_id: chainId,
    transaction_hash: receipt.transactionHash,
    block_number: Number(receipt.blockNumber),
    attester_address: account.address,
    attested_at: new Date(),
  };

  await saveStoredAttestation(pool, record);

  return {
    assessment_id: row.assessment_id,
    transaction_hash: receipt.transactionHash,
    contract_address: contractAddress,
    chain_id: chainId,
    block_number: Number(receipt.blockNumber),
    attester: account.address,
    assessment_hash: row.assessment_hash,
  };
}

/**
 * Verifies an assessment both offchain (canonical identity and hash)
 * and onchain (against smart contract attestation registry).
 */
export async function verifyAssessment(
  pool: Queryable,
  rawAssessmentId: string,
  options: AttestationServiceOptions = {},
): Promise<AssessmentVerificationResponse> {
  const contractAddress = options.contractAddress ?? process.env['ATTESTATION_CONTRACT_ADDRESS'];
  const rpcUrl = options.rpcUrl ?? process.env['RPC_URL'] ?? ELYSIUM_TESTNET_DEFAULT_RPC;
  const chainId = options.chainId ?? Number(process.env['CHAIN_ID'] ?? ELYSIUM_TESTNET_CHAIN_ID);

  const rowRes = await pool.query<{
    token_address: string;
    assessment_date: string;
    health_score: string;
    status: string;
    momentum: string;
    holder_health: string;
    transfer_activity: string;
    address_activity: string;
    concentration_score: string;
    consistency_score: string;
    data_window_days: number;
    assessment_id: string;
    schema_version: string;
    methodology_version: string;
    assessment_hash: string;
  }>(
    `SELECT
       token_address,
       assessment_date::text as assessment_date,
       health_score,
       status,
       momentum,
       holder_health,
       transfer_activity,
       address_activity,
       concentration_score,
       consistency_score,
       data_window_days,
       assessment_id,
       schema_version,
       methodology_version,
       assessment_hash
     FROM market_assessments
     WHERE LOWER(assessment_id) = LOWER($1)
     LIMIT 1`,
    [rawAssessmentId],
  );

  if (rowRes.rows.length === 0) {
    throw new AssessmentNotFoundError(`Assessment with ID "${rawAssessmentId}" not found`);
  }

  const row = rowRes.rows[0]!;

  const payload: CanonicalAssessmentPayload = {
    schema_version: (row.schema_version ?? CURRENT_SCHEMA_VERSION) as '1.0',
    methodology_version: (row.methodology_version ?? CURRENT_METHODOLOGY_VERSION) as 'health-v1',
    token_address: row.token_address.toLowerCase(),
    assessment_date: row.assessment_date,
    health_score: Number(row.health_score),
    momentum: Number(row.momentum),
    status: row.status as MarketStatus,
    holder_health: Number(row.holder_health),
    transfer_activity: Number(row.transfer_activity),
    address_activity: Number(row.address_activity),
    concentration_score: Number(row.concentration_score),
    consistency_score: Number(row.consistency_score),
    data_window_days: Number(row.data_window_days),
  };

  const canonicalCheck = verifyCanonicalAssessment(payload, row.assessment_id, row.assessment_hash);

  // If no contract configured or address is invalid, return canonical verification
  if (!contractAddress || !isAddress(contractAddress)) {
    return {
      assessment_id: row.assessment_id,
      valid: canonicalCheck.valid,
      canonical_valid: canonicalCheck.valid,
      onchain_attested: false,
      onchain_data_matches: false,
      assessment_hash: canonicalCheck.computedHash,
      methodology_version: payload.methodology_version,
      onchain: {
        configured: false,
        ...(contractAddress ? { error: 'ATTESTATION_CONTRACT_ADDRESS is invalid' } : {}),
      },
    };
  }

  const publicClient =
    options.publicClient ??
    createPublicClient({
      chain: { ...elysiumTestnetChain, id: chainId },
      transport: http(rpcUrl),
    });

  const assessmentIdBytes32 = assessmentIdToBytes32(row.assessment_id);

  try {
    const isAttested = await publicClient.readContract({
      address: contractAddress as `0x${string}`,
      abi: elysiumAssessmentAttestationAbi,
      functionName: 'isAttested',
      args: [assessmentIdBytes32],
    });

    if (!isAttested) {
      return {
        assessment_id: row.assessment_id,
        valid: canonicalCheck.valid,
        canonical_valid: canonicalCheck.valid,
        onchain_attested: false,
        onchain_data_matches: false,
        assessment_hash: canonicalCheck.computedHash,
        methodology_version: payload.methodology_version,
        onchain: { configured: true, attested: false },
      };
    }

    const onchainRaw = (await publicClient.readContract({
      address: contractAddress as `0x${string}`,
      abi: elysiumAssessmentAttestationAbi,
      functionName: 'getAttestation',
      args: [assessmentIdBytes32],
    })) as [
      `0x${string}`,
      `0x${string}`,
      bigint,
      `0x${string}`,
      `0x${string}`,
      bigint,
    ];

    const onchainData: OnchainAttestationData = {
      assessmentHash: onchainRaw[0],
      token: onchainRaw[1],
      assessmentDate: onchainRaw[2],
      methodologyVersion: onchainRaw[3],
      attester: onchainRaw[4],
      attestedAt: onchainRaw[5],
    };

    // Compare onchain data with canonical assessment
    const expectedHashBytes32 = `0x${canonicalCheck.computedHash.toLowerCase()}`;
    const hashMatches = onchainData.assessmentHash.toLowerCase() === expectedHashBytes32;
    const tokenMatches = onchainData.token.toLowerCase() === payload.token_address.toLowerCase();
    const onchainDateStr = utcMidnightTimestampToDate(onchainData.assessmentDate);
    const dateMatches = onchainDateStr === payload.assessment_date;
    const onchainMethodology = bytes32ToMethodology(onchainData.methodologyVersion);
    const methodologyMatches = onchainMethodology === payload.methodology_version;

    const onchainDataMatches = hashMatches && tokenMatches && dateMatches && methodologyMatches;

    return {
      assessment_id: row.assessment_id,
      valid: canonicalCheck.valid && onchainDataMatches,
      canonical_valid: canonicalCheck.valid,
      onchain_attested: true,
      onchain_data_matches: onchainDataMatches,
      assessment_hash: canonicalCheck.computedHash,
      methodology_version: payload.methodology_version,
      onchain: {
        configured: true,
        hash_matches: hashMatches,
        token_matches: tokenMatches,
        date_matches: dateMatches,
        methodology_matches: methodologyMatches,
        contract_address: contractAddress,
        chain_id: chainId,
        attester: onchainData.attester,
        attested_at: Number(onchainData.attestedAt),
      },
    };
  } catch (err) {
    logger.warn('onchain verification query failed, falling back to offchain verification', {
      error: err,
    });
    return {
      assessment_id: row.assessment_id,
      valid: canonicalCheck.valid,
      canonical_valid: canonicalCheck.valid,
      onchain_attested: false,
      onchain_data_matches: false,
      assessment_hash: canonicalCheck.computedHash,
      methodology_version: payload.methodology_version,
      onchain: { configured: true, error: 'contract_read_failed' },
    };
  }
}
