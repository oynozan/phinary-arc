// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A feed that settles each expiry on its own report (StreamsFeed). PriceOracleAdapter
///         detects it by SETTLE_WINDOW() and settles on settlementAnswer instead of a round.
interface ISettlementFeed {
    function SETTLE_WINDOW() external view returns (uint256);
    /// @dev Reverts while no final settlement report exists for `expiry`.
    function settlementAnswer(uint256 expiry) external view returns (int256 answer, uint256 observedAt);
}
