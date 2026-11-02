// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/console2.sol";
import {PMTestBase} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";
import {MockAggregator} from "../MockAggregator.sol";

/// @dev Audit coverage: trading, orders, settlement, oracle adapter, MockAggregator.
///      test_Regression_* cover fixed findings (VOL-LAG-1, EDGE-CLAMP-1, SETTLE-INVALID-ROUND-1).
contract TradingOracleAuditTest is PMTestBase {
    // ------------------------------------------------------------------ helpers
    function _resetHistory() internal {
        oracle.setFeed(ASSET, address(agg), 3600, 0.2e18, 3e18, DEFAULT_VOL);
    }

    /// @dev Record `n` observations `dt` seconds apart at the current price.
    function _flatHistory(uint256 n, uint256 dt) internal {
        for (uint256 i; i < n; ++i) {
            skip(dt);
            _refresh();
            oracle.poke(ASSET);
        }
    }

    /// @dev `n` observations 60s apart alternating between 2000 and 2000 * (1 + bps/1e5).
    function _noisyHistory(uint256 n, int256 tenthBps) internal {
        for (uint256 i; i < n; ++i) {
            skip(60);
            _setPrice(i % 2 == 0 ? int256(2000e8) : int256(2000e8) + 2000e8 * tenthBps / 100_000);
            oracle.poke(ASSET);
        }
        _setPrice(2000e8);
    }

    function _createStrike(uint256 strike, uint32 dur) internal returns (uint256 id) {
        _refresh();
        vm.prank(alice);
        id = pm.createMarket(ASSET, strike, dur);
    }

    /// @dev Buy `units` of a side now, wait `hold` seconds at the same oracle price, sell all.
    function _roundTrip(uint256 id, bool up, uint256 units, uint256 hold)
        internal returns (uint256 cost, uint256 proceeds, uint256 sigBuy, uint256 sigSell)
    {
        sigBuy = _q(id).sigma;
        uint256 b0 = usdc.balanceOf(attacker);
        vm.prank(attacker);
        pm.buy(id, up, units, type(uint256).max);
        cost = b0 - usdc.balanceOf(attacker);
        skip(hold);
        _refresh();
        vm.prank(attacker);
        pm.sell(id, up, units, 0);
        proceeds = usdc.balanceOf(attacker) - (b0 - cost);
        sigSell = _q(id).sigma;
    }

    // ======================================================================
    // 1. VOL-LAG-1: sigma must not lag the spot being traded.
    // ======================================================================

    /// @notice With the oracle price unchanged, a buy followed by a sell must never be
    ///         profitable. Previously poke() was rate-limited and getVol ignored the fresh
    ///         price, so a jump showed up in spot but not in sigma until the sell's poke.
    function test_Regression_VolLag_BuyThenSellWithUnchangedPriceNoProfit() public {
        _resetHistory();
        _flatHistory(60, 60); // calm: sigma decays to minVol 0.2
        assertEq(oracle.getVol(ASSET), 0.2e18, "calm vol");

        uint256 id = _createStrike(2080e18, 3600); // 4% OTM UP strike
        skip(30);
        _setPrice(2040e8); // +2% 30s after the last observation
        (uint256 cost, uint256 proceeds, uint256 s0, uint256 s1) = _roundTrip(id, true, 10_000e6, 30);
        console2.log("sigma buy/sell", s0, s1);
        console2.log("cost/proceeds ", cost, proceeds);
        assertGt(s0, 0.2e18, "jump is in sigma at the buy");
        assertLe(proceeds, cost, "round trip with unchanged oracle price must not profit");
    }

    /// @notice 0.5% jump on a 15m market, either side, after a noisy baseline.
    function test_Regression_VolLag_HalfPercentMoveRoundTripNoProfit() public {
        for (uint256 side; side < 2; ++side) {
            uint256 snap = vm.snapshotState();
            _resetHistory();
            _noisyHistory(100, 50); // +-0.05% per minute
            uint256 id = _createStrike(2020e18, 900);
            skip(30);
            _setPrice(2010e8);
            (uint256 cost, uint256 proceeds, uint256 s0, uint256 s1) = _roundTrip(id, side == 0, 10_000e6, 30);
            console2.log("sigma buy/sell", s0, s1);
            assertLe(proceeds, cost, "round trip with unchanged oracle price must not profit");
            vm.revertToState(snap);
        }
    }

    /// @notice The old 32-sample window let a large return fall out on a predictable poke and
    ///         collapse sigma. With the EWMA one observation changes sigma by at most a factor
    ///         sqrt(LAMBDA) when the price is unchanged, far below the round-trip edge.
    function test_Regression_VolLag_NoPredictableEvictionCliff() public {
        _resetHistory();
        _setPrice(2000e8);
        oracle.poke(ASSET);
        skip(60);
        _setPrice(2040e8);
        oracle.poke(ASSET); // one +2% return
        _flatHistory(30, 60);
        uint256 id = _createStrike(2000e18, 3600); // UP is ITM and gains from a lower sigma
        skip(30);
        _refresh();
        (uint256 cost, uint256 proceeds, uint256 s0, uint256 s1) = _roundTrip(id, true, 10_000e6, 30);
        console2.log("sigma buy/sell", s0, s1);
        console2.log("cost/proceeds ", cost, proceeds);
        assertGe(s1 * 1e9 / s0, 969e6, "at most one sqrt(0.94) step per observation");
        assertLe(proceeds, cost, "round trip with unchanged oracle price must not profit");
    }

    /// @notice Deployed ETH bounds (0.40 / 2.0, default 0.75), a ~0.07%/min baseline, the keeper's
    ///         ATM market (strike = spot), a jump 20s after the last observation, a sell 40s later at
    ///         the same price. Before the fix a 0.5% jump on a 15m market returned about +53%.
    function test_Regression_VolLag_RealisticEthBoundsNoProfit() public {
        int256[3] memory jumps = [int256(30), 50, 100];
        uint32[3] memory durs = [uint32(300), 900, 3600];
        for (uint256 j; j < 3; ++j) {
            for (uint256 d; d < 3; ++d) {
                for (uint256 side; side < 2; ++side) {
                    uint256 snap = vm.snapshotState();
                    oracle.setFeed(ASSET, address(agg), 3600, 0.4e18, 2.0e18, 0.75e18);
                    _noisyHistory(100, 70);
                    uint256 id = _createStrike(0, durs[d]);
                    skip(20);
                    _setPrice(2000e8 + 2000e8 * jumps[j] / 10_000);
                    Q memory q = _q(id);
                    if ((side == 0 ? q.buyUp : q.buyDown) != 0) {
                        (uint256 cost, uint256 proceeds,,) = _roundTrip(id, side == 0, 10_000e6, 40);
                        assertLe(proceeds, cost, "realistic vol-lag round trip must not profit");
                    }
                    vm.revertToState(snap);
                }
            }
        }
    }

    /// @notice VOL-GLIDE: with a fixed-LAMBDA EWMA a jump's variance weight fell as 1/dt, so
    ///         buying right after a jump and selling 100-120s later with no poke in between
    ///         (the sell's own poke records the jump with the longer dt) let sigma glide down in
    ///         the attacker's favor. LAMBDA^(dt/60) keeps the jump's weight nearly constant.
    function test_Regression_VolGlide_JumpThenWaitWithoutPokeNoProfit() public {
        uint256[2] memory holds = [uint256(100), 120];
        int256[3] memory jumps = [int256(50), 100, 200];
        for (uint256 h; h < 2; ++h) {
            for (uint256 j; j < 3; ++j) {
                for (uint256 side; side < 2; ++side) {
                    uint256 snap = vm.snapshotState();
                    oracle.setFeed(ASSET, address(agg), 3600, 0.4e18, 2.0e18, 0.75e18);
                    _noisyHistory(100, 30); // calm: +-0.03% per minute
                    uint256 id = _createStrike(0, 900);
                    skip(5); // jump just after the last observation
                    _setPrice(2000e8 + 2000e8 * jumps[j] / 10_000);
                    Q memory q = _q(id);
                    if ((side == 0 ? q.buyUp : q.buyDown) != 0) {
                        (uint256 cost, uint256 proceeds, uint256 s0, uint256 s1) =
                            _roundTrip(id, side == 0, 10_000e6, holds[h]);
                        assertGe(s1 * 1e9 / s0, 0.9e9, "sigma does not glide after the jump");
                        assertLe(proceeds, cost, "jump, wait without poke, sell must not profit");
                    }
                    vm.revertToState(snap);
                }
            }
        }
    }

    // ======================================================================
    // 2. EDGE-CLAMP-1: the edge cannot go below the 1% the fair clamps need.
    // ======================================================================

    function test_Regression_LowEdge_SetEdgeBelowOnePercentReverts() public {
        vm.prank(owner);
        vm.expectRevert(PredictionMarket.InvalidParameter.selector);
        pm.setEdge(0.005e18);
    }

    /// @notice At the minimum edge a near-certain outcome is not buyable below 0.99 and the dead
    ///         side sells at the 0.01 floor, so neither clamp strategy pays.
    function test_Regression_MinEdge_ClampAndFloorNotExploitable() public {
        vm.prank(owner);
        pm.setEdge(0.01e18);
        uint256 id = _create(300);
        uint256 units = 10_000e6;
        uint256 b0 = usdc.balanceOf(attacker);
        _buy(attacker, id, true, units);
        _buy(attacker, id, false, units);
        uint256 paid = b0 - usdc.balanceOf(attacker);
        _setPrice(2100e8); // DOWN becomes worthless
        vm.warp(_expiry(id) - 20);
        _refresh();
        Q memory q = _q(id);
        assertEq(q.fairUp, 0.98e18);
        assertEq(q.buyUp, 0, "near-certain UP not buyable at the minimum edge");
        assertEq(q.sellDown, 0.01e18, "dead side sells at 0.01 floor");
        vm.prank(attacker);
        pm.sell(id, false, units, 0);
        _settleWith(id, 2100e8, 1);
        vm.prank(attacker);
        pm.claim(id);
        assertLe(usdc.balanceOf(attacker) - (b0 - paid), paid, "no riskless profit from buying both sides");
    }

    /// @notice At the default 2% edge the same strategies lose money.
    function test_DefaultEdge_ClampAndFloorNotExploitable() public {
        uint256 id = _create(300);
        uint256 units = 10_000e6;
        uint256 b0 = usdc.balanceOf(attacker);
        _buy(attacker, id, true, units);
        _buy(attacker, id, false, units);
        uint256 paid = b0 - usdc.balanceOf(attacker);
        _setPrice(2100e8);
        vm.warp(_expiry(id) - 20);
        _refresh();
        Q memory q = _q(id);
        assertEq(q.buyUp, 0, "near-certain UP not buyable at default edge");
        assertEq(q.sellDown, 0.01e18, "dead side sells at 0.01 floor");
        vm.prank(attacker);
        pm.sell(id, false, units, 0);
        _settleWith(id, 2100e8, 1);
        vm.prank(attacker);
        pm.claim(id);
        assertLt(usdc.balanceOf(attacker) - (b0 - paid), paid);
    }

    // ======================================================================
    // 3. Settlement round selection.
    // ======================================================================

    /// @notice Proving the first round at/after expiry only needs the predecessor's id and
    ///         timestamp; an invalid (non-positive) answer before expiry must not block it.
    function test_Regression_InvalidRoundBeforeExpiryDoesNotBlockSettlement() public {
        uint256 id = _create(300);
        _buy(alice, id, true, 100e6);
        uint256 e = _expiry(id);
        vm.warp(e - 5);
        agg.setPrice(0); // mock explicitly allows invalid answers
        vm.warp(e + 10);
        agg.setPrice(2010e8);
        uint80 first = agg.latestRoundId();
        pm.settle(id, first);
        assertEq(pm.getMarket(id).status, 1);
        assertTrue(pm.getMarket(id).upWon);
    }

    /// @notice Documented fail-closed behavior: when the first round at/after expiry is itself
    ///         invalid, no later round can prove it is the earliest, and the market voids after
    ///         the void delay with cost-basis refunds.
    function test_InvalidFirstRoundAfterExpiryVoidsWithRefunds() public {
        uint256 id = _create(300);
        _buy(alice, id, true, 100e6);
        (,, uint256 cost,) = pm.getPosition(id, alice);
        uint256 e = _expiry(id);
        vm.warp(e + 1);
        agg.setPrice(0);
        uint80 invalid = agg.latestRoundId();
        vm.warp(e + 30);
        agg.setPrice(2010e8);
        uint80 valid = agg.latestRoundId();
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        pm.settle(id, invalid);
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        pm.settle(id, valid);
        vm.warp(e + 24 hours);
        pm.voidMarket(id);
        uint256 b0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pm.claim(id);
        assertEq(usdc.balanceOf(alice) - b0, cost);
    }

    function test_Settlement_EqualTimestampsOnlyFirstAccepted() public {
        uint256 id = _create(300);
        uint256 e = _expiry(id);
        vm.warp(e - 40);
        _refresh();
        vm.warp(e);
        agg.setPrice(1990e8);
        uint80 a = agg.latestRoundId();
        agg.setPrice(2050e8); // same block, same timestamp
        uint80 b = agg.latestRoundId();
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        pm.settle(id, b);
        pm.settle(id, a);
        assertFalse(pm.getMarket(id).upWon);
        assertEq(pm.getMarket(id).settlePrice, 1990e18);
    }

    /// @notice A caller can never choose between rounds: at most one round id is
    ///         accepted, and it is the first with updatedAt >= expiry.
    function testFuzz_Settlement_AtMostOneRoundAccepted(uint256 seed) public {
        uint256 e = block.timestamp + 300;
        vm.warp(e - 200);
        for (uint256 i; i < 14; ++i) {
            uint256 dt = uint256(keccak256(abi.encode(seed, i))) % 60; // includes 0 (same block)
            skip(dt);
            // occasionally publish an invalid answer
            int256 p = int256(1900e8 + (uint256(keccak256(abi.encode(seed, i, "p"))) % 200e8));
            agg.setPrice(uint256(keccak256(abi.encode(seed, i, "z"))) % 7 == 0 ? int256(0) : p);
        }
        skip(1);
        uint80 latest = agg.latestRoundId();
        uint80 expected;
        bool expectedValid;
        for (uint80 r = 1; r <= latest; ++r) {
            (, int256 answer,, uint256 t,) = agg.getRoundData(r);
            if (t >= e) {
                expected = r;
                expectedValid = answer > 0;
                break;
            }
        }
        uint256 accepted;
        uint80 which;
        for (uint80 r = 1; r <= latest; ++r) {
            try oracle.settlementPrice(ASSET, r, e) returns (uint256) {
                ++accepted;
                which = r;
            } catch {}
        }
        assertLe(accepted, 1, "caller could choose among rounds");
        if (expected != 0 && expectedValid) {
            assertEq(accepted, 1, "first round after expiry must settle");
            assertEq(which, expected);
        } else {
            assertEq(accepted, 0, "no round settles when the first round after expiry is invalid");
        }
    }

    function test_Settlement_RoundAtExactlyExpirySettlesSameBlock() public {
        uint256 id = _create(300);
        _buy(alice, id, false, 100e6);
        vm.warp(_expiry(id));
        _setPrice(SPOT8); // equals strike -> DOWN
        pm.settle(id, agg.latestRoundId());
        assertFalse(pm.getMarket(id).upWon);
    }

    // ======================================================================
    // 4. Oracle adapter: realized volatility.
    // ======================================================================

    /// @dev Converged EWMA of 0.1% returns every 120s:
    ///      sigma = ln(1.001) * sqrt(31_536_000 / 120) = 0.000999500 * 512.6402 = 0.51239.
    function test_GetVol_AnnualizationMatchesAnalytic() public {
        _resetHistory();
        for (uint256 i; i < 200; ++i) {
            skip(120);
            _setPrice(i % 2 == 0 ? int256(2000e8) : int256(2002e8));
            oracle.poke(ASSET);
        }
        skip(120);
        _setPrice(2000e8); // next return, provisional
        assertApproxEqRel(oracle.getVol(ASSET), 0.51239e18, 0.001e18);
    }

    function test_GetVol_IdenticalPricesClampToMin() public {
        _resetHistory();
        _flatHistory(60, 60);
        assertEq(oracle.getVol(ASSET), 0.2e18);
    }

    /// @dev After one large return, flat observations shrink sigma smoothly, one sqrt(LAMBDA)
    ///      factor per observation, never in a cliff.
    function test_GetVol_DecaysSmoothlyAfterLargeReturn() public {
        _resetHistory();
        _flatHistory(1, 60);
        _setPrice(2200e8);
        _flatHistory(1, 60);
        uint256 prev = oracle.getVol(ASSET);
        assertGe(prev, 2.9e18, "one 10% return saturates the variance at maxVol^2");
        for (uint256 i; i < 60; ++i) {
            _flatHistory(1, 60);
            uint256 v = oracle.getVol(ASSET);
            assertLe(v, prev);
            assertGe(v * 1e9 / prev, 969e6, "no step larger than sqrt(0.94)");
            prev = v;
        }
    }

    function test_Poke_RateLimitBoundaryAt60s() public {
        _resetHistory();
        oracle.poke(ASSET);
        assertEq(oracle.getObservationCount(ASSET), 1);
        skip(59);
        _refresh();
        oracle.poke(ASSET);
        assertEq(oracle.getObservationCount(ASSET), 1);
        skip(1);
        oracle.poke(ASSET);
        assertEq(oracle.getObservationCount(ASSET), 2);
    }

    function test_Normalize_HighDecimalsDustReverts() public {
        MockAggregator a = new MockAggregator(address(this), 36, "X");
        a.setPrice(1e17); // < 1e18 -> normalizes to zero
        oracle.setFeed(7, address(a), 3600, 0.2e18, 3e18, 0.8e18);
        vm.expectRevert(PriceOracleAdapter.InvalidNormalizedPrice.selector);
        oracle.getPrice(7);
        a.setPrice(2000e36);
        (uint256 p,) = oracle.getPrice(7);
        assertEq(p, 2000e18);
    }

    function test_Normalize_ZeroDecimals() public {
        MockAggregator a = new MockAggregator(address(this), 0, "X");
        a.setPrice(2000);
        oracle.setFeed(8, address(a), 3600, 0.2e18, 3e18, 0.8e18);
        (uint256 p,) = oracle.getPrice(8);
        assertEq(p, 2000e18);
    }

    // ======================================================================
    // 5. MockAggregator semantics.
    // ======================================================================

    function test_Mock_UnknownRoundsRevert() public {
        vm.expectRevert(bytes("No data present"));
        agg.getRoundData(0);
        uint80 latest = agg.latestRoundId();
        vm.expectRevert(bytes("No data present"));
        agg.getRoundData(latest + 1);
        MockAggregator fresh = new MockAggregator(address(this), 8, "X");
        vm.expectRevert(bytes("No data present"));
        fresh.latestRoundData();
    }

    // ======================================================================
    // 6. Orders.
    // ======================================================================

    function test_Execute_AtSellFloorPaysOnePercent() public {
        uint256 id = _create(300);
        _buy(alice, id, true, 1_000e6);
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        _setPrice(1800e8); // fair UP clamps to 0.02 -> sell floor 0.01
        uint256 b0 = usdc.balanceOf(alice);
        vm.prank(keeper);
        pm.executeOrder(id, alice, true);
        assertEq(usdc.balanceOf(alice) - b0, 10e6);
        (uint256 up,,,) = pm.getPosition(id, alice);
        assertEq(up, 0);
    }

    function test_Order_SurvivesPartialSellAndRebuy_ExecutesWholePosition() public {
        uint256 id = _create(900);
        _buy(alice, id, true, 1_000e6);
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 2100e18);
        _refresh();
        vm.prank(alice);
        pm.sell(id, true, 400e6, 0);
        _buy(alice, id, true, 250e6);
        PredictionMarket.Order memory o = pm.getOrder(id, alice, true);
        assertEq(o.stopPrice, 1990e18);
        _setPrice(2100e8);
        vm.prank(keeper);
        pm.executeOrder(id, alice, true);
        (uint256 up,,,) = pm.getPosition(id, alice);
        assertEq(up, 0);
    }

    /// @dev Documents current semantics: a live order whose trigger is already crossed
    ///      sweeps units bought afterwards; anyone can execute right after the re-buy.
    function test_Order_CrossedTriggerSweepsFreshlyBoughtUnits() public {
        uint256 id = _create(900);
        _buy(alice, id, true, 1_000e6);
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        _setPrice(1985e8); // stop crossed, not yet executed
        uint256 b0 = usdc.balanceOf(alice);
        _buy(alice, id, true, 5_000e6); // averaging down
        uint256 paid = b0 - usdc.balanceOf(alice);
        vm.prank(attacker);
        pm.executeOrder(id, alice, true); // same block
        uint256 back = usdc.balanceOf(alice) - (b0 - paid);
        (uint256 up,,,) = pm.getPosition(id, alice);
        assertEq(up, 0);
        assertLt(back, paid); // fresh units lose ~2x edge instantly
    }

    function test_Execute_StalePriceReverts() public {
        uint256 id = _create(900);
        _buy(alice, id, true, 1_000e6);
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        _setPrice(1980e8);
        skip(121); // older than maxTradeStaleness
        vm.prank(keeper);
        vm.expectRevert(PriceOracleAdapter.StalePrice.selector);
        pm.executeOrder(id, alice, true);
    }

    function test_Execute_TinyPositionZeroProceedsStillClears() public {
        uint256 id = _create(300);
        _buy(alice, id, true, 50);
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        _setPrice(1800e8);
        uint256 b0 = usdc.balanceOf(alice);
        vm.prank(attacker);
        pm.executeOrder(id, alice, true);
        assertEq(usdc.balanceOf(alice), b0); // floor(50 * 0.01) = 0
        (uint256 up,,,) = pm.getPosition(id, alice);
        assertEq(up, 0);
    }

    // ======================================================================
    // 7. Sell-back and void-refund liquidity under dust sells (fuzz).
    // ======================================================================

    function testFuzz_DustSellsThenLpDrainThenVoidAllClaimsPay(uint256 seed) public {
        uint256 id = _create(900);
        uint256 a = 1e6 + (seed % 5_000e6);
        uint256 b = 1e6 + ((seed >> 64) % 5_000e6);
        _buy(alice, id, true, a);
        _buy(bob, id, false, b);
        _buy(alice, id, false, 1 + ((seed >> 128) % 1_000e6));
        // dust sells round the basis down and keep more cost than units warrant
        for (uint256 i; i < 25; ++i) {
            uint256 k = 1 + (uint256(keccak256(abi.encode(seed, i))) % 7);
            (uint256 up,,,) = pm.getPosition(id, alice);
            if (up <= k) break;
            _refresh();
            vm.prank(alice);
            pm.sell(id, true, k, 0);
        }
        // LP withdraws everything it can (the last LP keeps MIN_RESIDUAL_SHARES while exposed)
        uint256 maxShares = pm.shares(lp) - pm.MIN_RESIDUAL_SHARES();
        uint256 free = pm.freeLiquidity();
        uint256 s = maxShares;
        while (s > 0 && pm.previewWithdraw(s) > free) s = s * 99 / 100;
        if (s > 0 && pm.previewWithdraw(s) > 0) {
            vm.prank(lp);
            pm.withdraw(s, 0);
        }
        // remaining sell-backs still possible
        _refresh();
        (uint256 aUp,,,) = pm.getPosition(id, alice);
        if (aUp > 1) {
            vm.prank(alice);
            pm.sell(id, true, aUp / 2, 0);
        }
        // void and every claim pays
        vm.warp(_expiry(id) + 24 hours);
        pm.voidMarket(id);
        vm.prank(alice);
        pm.claim(id);
        vm.prank(bob);
        pm.claim(id);
        assertEq(pm.unclaimedPayouts(), 0);
        _assertSolvent();
    }

    // ======================================================================
    // 8. Owner parameter changes mid-market.
    // ======================================================================

    function test_SetFeedMidMarket_ResetsVolAndMarketStillSettles() public {
        uint256 id = _create(900);
        _buy(alice, id, true, 100e6);
        MockAggregator n = new MockAggregator(address(this), 8, "ETH2");
        n.setPrice(2000e8);
        oracle.setFeed(ASSET, address(n), 3600, 0.2e18, 3e18, DEFAULT_VOL);
        assertEq(oracle.getVol(ASSET), DEFAULT_VOL);
        vm.warp(_expiry(id) + 5);
        n.setPrice(2010e8);
        pm.settle(id, n.latestRoundId());
        assertTrue(pm.getMarket(id).upWon);
    }

    // ======================================================================
    // 9. LIVE-1: oracle age guard near expiry.
    // ======================================================================

    /// @notice 16s before expiry a 44s-old price used to be quoted as current (about 0.52 for a
    ///         side worth about 0.93 to a trader watching the exchange). Trading now needs
    ///         oracle age * ORACLE_AGE_RATIO <= timeLeft.
    function test_Regression_OracleTooOldForTimeLeftBlocksTrading() public {
        uint256 id = _create(300);
        _buy(alice, id, true, 100e6);
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        uint256 e = _expiry(id);
        vm.warp(e - 60);
        _refresh(); // last heartbeat
        vm.warp(e - 16); // age 44s, 16s left
        Q memory q = _q(id);
        assertGt(q.fairUp, 0, "fair stays available");
        assertGt(q.spot, 0);
        assertGt(q.sigma, 0);
        assertEq(q.timeLeft, 16);
        assertEq(q.buyUp, 0);
        assertEq(q.buyDown, 0);
        assertEq(q.sellUp, 0);
        assertEq(q.sellDown, 0);
        vm.prank(bob);
        vm.expectRevert(PredictionMarket.OracleTooOldForExpiry.selector);
        pm.buy(id, true, 1e6, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.OracleTooOldForExpiry.selector);
        pm.sell(id, true, 1e6, 0); // the 0.01 sell floor alone would not stop it
        vm.prank(keeper);
        vm.expectRevert(PredictionMarket.OracleTooOldForExpiry.selector);
        pm.executeOrder(id, alice, true);
        // a fresh price clears the guard
        _setPrice(1980e8);
        vm.prank(keeper);
        pm.executeOrder(id, alice, true);
        (uint256 up,,,) = pm.getPosition(id, alice);
        assertEq(up, 0);
    }

    function test_Regression_OracleAgeBoundaryIsInclusive() public {
        uint256 id = _create(900);
        _buy(alice, id, true, 100e6);
        uint256 e = _expiry(id);
        vm.warp(e - 100);
        _refresh();
        vm.warp(e - 80); // age 20s, 80s left: 20 * 4 == 80 is allowed
        assertGt(_q(id).sellUp, 0);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        pm.sell(id, true, 50e6, 0);
        vm.revertToState(snap);
        vm.warp(e - 79); // age 21s, 79s left: 84 > 79
        assertEq(_q(id).sellUp, 0);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.OracleTooOldForExpiry.selector);
        pm.sell(id, true, 50e6, 0);
    }
}
