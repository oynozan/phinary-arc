// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PMTestBase} from "./PredictionMarket.Base.t.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";
import {MockAggregator} from "../MockAggregator.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @dev Feed with fully scripted round ids (to model Chainlink phase-prefixed ids).
contract ScriptedFeed is AggregatorV3Interface {
    struct R {
        int256 a;
        uint256 t;
        bool set;
    }

    mapping(uint80 => R) public rounds;
    uint80 public latest;

    function put(uint80 id, int256 a, uint256 t) external {
        rounds[id] = R(a, t, true);
        latest = id;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "scripted";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80 id) public view returns (uint80, int256, uint256, uint256, uint80) {
        R memory r = rounds[id];
        require(r.set, "No data present");
        return (id, r.a, r.t, r.t, id);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latest);
    }
}

contract OracleTest is PMTestBase {
    function _newFeed(uint8 d) internal returns (MockAggregator a) {
        a = new MockAggregator(address(this), d, "X");
    }

    // ---------------------------------------------------------------- setFeed
    function test_SetFeed_StoresAndEmits() public {
        MockAggregator a = _newFeed(8);
        a.setPrice(100e8);
        vm.expectEmit(true, true, false, true, address(oracle));
        emit PriceOracleAdapter.FeedSet(1, address(a), 8, 600, 0.1e18, 2e18, 0.5e18);
        oracle.setFeed(1, address(a), 600, 0.1e18, 2e18, 0.5e18);
        (uint256 p,) = oracle.getPrice(1);
        assertEq(p, 100e18);
        assertEq(oracle.getVol(1), 0.5e18);
    }

    function test_SetFeed_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        oracle.setFeed(1, address(agg), 600, 0.1e18, 2e18, 0.5e18);
    }

    function test_SetFeed_InvalidConfigReverts() public {
        bytes4 e = PriceOracleAdapter.InvalidConfiguration.selector;
        vm.expectRevert(e);
        oracle.setFeed(1, address(0), 600, 0.1e18, 2e18, 0.5e18);
        vm.expectRevert(e);
        oracle.setFeed(1, alice, 600, 0.1e18, 2e18, 0.5e18); // EOA
        vm.expectRevert(e);
        oracle.setFeed(1, address(agg), 0, 0.1e18, 2e18, 0.5e18); // staleness 0
        vm.expectRevert(e);
        oracle.setFeed(1, address(agg), 600, 0, 2e18, 0.5e18); // minVol 0
        vm.expectRevert(e);
        oracle.setFeed(1, address(agg), 600, 0.6e18, 2e18, 0.5e18); // min > default
        vm.expectRevert(e);
        oracle.setFeed(1, address(agg), 600, 0.1e18, 0.4e18, 0.5e18); // default > max
        vm.expectRevert(e);
        oracle.setFeed(1, address(agg), 600, 0.1e18, 10e18 + 1, 0.5e18); // max > 1000%
    }

    function test_SetFeed_DecimalsAbove36Reverts() public {
        MockAggregator a = _newFeed(37);
        vm.expectRevert(PriceOracleAdapter.InvalidConfiguration.selector);
        oracle.setFeed(1, address(a), 600, 0.1e18, 2e18, 0.5e18);
    }

    function test_SetFeed_ResetsHistory() public {
        oracle.poke(ASSET);
        assertEq(oracle.getObservationCount(ASSET), 1);
        oracle.setFeed(ASSET, address(agg), 3600, 0.2e18, 3e18, DEFAULT_VOL);
        assertEq(oracle.getObservationCount(ASSET), 0);
    }

    function test_UnknownAssetReverts() public {
        vm.expectRevert(abi.encodeWithSelector(PriceOracleAdapter.AssetNotEnabled.selector, uint8(9)));
        oracle.getPrice(9);
        vm.expectRevert(abi.encodeWithSelector(PriceOracleAdapter.AssetNotEnabled.selector, uint8(9)));
        oracle.getVol(9);
        vm.expectRevert(abi.encodeWithSelector(PriceOracleAdapter.AssetNotEnabled.selector, uint8(9)));
        oracle.getObservationCount(9);
    }

    function test_RenounceOwnershipDisabled() public {
        vm.expectRevert(PriceOracleAdapter.RenounceDisabled.selector);
        oracle.renounceOwnership();
    }

    // --------------------------------------------------------------- getPrice
    function test_GetPrice_NormalizesDecimals() public {
        (uint256 p, uint256 at) = oracle.getPrice(ASSET);
        assertEq(p, SPOT);
        assertEq(at, block.timestamp);

        MockAggregator a18 = _newFeed(18);
        a18.setPrice(7e18);
        oracle.setFeed(1, address(a18), 600, 0.1e18, 2e18, 0.5e18);
        (p,) = oracle.getPrice(1);
        assertEq(p, 7e18);

        MockAggregator a20 = _newFeed(20);
        a20.setPrice(300e20);
        oracle.setFeed(2, address(a20), 600, 0.1e18, 2e18, 0.5e18);
        (p,) = oracle.getPrice(2);
        assertEq(p, 300e18);
    }

    function test_GetPrice_StaleRevertsAfterMaxStaleness() public {
        skip(3600);
        oracle.getPrice(ASSET); // exactly maxStaleness is still fresh
        skip(1);
        vm.expectRevert(PriceOracleAdapter.StalePrice.selector);
        oracle.getPrice(ASSET);
    }

    function test_GetPrice_InvalidAnswerReverts() public {
        agg.setPrice(0);
        vm.expectRevert(PriceOracleAdapter.InvalidRound.selector);
        oracle.getPrice(ASSET);
        agg.setPrice(-5);
        vm.expectRevert(PriceOracleAdapter.InvalidRound.selector);
        oracle.getPrice(ASSET);
    }

    function test_GetPriceMaxAge() public {
        skip(120);
        (uint256 p,) = oracle.getPriceMaxAge(ASSET, 120);
        assertEq(p, SPOT);
        skip(1);
        vm.expectRevert(PriceOracleAdapter.StalePrice.selector);
        oracle.getPriceMaxAge(ASSET, 120);
        // feed policy still the outer bound
        oracle.getPrice(ASSET);
    }

    // ------------------------------------------------------------------- poke
    function test_Poke_RateLimitedTo60s() public {
        vm.expectEmit(true, false, false, true, address(oracle));
        emit PriceOracleAdapter.ObservationRecorded(ASSET, SPOT, block.timestamp, 1);
        oracle.poke(ASSET);
        assertEq(oracle.getObservationCount(ASSET), 1);
        skip(59);
        oracle.poke(ASSET);
        assertEq(oracle.getObservationCount(ASSET), 1, "within 60s is a no-op");
        skip(1);
        oracle.poke(ASSET);
        assertEq(oracle.getObservationCount(ASSET), 2, "at 60s records");
    }

    function test_Poke_StaleFeedIsNoOpNotRevert() public {
        skip(3601);
        oracle.poke(ASSET);
        assertEq(oracle.getObservationCount(ASSET), 0);
    }

    function test_Poke_CapacityCapsAt32() public {
        for (uint256 i; i < 40; ++i) {
            _refresh();
            oracle.poke(ASSET);
            skip(60);
        }
        assertEq(oracle.getObservationCount(ASSET), 32);
    }

    // ----------------------------------------------------------------- getVol
    /// @dev Records n observations spaced `dt` apart, alternating price by `bps`/10000.
    function _observe(uint256 n, uint256 dt, int256 bps) internal {
        for (uint256 i; i < n; ++i) {
            int256 p = (i % 2 == 0) ? SPOT8 : SPOT8 + (SPOT8 * bps) / 10_000;
            _setPrice(p);
            oracle.poke(ASSET);
            if (i + 1 < n) skip(dt);
        }
    }

    function test_GetVol_DefaultBelowEightObservations() public {
        _observe(7, 60, 100);
        assertEq(oracle.getObservationCount(ASSET), 7);
        assertEq(oracle.getVol(ASSET), DEFAULT_VOL);
    }

    function test_GetVol_RealizedAfterEightObservations() public {
        _observe(8, 60, 10); // 0.1% alternating, 60s apart
        assertEq(oracle.getObservationCount(ASSET), 8);
        // sigma = ln(1.001) * sqrt(YEAR/60) ~= 0.7246
        assertApproxEqRel(oracle.getVol(ASSET), 0.7246e18, 0.005e18);
        assertTrue(oracle.getVol(ASSET) != DEFAULT_VOL);
    }

    function test_GetVol_ScalesWithSamplingInterval() public {
        _observe(8, 120, 10); // 120s apart -> sigma/sqrt(2)
        assertApproxEqRel(oracle.getVol(ASSET), 0.5124e18, 0.005e18);
    }

    function test_GetVol_ClampedToMax() public {
        _observe(8, 60, 100); // 1% alternating -> ~7.2 > 3
        assertEq(oracle.getVol(ASSET), 3e18);
    }

    function test_GetVol_ClampedToMin() public {
        _observe(8, 60, 0); // flat -> 0 < minVol
        assertEq(oracle.getVol(ASSET), 0.2e18);
    }

    function test_GetVol_WrappedRingStillRealized() public {
        _observe(40, 60, 10);
        assertEq(oracle.getObservationCount(ASSET), 32);
        assertApproxEqRel(oracle.getVol(ASSET), 0.7246e18, 0.005e18);
    }

    // ------------------------------------------------------- settlementPrice
    /// @dev Builds rounds A (before expiry), B (E+5), C (E+10). Returns (E, A, B, C).
    function _rounds() internal returns (uint256 E, uint80 A, uint80 B, uint80 C) {
        E = block.timestamp + 1000;
        vm.warp(E - 100);
        _setPrice(2001e8);
        A = agg.latestRoundId();
        vm.warp(E + 5);
        _setPrice(2010e8);
        B = agg.latestRoundId();
        vm.warp(E + 10);
        _setPrice(2020e8);
        C = agg.latestRoundId();
    }

    function test_Settlement_FirstRoundAtOrAfterExpiryAccepted() public {
        (uint256 E,, uint80 B,) = _rounds();
        assertEq(oracle.settlementPrice(ASSET, B, E), 2010e18);
    }

    function test_Settlement_RejectsLaterRound() public {
        (uint256 E,,, uint80 C) = _rounds();
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        oracle.settlementPrice(ASSET, C, E);
    }

    function test_Settlement_RejectsEarlierRound() public {
        (uint256 E, uint80 A,,) = _rounds();
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        oracle.settlementPrice(ASSET, A, E);
    }

    function test_Settlement_NonexistentRoundReverts() public {
        (uint256 E,,, uint80 C) = _rounds();
        vm.expectRevert();
        oracle.settlementPrice(ASSET, C + 1, E);
    }

    function test_Settlement_RoundExactlyAtExpiryAccepted() public {
        uint256 E = block.timestamp + 500;
        vm.warp(E - 1);
        _setPrice(1999e8);
        vm.warp(E);
        _setPrice(2005e8);
        uint80 X = agg.latestRoundId();
        assertEq(oracle.settlementPrice(ASSET, X, E), 2005e18);
        _setPrice(2006e8); // same timestamp == expiry: predecessor is not strictly before expiry
        uint80 Y = agg.latestRoundId();
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        oracle.settlementPrice(ASSET, Y, E);
    }

    function test_Settlement_RoundOneNeedsNoPredecessor() public {
        MockAggregator a = _newFeed(8);
        uint256 E = block.timestamp;
        a.setPrice(55e8);
        oracle.setFeed(1, address(a), 600, 0.1e18, 2e18, 0.5e18);
        assertEq(a.latestRoundId(), 1);
        assertEq(oracle.settlementPrice(1, 1, E), 55e18);
    }

    function test_Settlement_InvalidAnswersRejected() public {
        uint256 E = block.timestamp + 500;
        vm.warp(E - 10);
        _setPrice(-1); // invalid predecessor
        vm.warp(E + 1);
        _setPrice(2000e8);
        uint80 r1 = agg.latestRoundId();
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        oracle.settlementPrice(ASSET, r1, E);

        // a zero-answer round at/after expiry is not settleable
        uint256 E2 = block.timestamp + 500;
        vm.warp(E2 - 10);
        _setPrice(2000e8);
        vm.warp(E2 + 1);
        _setPrice(0);
        uint80 r2 = agg.latestRoundId();
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        oracle.settlementPrice(ASSET, r2, E2);
    }

    function test_Settlement_NoStalenessCheckOnOldRound() public {
        (uint256 E,, uint80 B,) = _rounds();
        skip(30 days);
        assertEq(oracle.settlementPrice(ASSET, B, E), 2010e18);
    }

    function test_Settlement_PhaseBoundaryRoundReverts() public {
        ScriptedFeed f = new ScriptedFeed();
        oracle.setFeed(3, address(f), 600, 0.1e18, 2e18, 0.5e18);
        uint256 E = block.timestamp;
        uint80 id = (uint80(1) << 64) | 1;
        f.put(id, 100e8, E + 1);
        vm.warp(E + 2);
        vm.expectRevert(PriceOracleAdapter.PhaseBoundaryRound.selector);
        oracle.settlementPrice(3, id, E);
    }

    function test_Settlement_PhasePrefixedRoundWithPredecessorAccepted() public {
        ScriptedFeed f = new ScriptedFeed();
        oracle.setFeed(3, address(f), 600, 0.1e18, 2e18, 0.5e18);
        uint256 E = block.timestamp;
        uint80 p1 = (uint80(1) << 64) | 1;
        uint80 p2 = (uint80(1) << 64) | 2;
        f.put(p1, 99e8, E - 5);
        f.put(p2, 101e8, E + 1);
        vm.warp(E + 2);
        assertEq(oracle.settlementPrice(3, p2, E), 101e18);
    }
}
