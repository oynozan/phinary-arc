// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/Test.sol";
import {ArcForkBase} from "./ArcForkBase.sol";
import {PredictionMarket} from "../../PredictionMarket.sol";
import {BlackScholesLib} from "../../lib/BlackScholesLib.sol";

/// @notice LIVE-1 regression on a fork with the keeper's push policy (scripts/keeper.ts: a new
///         mock round only on a 5 bps move or a 45 s heartbeat; the settlement round lands
///         ~23 s after expiry). The live bytecode quoted a 44 s-old price 16 s before expiry as
///         current: ~0.52 for a side worth ~0.93 to a trader watching Coinbase. Contracts built
///         from the current sources stop executable prices when
///         (now - updatedAt) * ORACLE_AGE_RATIO > timeLeft.
contract OracleAgeGuardForkTest is ArcForkBase {
    uint256 internal constant WAD = 1e18;
    address internal trader = makeAddr("lag-trader");

    function setUp() public {
        _fork();
        for (uint8 a; a < 3; ++a) _refresh(a);
        _deployFresh(10_000e6);
        _fund(trader, 1_000e6);
    }

    /// @dev BTC moved +4.9 bps on Coinbase (< 5 bps, so no push) 44 s after the last heartbeat.
    function test_Regression_NearExpiryOracleLagNotTradable() public {
        _refresh(0);
        vm.prank(trader);
        uint256 id = pm.createMarket(0, 0, 300);
        PredictionMarket.Market memory m = pm.getMarket(id);
        int256 s8 = _latest(0);

        vm.warp(uint256(m.expiry) - 60);
        _push(0, s8); // last heartbeat at the strike price
        vm.warp(uint256(m.expiry) - 16); // oracle age 44 s
        int256 true8 = s8 + s8 * 49 / 100_000;

        (uint256 fairUp, uint256 buyUp, uint256 sellUp,,,, uint256 sigma, uint256 timeLeft) = pm.quote(id);
        uint256 informed = BlackScholesLib.binaryUpPrice(uint256(true8) * 1e10, m.strike, sigma, timeLeft + 23);
        console2.log("contract fairUp", fairUp);
        console2.log("informed fairUp", informed);
        assertGt(informed, fairUp + 0.2e18, "the information gap is far above the edge");
        assertEq(buyUp, 0, "no executable buy on a 44 s-old price with 16 s left");
        assertEq(sellUp, 0);
        vm.prank(trader);
        vm.expectRevert(PredictionMarket.OracleTooOldForExpiry.selector);
        pm.buy(id, true, 100e6, type(uint256).max);

        // The heartbeat publishes the move; trading resumes at the informed price.
        _push(0, true8);
        (, buyUp,,,,,,) = pm.quote(id);
        assertGt(buyUp, 0);
    }

    /// @dev A 119 s-old price (inside maxTradeStaleness) 16 s before expiry is no longer tradable.
    function test_Regression_QuoteRespectsOracleAge() public {
        _refresh(0);
        vm.prank(trader);
        uint256 id = pm.createMarket(0, 0, 300);
        PredictionMarket.Market memory m = pm.getMarket(id);
        vm.warp(uint256(m.expiry) - 135);
        _push(0, _latest(0));
        vm.warp(uint256(m.expiry) - 16); // oracle age 119 s: within maxTradeStaleness
        (uint256 fairUp, uint256 buyUp,, uint256 buyDown,,,,) = pm.quote(id);
        assertGt(fairUp, 0, "fair stays available");
        assertEq(buyUp, 0);
        assertEq(buyDown, 0);
        // With a fresh price the same moment is tradable.
        _refresh(0);
        (, buyUp,,,,,,) = pm.quote(id);
        assertGt(buyUp, 0);
    }
}
