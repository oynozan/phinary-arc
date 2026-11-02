// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test-only stand-in for the Data Streams VerifierProxy: skips signature checks and returns
///      the reportData of a full report, like the real proxy does after verifying it.
contract MockVerifierProxy {
    address public s_feeManager;
    bool public rejectAll;

    error BadVerification();

    function setFeeManager(address feeManager) external { s_feeManager = feeManager; }

    function setRejectAll(bool reject) external { rejectAll = reject; }

    function verify(bytes calldata payload, bytes calldata) external payable returns (bytes memory) {
        if (rejectAll) revert BadVerification();
        (, bytes memory reportData,,,) = abi.decode(payload, (bytes32[3], bytes, bytes32[], bytes32[], bytes32));
        return reportData;
    }
}
