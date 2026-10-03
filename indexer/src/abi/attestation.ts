/**
 * ABI and artifact definitions for ElysiumAssessmentAttestation.
 */
import { parseAbi } from 'viem';

export const elysiumAssessmentAttestationAbi = parseAbi([
  'error ZeroAssessmentId()',
  'error ZeroAssessmentHash()',
  'error ZeroTokenAddress()',
  'error ZeroAssessmentDate()',
  'error ZeroMethodologyVersion()',
  'error AssessmentAlreadyAttestedWithDifferentData(bytes32 assessmentId)',
  'event AssessmentAttested(bytes32 indexed assessmentId, bytes32 indexed assessmentHash, address indexed token, uint64 assessmentDate, bytes32 methodologyVersion, address attester)',
  'function attestAssessment(bytes32 assessmentId, bytes32 assessmentHash, address token, uint64 assessmentDate, bytes32 methodologyVersion) external',
  'function getAttestation(bytes32 assessmentId) external view returns (bytes32 assessmentHash, address token, uint64 assessmentDate, bytes32 methodologyVersion, address attester, uint64 attestedAt)',
  'function isAttested(bytes32 assessmentId) external view returns (bool)',
]);
