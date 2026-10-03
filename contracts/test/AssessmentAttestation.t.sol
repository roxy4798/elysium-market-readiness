// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../contracts/ElysiumAssessmentAttestation.sol";

contract AssessmentAttestationTest {
    ElysiumAssessmentAttestation attestation;

    bytes32 constant TEST_ID = 0x2cdabbc86a34c27890a226afda3decfe8bc19f88797651a9e57ff8fb62f9077f;
    bytes32 constant TEST_HASH = 0x9ab5fd180d003ec685fde08273664ff2f242149a4794f09bcb6bf2bb927d43f2;
    address constant TEST_TOKEN = 0x548b43d400Cbe3f85cB00F606486291206485036;
    uint64 constant TEST_DATE = 1790035200; // 2026-09-22 UTC midnight
    bytes32 constant TEST_METHODOLOGY = bytes32("health-v1");

    function setUp() public {
        attestation = new ElysiumAssessmentAttestation();
    }

    // 1. Successful first attestation
    function testSuccessfulFirstAttestation() public {
        setUp();
        require(!attestation.isAttested(TEST_ID), "should not be attested initially");

        attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY);

        require(attestation.isAttested(TEST_ID), "should be attested after attestAssessment");
    }

    // 2. Stored data can be retrieved accurately
    function testGetAttestationData() public {
        setUp();
        attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY);

        (
            bytes32 hash,
            address token,
            uint64 date,
            bytes32 methodology,
            address attester,
            uint64 attestedAt
        ) = attestation.getAttestation(TEST_ID);

        require(hash == TEST_HASH, "hash mismatch");
        require(token == TEST_TOKEN, "token mismatch");
        require(date == TEST_DATE, "date mismatch");
        require(methodology == TEST_METHODOLOGY, "methodology mismatch");
        require(attester == address(this), "attester mismatch");
        require(attestedAt > 0, "attestedAt should be > 0");
    }

    // 3. Duplicate identical attestation is idempotent and preserves original attester & timestamp
    function testDuplicateIdenticalAttestationIsIdempotent() public {
        setUp();
        attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY);
        (, , , , address firstAttester, uint64 firstTimestamp) = attestation.getAttestation(TEST_ID);

        // Re-attest with exact same data
        attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY);
        (, , , , address secondAttester, uint64 secondTimestamp) = attestation.getAttestation(TEST_ID);

        require(firstAttester == secondAttester, "attester changed on duplicate");
        require(firstTimestamp == secondTimestamp, "timestamp changed on duplicate");
    }

    // 4. Conflicting duplicate attestation reverts with different hash
    function testConflictingDuplicateHashReverts() public {
        setUp();
        attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY);

        bytes32 differentHash = 0x1111111111111111111111111111111111111111111111111111111111111111;
        try attestation.attestAssessment(TEST_ID, differentHash, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY) {
            revert("expected revert on conflicting hash");
        } catch {}
    }

    // 5. Conflicting duplicate attestation reverts with different token
    function testConflictingDuplicateTokenReverts() public {
        setUp();
        attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY);

        address differentToken = 0x0000000000000000000000000000000000000001;
        try attestation.attestAssessment(TEST_ID, TEST_HASH, differentToken, TEST_DATE, TEST_METHODOLOGY) {
            revert("expected revert on conflicting token");
        } catch {}
    }

    // 6. Conflicting duplicate attestation reverts with different date
    function testConflictingDuplicateDateReverts() public {
        setUp();
        attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY);

        uint64 differentDate = TEST_DATE + 86400;
        try attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, differentDate, TEST_METHODOLOGY) {
            revert("expected revert on conflicting date");
        } catch {}
    }

    // 7. Conflicting duplicate attestation reverts with different methodology
    function testConflictingDuplicateMethodologyReverts() public {
        setUp();
        attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY);

        bytes32 differentMethodology = bytes32("health-v2");
        try attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, differentMethodology) {
            revert("expected revert on conflicting methodology");
        } catch {}
    }

    // 8. Zero assessment ID rejected
    function testZeroAssessmentIdRejected() public {
        setUp();
        try attestation.attestAssessment(bytes32(0), TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY) {
            revert("expected revert on zero assessment ID");
        } catch {}
    }

    // 9. Zero assessment hash rejected
    function testZeroAssessmentHashRejected() public {
        setUp();
        try attestation.attestAssessment(TEST_ID, bytes32(0), TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY) {
            revert("expected revert on zero assessment hash");
        } catch {}
    }

    // 10. Zero token rejected
    function testZeroTokenRejected() public {
        setUp();
        try attestation.attestAssessment(TEST_ID, TEST_HASH, address(0), TEST_DATE, TEST_METHODOLOGY) {
            revert("expected revert on zero token");
        } catch {}
    }

    // 11. Zero date rejected
    function testZeroDateRejected() public {
        setUp();
        try attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, 0, TEST_METHODOLOGY) {
            revert("expected revert on zero date");
        } catch {}
    }

    // 12. Zero methodology version rejected
    function testZeroMethodologyVersionRejected() public {
        setUp();
        try attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, bytes32(0)) {
            revert("expected revert on zero methodology");
        } catch {}
    }

    // 13. isAttested returns false for unrecorded ID and true after recording
    function testIsAttestedReturnsCorrectResult() public {
        setUp();
        bytes32 unknownId = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        require(!attestation.isAttested(unknownId), "unattested ID should return false");
        attestation.attestAssessment(TEST_ID, TEST_HASH, TEST_TOKEN, TEST_DATE, TEST_METHODOLOGY);
        require(attestation.isAttested(TEST_ID), "attested ID should return true");
        require(!attestation.isAttested(unknownId), "unknown ID should still return false");
    }
}
