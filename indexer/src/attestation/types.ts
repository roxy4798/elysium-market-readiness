/**
 * Types and interfaces for Phase 3B — Onchain Assessment Attestation.
 */

export interface AttestationArgs {
  readonly assessmentId: `0x${string}`;
  readonly assessmentHash: `0x${string}`;
  readonly token: `0x${string}`;
  readonly assessmentDate: bigint;
  readonly methodologyVersion: `0x${string}`;
}

export interface StoredAttestation {
  readonly id?: number;
  readonly assessment_id: string;
  readonly contract_address: string;
  readonly chain_id: number;
  readonly transaction_hash: string;
  readonly block_number: number;
  readonly attester_address: string;
  readonly attested_at: string | Date;
  readonly created_at?: string | Date;
}

export interface AttestationResponse {
  readonly assessment_id: string;
  readonly transaction_hash: string;
  readonly contract_address: string;
  readonly chain_id: number;
  readonly block_number: number;
  readonly attester: string;
  readonly assessment_hash: string;
}

export interface OnchainAttestationData {
  readonly assessmentHash: `0x${string}`;
  readonly token: `0x${string}`;
  readonly assessmentDate: bigint;
  readonly methodologyVersion: `0x${string}`;
  readonly attester: `0x${string}`;
  readonly attestedAt: bigint;
}

export interface OnchainVerificationDetails {
  readonly configured: boolean;
  readonly attested?: boolean;
  readonly error?: string;
  readonly hash_matches?: boolean;
  readonly token_matches?: boolean;
  readonly date_matches?: boolean;
  readonly methodology_matches?: boolean;
  readonly contract_address?: string;
  readonly chain_id?: number;
  readonly attester?: string;
  readonly attested_at?: number;
}

export interface AssessmentVerificationResponse {
  readonly assessment_id: string;
  readonly valid: boolean;
  readonly canonical_valid: boolean;
  readonly onchain_attested: boolean;
  readonly onchain_data_matches: boolean;
  readonly assessment_hash: string;
  readonly methodology_version: string;
  readonly onchain?: OnchainVerificationDetails;
}
