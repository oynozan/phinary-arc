// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/Test.sol";
import {ArcForkBase} from "./ArcForkBase.sol";
import {PredictionMarket} from "../../PredictionMarket.sol";
import {PriceOracleAdapter} from "../../PriceOracleAdapter.sol";

/// @notice Full user flows on an Arc Testnet fork against contracts built from the current
///         sources, wired to the real USDC proxy/implementation (native-coin precompile stubbed)
///         and the live mock feeds. Run with:
///         forge test --match-path 'contracts/test-integration/*' -vv
contract FreshDeploymentFlowsForkTest is ArcForkBase {
    uint256 internal constant WAD = 1e18;
    address internal alice = makeAddr("fork-alice");
    address internal bob = makeAddr("fork-bob");
    address internal lp = makeAddr("fork-lp");
    address internal rando = makeAddr("fork-rando");

    struct Q {
        uint256 fairUp;
        uint256 buyUp;
        uint256 sellUp;
        uint256 buyDown;
        uint256 sellDown;
        uint256 spot;
        uint256 sigma;
        uint256 timeLeft;
    }

    function setUp() public {
        _fork();
        for (uint8 a; a < 3; ++a) _refresh(a);
        _deployFresh(10_000e6);
        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        _fund(lp, 10_000e6);
        _fund(rando, 10e6);
    }

    function _q(uint256 id) internal view returns (Q memory q) {
        (q.fairUp, q.buyUp, q.sellUp, q.buyDown, q.sellDown, q.spot, q.sigma, q.timeLeft) = pm.quote(id);
    }

    function _ceil(uint256 units, uint256 price) internal pure returns (uint256) {
        return (units * price + WAD - 1) / WAD;
    }

    function _create(address who, uint8 asset, uint256 strike, uint32 dur) internal returns (uint256 id) {
        _refresh(asset);
        vm.prank(who);
        id = pm.createMarket(asset, strike, dur);
    }

    function _settleAt(uint256 id, int256 answer, uint256 delta) internal returns (uint80 r) {
        PredictionMarket.Market memory m = pm.getMarket(id);
        vm.warp(uint256(m.expiry) + delta);
        r = _push(m.assetId, answer);
        pm.settle(id, r);
    }

    function _bufferAndSolvency(string memory tag) internal view {
        _assertSolvent(tag);
        assertGe(pm.totalAssets(), pm.freeLiquidity(), tag);
    }

    // ---------------------------------------------------------------------
    // (2) Full flows as fresh users on the fork
    // ---------------------------------------------------------------------

    function test_Fork_BuySellSettleClaim_Up() public {
        uint256 id = _create(alice, 0, 0, 300);
        PredictionMarket.Market memory m = pm.getMarket(id);
        assertEq(m.strike, uint256(_latest(0)) * 1e10);

        oracle.poke(0); // record this block's observation first so the quote matches execution
        Q memory q = _q(id);
        assertGt(q.buyUp, 0);
        uint256 units = 10e6;
        uint256 expectCost = _ceil(units, q.buyUp);
        uint256 before = usdc.balanceOf(alice);
        uint256 pmBefore = usdc.balanceOf(address(pm));
        vm.prank(alice);
        uint256 g = gasleft();
        pm.buy(id, true, units, expectCost);
        console2.log("buy gas", g - gasleft());
        assertEq(before - usdc.balanceOf(alice), expectCost, "cost");
        assertEq(usdc.balanceOf(address(pm)) - pmBefore, expectCost, "pm received");
        _bufferAndSolvency("after buy");

        // sell 40%
        skip(10);
        _refresh(0);
        q = _q(id);
        uint256 sellUnits = 4e6;
        uint256 expectProceeds = sellUnits * q.sellUp / WAD;
        before = usdc.balanceOf(alice);
        vm.prank(alice);
        pm.sell(id, true, sellUnits, expectProceeds);
        assertEq(usdc.balanceOf(alice) - before, expectProceeds, "proceeds");
        (uint256 upU,,,) = pm.getPosition(id, alice);
        assertEq(upU, 6e6);
        _bufferAndSolvency("after sell");

        // settle UP with a price above strike
        int256 above = int256(m.strike / 1e10) + 100e8;
        _settleAt(id, above, 3);
        m = pm.getMarket(id);
        assertEq(m.status, 1);
        assertTrue(m.upWon);
        before = usdc.balanceOf(alice);
        vm.prank(alice);
        pm.claim(id);
        assertEq(usdc.balanceOf(alice) - before, 6e6, "claim pays units");
        _bufferAndSolvency("after claim");
    }

    function test_Fork_TieResolvesDown_AndLoserCannotClaim() public {
        uint256 id = _create(alice, 1, 0, 900);
        uint256 strike = pm.getMarket(id).strike;
        vm.prank(alice);
        pm.buy(id, true, 2e6, type(uint256).max);
        vm.prank(bob);
        pm.buy(id, false, 3e6, type(uint256).max);
        _settleAt(id, int256(strike / 1e10), 1);
        assertFalse(pm.getMarket(id).upWon);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        pm.claim(id);
        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        pm.claim(id);
        assertEq(usdc.balanceOf(bob) - before, 3e6);
    }

    function test_Fork_SettleRejectsWrongRounds() public {
        uint256 id = _create(alice, 2, 0, 300);
        vm.prank(alice);
        pm.buy(id, false, 1e6, type(uint256).max);
        PredictionMarket.Market memory m = pm.getMarket(id);
        uint80 beforeExpiry = _feed(2).latestRoundId();
        vm.warp(uint256(m.expiry) + 2);
        uint80 first = _push(2, _latest(2));
        skip(5);
        uint80 second = _push(2, _latest(2) + 1e8);
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        pm.settle(id, beforeExpiry);
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        pm.settle(id, second);
        vm.expectRevert(); // MockAggregator "No data present"
        pm.settle(id, second + 1);
        pm.settle(id, first);
        assertEq(pm.getMarket(id).settlePrice, uint256(_latest(2) - 1e8) * 1e10);
    }

    function test_Fork_StopLossExecutedByAnyone() public {
        uint256 id = _create(alice, 0, 0, 3600);
        uint256 strike = pm.getMarket(id).strike;
        vm.prank(alice);
        pm.buy(id, true, 5e6, type(uint256).max);
        uint256 stop = strike - strike / 200; // -0.5%
        vm.prank(alice);
        pm.setOrder(id, true, stop, 0);
        skip(30);
        _push(0, int256(stop / 1e10) - 1e8);
        Q memory pre = _q(id);
        // executeOrder pokes the oracle first; a new observation of the drop can change sigma.
        oracle.poke(0);
        Q memory q = _q(id);
        console2.log("sigma before poke", pre.sigma);
        console2.log("sigma after poke ", q.sigma);
        console2.log("sellUp before/after", pre.sellUp, q.sellUp);
        uint256 expectProceeds = 5e6 * q.sellUp / WAD;
        uint256 before = usdc.balanceOf(alice);
        uint256 randoBefore = usdc.balanceOf(rando);
        vm.prank(rando);
        pm.executeOrder(id, alice, true);
        assertEq(usdc.balanceOf(alice) - before, expectProceeds, "owner paid");
        assertEq(usdc.balanceOf(rando), randoBefore, "keeper not paid");
        (uint256 upU,,,) = pm.getPosition(id, alice);
        assertEq(upU, 0);
        PredictionMarket.Order memory o = pm.getOrder(id, alice, true);
        assertEq(o.stopPrice, 0);
        _bufferAndSolvency("after order");
    }

    function test_Fork_VoidPathRefundsCost() public {
        uint256 id = _create(alice, 1, 0, 300);
        vm.prank(alice);
        pm.buy(id, true, 3e6, type(uint256).max);
        vm.prank(bob);
        pm.buy(id, false, 2e6, type(uint256).max);
        (,, uint256 aCost,) = pm.getPosition(id, alice);
        (,,, uint256 bCost) = pm.getPosition(id, bob);
        PredictionMarket.Market memory m = pm.getMarket(id);
        vm.warp(uint256(m.expiry) + 24 hours - 1);
        vm.expectRevert(PredictionMarket.VoidTooEarly.selector);
        pm.voidMarket(id);
        skip(1);
        uint256 pendingBefore = pm.unclaimedPayouts();
        pm.voidMarket(id);
        assertEq(pm.unclaimedPayouts() - pendingBefore, aCost + bCost);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pm.claim(id);
        assertEq(usdc.balanceOf(alice) - before, aCost);
        before = usdc.balanceOf(bob);
        vm.prank(bob);
        pm.claim(id);
        assertEq(usdc.balanceOf(bob) - before, bCost);
        _bufferAndSolvency("after void claims");
    }

    function test_Fork_LpDepositWithdrawRoundTrip() public {
        (,,,,,, uint256 sp,) = pm.vaultStats();
        uint256 amount = 100e6;
        uint256 expectShares = pm.previewDeposit(amount);
        vm.prank(lp);
        vm.expectRevert(PredictionMarket.SlippageExceeded.selector);
        pm.deposit(amount, expectShares + 1);
        vm.prank(lp);
        pm.deposit(amount, expectShares);
        assertEq(pm.shares(lp), expectShares);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.DepositLocked.selector, block.timestamp + 1 hours));
        pm.withdraw(expectShares, 0);
        skip(1 hours);
        uint256 out = pm.previewWithdraw(expectShares);
        uint256 before = usdc.balanceOf(lp);
        vm.prank(lp);
        vm.expectRevert(PredictionMarket.SlippageExceeded.selector);
        pm.withdraw(expectShares, out + 1);
        vm.prank(lp);
        pm.withdraw(expectShares, out);
        assertEq(usdc.balanceOf(lp) - before, out);
        // No exposure and no new trades: round trip loses at most rounding dust.
        assertApproxEqAbs(out, amount, 2, "round trip");
        (,,,,,, uint256 sp2,) = pm.vaultStats();
        assertGe(sp2, sp, "share price must not drop");
    }

    function test_Fork_ExposureCappedByVault_SellBackStillWorks() public {
        _fund(alice, 100_000e6);
        uint256 id = _create(alice, 0, 0, 3600);
        uint256 free = pm.freeLiquidity();
        // Buying a payout far larger than the vault must revert.
        Q memory q = _q(id);
        uint256 huge = (free * WAD) / (WAD - q.buyUp) * 3;
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.InsufficientVaultLiquidity.selector);
        pm.buy(id, true, huge, type(uint256).max);
        // Fill nearly all capacity on one side with a binary search for the max size.
        uint256 lo = 1;
        uint256 hi = huge;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            uint256 snap = vm.snapshotState();
            vm.prank(alice);
            (bool ok,) = address(pm).call(abi.encodeCall(PredictionMarket.buy, (id, true, mid, type(uint256).max)));
            vm.revertToState(snap);
            if (ok) lo = mid;
            else hi = mid - 1;
        }
        vm.prank(alice);
        pm.buy(id, true, lo, type(uint256).max);
        console2.log("max UP units with vault", lo);
        _bufferAndSolvency("max exposure");
        // Opposite side is now cheap to take and must still be possible to sell back.
        vm.prank(bob);
        pm.buy(id, false, 1e6, type(uint256).max);
        skip(60);
        _refresh(0);
        vm.prank(alice);
        pm.sell(id, true, lo, 0);
        vm.prank(bob);
        pm.sell(id, false, 1e6, 0);
        _bufferAndSolvency("after unwinds");
        assertEq(pm.totalLocked(), 0);
    }

    function test_Fork_CustomStrikeBandAndDurations() public {
        uint256 spot = uint256(_latest(0)) * 1e10;
        uint256 dev = spot / 10;
        _refresh(0);
        vm.prank(alice);
        pm.createMarket(0, spot + dev, 300);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.InvalidStrike.selector);
        pm.createMarket(0, spot + dev + 1e18, 300);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        pm.createMarket(0, 0, 600);
    }

    function test_Fork_StaleFeedBlocksTradingButNotExits() public {
        uint256 id = _create(alice, 0, 0, 3600);
        vm.prank(alice);
        pm.buy(id, true, 1e6, type(uint256).max);
        skip(121);
        vm.prank(alice);
        vm.expectRevert(PriceOracleAdapter.StalePrice.selector);
        pm.buy(id, true, 1e6, type(uint256).max);
        // Sell also needs a fresh oracle (documented: exits use oracle pricing).
        vm.prank(alice);
        vm.expectRevert(PriceOracleAdapter.StalePrice.selector);
        pm.sell(id, true, 1e6, 0);
        _refresh(0);
        vm.prank(alice);
        pm.sell(id, true, 1e6, 0);
    }

    /// @dev Pause blocks new risk but exits (sell, claim, withdraw, cancel) keep working.
    function test_Fork_PausedExitsWork() public {
        uint256 id = _create(alice, 0, 0, 900);
        vm.prank(alice);
        pm.buy(id, true, 1e6, type(uint256).max);
        uint256 strike = pm.getMarket(id).strike;
        vm.prank(alice);
        pm.setOrder(id, true, strike / 2, 0);
        vm.prank(KEEPER);
        pm.pause();
        vm.prank(bob);
        vm.expectRevert();
        pm.buy(id, true, 1e6, type(uint256).max);
        vm.prank(alice);
        pm.cancelOrder(id, true);
        vm.prank(alice);
        pm.sell(id, true, 1e6, 0);
        vm.prank(KEEPER);
        pm.unpause();
    }

    // ---------------------------------------------------------------------
    // Fuzz: random multi-user trading on the fork, then settle and drain.
    // ---------------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 24
    function testFuzz_Fork_RandomTradingStaysSolvent(uint256 seed) public {
        uint256 id = _create(alice, uint8(seed % 3), 0, 900);
        uint8 asset = pm.getMarket(id).assetId;
        address[3] memory us = [alice, bob, lp];
        uint256 assetsBefore = pm.totalAssets();
        for (uint256 step; step < 12; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address u = us[r % 3];
            bool up = (r >> 8) % 2 == 0;
            skip(5 + (r >> 16) % 40);
            int256 p = _latest(asset);
            int256 move = int256(uint256((r >> 32) % 41)) - 20; // -20..+20 bps
            _push(asset, p + p * move / 10_000);
            if ((r >> 64) % 3 != 0) {
                uint256 units = 1e5 + (r >> 80) % 5e6;
                vm.prank(u);
                try pm.buy(id, up, units, type(uint256).max) {} catch {}
            } else {
                (uint256 upU, uint256 downU,,) = pm.getPosition(id, u);
                uint256 held = up ? upU : downU;
                if (held > 0) {
                    vm.prank(u);
                    pm.sell(id, up, held / 2 + 1 > held ? held : held / 2 + 1, 0);
                }
            }
            _bufferAndSolvency("step");
        }
        PredictionMarket.Market memory m = pm.getMarket(id);
        int256 settle = (seed >> 128) % 2 == 0 ? int256(m.strike / 1e10) + 1 : int256(m.strike / 1e10);
        _settleAt(id, settle, 1);
        for (uint256 i; i < 3; ++i) {
            (uint256 upU, uint256 downU,,) = pm.getPosition(id, us[i]);
            uint256 owed = pm.getMarket(id).upWon ? upU : downU;
            if (owed == 0) continue;
            uint256 b = usdc.balanceOf(us[i]);
            vm.prank(us[i]);
            pm.claim(id);
            assertEq(usdc.balanceOf(us[i]) - b, owed);
        }
        _bufferAndSolvency("end");
        assertEq(pm.totalLocked(), 0);
        // House edge: without deposits, LP assets change only through this market.
        console2.log("LP pnl (signed, raw)", int256(pm.totalAssets()) - int256(assetsBefore));
    }
}
