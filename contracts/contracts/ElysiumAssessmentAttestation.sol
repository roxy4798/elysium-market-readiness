// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ElysiumAssessmentAttestation
 * @notice Immutable onchain attestation registry for canonical market readiness assessments on Elysium Testnet (Chain ID 99801).
 * @dev Records cryptographic proof of canonical assessments computed offchain.
 *      Does not calculate health scores, make external calls, or use upgrade proxies.
 */
contract ElysiumAssessmentAttestation {
    struct AttestationRecord {
        bytes32 assessmentHash;
        address token;
        uint64 assessmentDate;
        bytes32 methodologyVersion;
        address attester;
        uint64 attestedAt;
    }

    /// @dev Mapping from deterministic assessmentId to stored attestation record.
    mapping(bytes32 => AttestationRecord) private _attestations;

    // Custom errors
    error ZeroAssessmentId();
    error ZeroAssessmentHash();
    error ZeroTokenAddress();
    error ZeroAssessmentDate();
    error ZeroMethodologyVersion();
    error AssessmentAlreadyAttestedWithDifferentData(bytes32 assessmentId);

    // Event
    event AssessmentAttested(
        bytes32 indexed assessmentId,
        bytes32 indexed assessmentHash,
        address indexed token,
        uint64 assessmentDate,
        bytes32 methodologyVersion,
        address attester
    );

    /**
     * @notice Records an immutable assessment attestation.
     * @dev Idempotent if re-attested with identical values. Reverts if re-attested with conflicting values.
     * @param assessmentId The deterministic Keccak-256 identifier of the assessment.
     * @param assessmentHash The SHA-256 hash of the canonical assessment payload.
     * @param token The ERC-20 token address that was assessed.
     * @param assessmentDate UTC midnight unix timestamp (seconds) of the assessment date.
     * @param methodologyVersion Methodology identifier (e.g. "health-v1" packed into bytes32).
     */
    function attestAssessment(
        bytes32 assessmentId,
        bytes32 assessmentHash,
        address token,
        uint64 assessmentDate,
        bytes32 methodologyVersion
    ) external {
        if (assessmentId == bytes32(0)) revert ZeroAssessmentId();
        if (assessmentHash == bytes32(0)) revert ZeroAssessmentHash();
        if (token == address(0)) revert ZeroTokenAddress();
        if (assessmentDate == 0) revert ZeroAssessmentDate();
        if (methodologyVersion == bytes32(0)) revert ZeroMethodologyVersion();

        AttestationRecord storage existing = _attestations[assessmentId];

        if (existing.attestedAt != 0) {
            // Already attested: check for identical parameters
            if (
                existing.assessmentHash == assessmentHash &&
                existing.token == token &&
                existing.assessmentDate == assessmentDate &&
                existing.methodologyVersion == methodologyVersion
            ) {
                // Deterministic idempotent return: do not overwrite attester or timestamp
                return;
            } else {
                revert AssessmentAlreadyAttestedWithDifferentData(assessmentId);
            }
        }

        uint64 timestamp = uint64(block.timestamp);
        _attestations[assessmentId] = AttestationRecord({
            assessmentHash: assessmentHash,
            token: token,
            assessmentDate: assessmentDate,
            methodologyVersion: methodologyVersion,
            attester: msg.sender,
            attestedAt: timestamp
        });

        emit AssessmentAttested(
            assessmentId,
            assessmentHash,
            token,
            assessmentDate,
            methodologyVersion,
            msg.sender
        );
    }

    /**
     * @notice Retrieves stored attestation record by assessment ID.
     */
    function getAttestation(bytes32 assessmentId)
        external
        view
        returns (
            bytes32 assessmentHash,
            address token,
            uint64 assessmentDate,
            bytes32 methodologyVersion,
            address attester,
            uint64 attestedAt
        )
    {
        AttestationRecord storage record = _attestations[assessmentId];
        return (
            record.assessmentHash,
            record.token,
            record.assessmentDate,
            record.methodologyVersion,
            record.attester,
            record.attestedAt
        );
    }

    /**
     * @notice Checks whether an assessment ID has been attested onchain.
     */
    function isAttested(bytes32 assessmentId) external view returns (bool) {
        return _attestations[assessmentId].attestedAt != 0;
    }
}
