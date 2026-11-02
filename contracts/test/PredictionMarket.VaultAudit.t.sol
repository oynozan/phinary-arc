// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PMTestBase} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";

/// @dev Vault/accounting audit: LP timing, sandwiches, donation/inflation, rounding, bookkeeping.
contract VaultAuditTest is PMTestBase {
    uint256 internal constant BUFFER_SLOT = 15; // _voidRefundBuffer (forge inspect storage-layout)

    address internal victim = makeAddr("victim");

    function setUp() public override {
        super.setUp();
        usdc.mint(victim, 10_000_000e6);
        vm.prank(victim);
        usdc.approve(address(pm), type(uint256).max);
    }

    function _buffer() internal view returns (uint256) {
        return uint256(vm.load(address(pm), bytes32(BUFFER_SLOT)));
    }

    function _withdrawAll(address who) internal {
        uint256 s = pm.shares(who);
        vm.prank(who);
        pm.withdraw(s, 0);
    }

    function _assertFullySolvent() internal view {
        assertGe(
            usdc.balanceOf(address(pm)),
            pm.totalLocked() + pm.unclaimedPayouts() + _buffer(),
            "balance < locked + unclaimed + voidBuffer"
        );
    }

    /// @dev Value of `who`'s shares at full NAV once nothing is open (totalAssets based).
    function _navValue(address who) internal view returns (uint256) {
        return pm.shares(who) * (pm.totalAssets() + 1) / (pm.totalShares() + 1000);
    }

    // =====================================================================
    // VAULT-1 withdrawal sandwich: LOW NAV is manipulable, minAmount bounds the payout
    // =====================================================================

    /// @dev Victim LP sends a full withdrawal bounded at 99.5% of the UI quote. A co-LP front-runs
    ///      it by buying both sides of a market (driving LOW NAV toward zero). The bounded
    ///      withdrawal reverts instead of paying ~5%, and the attacker's round trip loses the edge.
    function test_Regression_WithdrawSandwichByCoLpReverts() public {
        vm.prank(victim);
        pm.deposit(100_000e6, 0);
        vm.prank(attacker);
        pm.deposit(100_000e6, 0);
        skip(1 hours + 1);
        _refresh();
        uint256 mid = _create(3600);

        uint256 vs = pm.shares(victim);
        uint256 victimFair = pm.previewWithdraw(vs); // what the UI shows
        assertApproxEqAbs(victimFair, 100_000e6, 2);
        uint256 attackerStart = usdc.balanceOf(attacker);

        // front-run: buy both sides to soak up free liquidity (reserve 1.99u vs cash 1.04u)
        uint256 u = 300_000e6;
        _buy(attacker, mid, true, u);
        _buy(attacker, mid, false, u);
        assertLt(pm.freeLiquidity(), 30_000e6, "free liquidity soaked up");

        // victim's bounded withdrawal lands in between and reverts
        vm.prank(victim);
        vm.expectRevert(PredictionMarket.SlippageExceeded.selector);
        pm.withdraw(vs, victimFair * 995 / 1000);
        assertEq(pm.shares(victim), vs, "victim keeps the shares");

        // back-run: sell both sides back, then exit at full NAV
        _refresh();
        vm.startPrank(attacker);
        pm.sell(mid, true, u, 0);
        pm.sell(mid, false, u, 0);
        pm.withdraw(pm.shares(attacker), 0);
        vm.stopPrank();
        _assertFullySolvent();
        int256 attackerPnl = int256(usdc.balanceOf(attacker)) - int256(attackerStart) - int256(100_000e6);
        assertLe(attackerPnl, 0, "co-LP profited from timing");

        // the victim retries after the attack and gets at least the original quote
        uint256 vb = usdc.balanceOf(victim);
        vm.prank(victim);
        pm.withdraw(vs, victimFair * 995 / 1000);
        assertGe(usdc.balanceOf(victim) - vb, victimFair, "victim earned part of the attacker's edge");
    }

    /// @dev Without an LP stake, a trader can push LOW NAV down before a pending withdrawal;
    ///      minAmount turns the loss into a revert.
    function test_Regression_WithdrawMinAmountBoundsGriefing() public {
        vm.prank(victim);
        pm.deposit(100_000e6, 0);
        skip(1 hours + 1);
        uint256 mid = _create(3600);
        uint256 vs = pm.shares(victim);
        uint256 quoted = pm.previewWithdraw(vs);

        uint256 u = 200_000e6;
        _buy(attacker, mid, true, u);
        _buy(attacker, mid, false, u);

        uint256 current = pm.previewWithdraw(vs);
        assertLt(current, quoted * 99 / 100, "LOW NAV pushed down");
        vm.prank(victim);
        vm.expectRevert(PredictionMarket.SlippageExceeded.selector);
        pm.withdraw(vs, quoted * 995 / 1000);
        // a bound equal to the current preview passes
        uint256 vb = usdc.balanceOf(victim);
        vm.prank(victim);
        pm.withdraw(vs, current);
        assertEq(usdc.balanceOf(victim) - vb, current);
    }

    // =====================================================================
    // VAULT-2 deposit sandwich: HIGH NAV counts trader collateral, minShares bounds the mint
    // =====================================================================

    /// @dev Attacker (an existing LP) inflates HIGH NAV with a large one-sided buy right before a
    ///      victim deposit bounded at 99.5% of the previewed shares. The deposit reverts and the
    ///      attacker's round trip loses the edge.
    function test_Regression_DepositSandwichByExistingLpReverts() public {
        vm.prank(attacker);
        pm.deposit(100_000e6, 0);
        skip(1 hours + 1);
        uint256 mid = _create(3600);
        uint256 attackerStart = usdc.balanceOf(attacker);
        uint256 previewed = pm.previewDeposit(100_000e6); // what the UI shows

        // front-run: one-sided buy, HIGH NAV += cost (liability ignored)
        uint256 u = 400_000e6;
        _buy(attacker, mid, true, u);
        assertLt(pm.previewDeposit(100_000e6), previewed * 99 / 100, "HIGH NAV inflated");

        uint256 vb = usdc.balanceOf(victim);
        vm.prank(victim);
        vm.expectRevert(PredictionMarket.SlippageExceeded.selector);
        pm.deposit(100_000e6, previewed * 995 / 1000);
        assertEq(usdc.balanceOf(victim), vb);
        assertEq(pm.shares(victim), 0);

        // back-run: sell back
        _refresh();
        vm.prank(attacker);
        pm.sell(mid, true, u, 0);
        _assertFullySolvent();
        assertEq(pm.totalLocked(), 0);
        _withdrawAll(attacker);
        int256 attackerPnl = int256(usdc.balanceOf(attacker)) - int256(attackerStart) - int256(100_000e6);
        assertLe(attackerPnl, 0, "existing LP profited from the attempted sandwich");

        // the retried deposit keeps its value
        uint256 minShares = pm.previewDeposit(100_000e6) * 995 / 1000;
        vm.prank(victim);
        pm.deposit(100_000e6, minShares);
        assertGe(_navValue(victim), 99_900e6);
    }

    // =====================================================================
    // VAULT-3 orphaned surplus: the last LP cannot exit fully while reserves are open
    // =====================================================================

    /// @dev The only LP used to be able to exit during exposure at LOW NAV, leaving the reserve
    ///      released at settlement to nobody (or to a few dust shares). Any withdrawal leaving
    ///      fewer than MIN_RESIDUAL_SHARES now reverts. One display share (1e9 units vs 1000
    ///      virtual shares) recovers essentially all of it.
    function test_Regression_LastLpCannotOrphanTheReserve() public {
        uint256 mid = _create(300);
        _buy(alice, mid, true, 20_000e6);
        _buy(bob, mid, false, 20_000e6);

        uint256 s = pm.shares(lp);
        vm.prank(lp);
        vm.expectRevert(PredictionMarket.LastLpWhileExposed.selector);
        pm.withdraw(s, 0);

        vm.prank(lp);
        vm.expectRevert(PredictionMarket.LastLpWhileExposed.selector);
        pm.withdraw(s - 1, 0); // leaving dust shares would hand them the released reserve
        vm.prank(lp);
        vm.expectRevert(PredictionMarket.LastLpWhileExposed.selector);
        pm.withdraw(s - 1e9 + 1, 0);

        uint256 lpb = usdc.balanceOf(lp);
        vm.prank(lp);
        pm.withdraw(s - 1e9, 0); // exactly MIN_RESIDUAL_SHARES (one display share) stays
        assertEq(pm.totalShares(), 1e9);

        _settleWith(mid, SPOT8 + 1e8, 5);
        vm.prank(alice);
        pm.claim(mid);
        assertEq(pm.totalLocked(), 0);
        _withdrawAll(lp); // a full exit is allowed once nothing is reserved
        uint256 lpGot = usdc.balanceOf(lp) - lpb;
        uint256 stuck = usdc.balanceOf(address(pm)) - pm.unclaimedPayouts();
        emit log_named_uint("lp received", lpGot);
        emit log_named_uint("left to virtual shares", stuck);
        assertEq(pm.totalShares(), 0);
        assertLt(stuck, 1e6, "settled surplus stuck in the vault");
    }

    /// @dev Only the last MIN_RESIDUAL_SHARES are protected: another LP can still exit fully while exposed.
    function test_LastLpRule_OnlyBlocksBurningTheWholeSupply() public {
        vm.prank(victim);
        pm.deposit(1_000e6, 0);
        skip(1 hours + 1);
        uint256 mid = _create(300);
        _buy(alice, mid, true, 1_000e6);
        _withdrawAll(victim);
        assertGt(pm.totalShares(), 0);
        // once everything is settled the last LP may leave entirely
        _settleWith(mid, SPOT8 - 1e8, 5);
        _withdrawAll(lp);
        assertEq(pm.totalShares(), 0);
    }

    // =====================================================================
    // LP timing claims that should hold (regression coverage)
    // =====================================================================

    /// @dev Withdrawing right before a vault LOSS (outcome known, settle not yet called) is never
    ///      better than withdrawing just after settlement.
    function testFuzz_WithdrawBeforeLossNeverBeatsAfter(uint256 up, uint256 down, uint256 frac, bool upWins) public {
        up = bound(up, 1e6, 60_000e6);
        down = bound(down, 0, 60_000e6);
        frac = bound(frac, 1, 10_000);
        uint256 mid = _create(300);
        _buy(alice, mid, true, up);
        if (down > 0) _buy(bob, mid, false, down);
        uint256 s = pm.shares(lp) * frac / 10_000;
        if (s == 0) return;
        vm.warp(_expiry(mid) + 5);
        _setPrice(upWins ? SPOT8 + 10e8 : SPOT8 - 10e8);
        uint80 rid = agg.latestRoundId();
        uint256 before = pm.previewWithdraw(s);
        pm.settle(mid, rid);
        uint256 afterSettle = pm.previewWithdraw(s);
        assertLe(before, afterSettle, "pre-settle LOW NAV exceeded post-settle NAV");
    }

    /// @dev Depositing right before a vault-favourable settlement buys no extra value:
    ///      share price (HIGH NAV) never rises at settlement.
    function testFuzz_DepositBeforeSettlementNoGain(uint256 up, uint256 down, bool upWins) public {
        up = bound(up, 1e6, 60_000e6);
        down = bound(down, 1e6, 60_000e6);
        uint256 mid = _create(300);
        _buy(alice, mid, true, up);
        _buy(bob, mid, false, down);
        vm.warp(_expiry(mid) + 5);
        _setPrice(upWins ? SPOT8 + 10e8 : SPOT8 - 10e8);
        uint80 rid = agg.latestRoundId();
        (,,,,,, uint256 hiBefore,) = pm.vaultStats();
        pm.settle(mid, rid);
        (,,,,,, uint256 hiAfter, uint256 loAfter) = pm.vaultStats();
        assertLe(hiAfter, hiBefore, "HIGH NAV rose at settlement");
        assertEq(hiAfter, loAfter);
    }

    /// @dev Deposit then (after lock) withdraw with no trading in between never returns more.
    function testFuzz_RoundTripNeverProfits(uint256 seedAssets, uint256 amt, uint256 donation) public {
        _deployPM();
        seedAssets = bound(seedAssets, 1, 1_000_000e6);
        amt = bound(amt, 1, 1_000_000e6);
        donation = bound(donation, 0, 1_000_000e6);
        vm.prank(lp);
        pm.deposit(seedAssets, 0);
        if (donation > 0) {
            vm.prank(bob);
            usdc.transfer(address(pm), donation);
        }
        uint256 minted = pm.previewDeposit(amt);
        if (minted == 0) return;
        uint256 b0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pm.deposit(amt, 0);
        skip(1 hours);
        uint256 out = pm.previewWithdraw(pm.shares(alice));
        if (out > 0) {
            _withdrawAll(alice);
        }
        assertLe(usdc.balanceOf(alice), b0, "round trip profited");
    }

    /// @dev Classic first-depositor donation (inflation) attack must be unprofitable.
    function testFuzz_DonationInflationUnprofitable(uint256 seed, uint256 donation, uint256 victimAmt) public {
        _deployPM(); // empty vault
        vm.prank(victim);
        usdc.approve(address(pm), type(uint256).max);
        seed = bound(seed, 1, 1e6);
        donation = bound(donation, 1, 10_000_000e6 - 1e6);
        victimAmt = bound(victimAmt, 1, 1_000_000e6);
        uint256 a0 = usdc.balanceOf(attacker);
        vm.prank(attacker);
        pm.deposit(seed, 0);
        vm.prank(attacker);
        usdc.transfer(address(pm), donation);
        uint256 minted = pm.previewDeposit(victimAmt);
        if (minted == 0) return; // victim tx reverts InvalidAmount: no loss
        vm.prank(victim);
        pm.deposit(victimAmt, 0);
        skip(1 hours);
        _withdrawAll(attacker);
        assertLe(usdc.balanceOf(attacker), a0, "inflation attack profitable");
    }

    /// @dev Deposit lock cannot be bypassed: shares are non-transferable, any deposit relocks.
    function test_DepositLock_NoBypass() public {
        vm.prank(attacker);
        pm.deposit(1_000e6, 0);
        uint256 s = pm.shares(attacker);
        // attempt every exit path within the hour
        vm.startPrank(attacker);
        vm.expectRevert();
        pm.withdraw(s, 0);
        skip(30 minutes);
        vm.expectRevert();
        pm.withdraw(1, 0);
        vm.stopPrank();
        // a third party cannot deposit on attacker's behalf (no such entry point) nor relock them
        skip(31 minutes);
        vm.prank(bob);
        pm.deposit(1e6, 0);
        vm.prank(attacker);
        pm.withdraw(s, 0);
    }

    // =====================================================================
    // Bookkeeping and DoS
    // =====================================================================

    /// @dev Rounding dust: many 1-unit buys cost 1 raw each, so totalCost can exceed the
    ///      sell-back reserve. The void buffer must track it and a void must refund everyone.
    function test_VoidBufferTracksDustAndVoidRefundsAll() public {
        uint256 mid = _create(300);
        for (uint256 i; i < 50; ++i) {
            _buy(alice, mid, true, 1);
            _buy(bob, mid, false, 1);
        }
        PredictionMarket.Market memory m = pm.getMarket(mid);
        uint256 exposure = 100; // 50 + ceil(0.99 * 50) = 50 + 50
        assertEq(pm.totalLocked(), exposure);
        assertEq(m.totalCost, 100);
        assertEq(_buffer(), 100 - exposure, "void buffer = cost - exposure");
        _assertFullySolvent();

        // LP drains all free liquidity, then the market voids
        _withdrawMax(lp);
        _assertFullySolvent();
        vm.warp(_expiry(mid) + 24 hours);
        pm.voidMarket(mid);
        assertEq(_buffer(), 0);
        vm.prank(alice);
        pm.claim(mid);
        vm.prank(bob);
        pm.claim(mid);
        assertEq(pm.unclaimedPayouts(), 0);
    }

    /// @dev Sell-backs must stay possible after LPs withdraw the maximum (AGENTS.md claim),
    ///      including mixed dust and large positions and profitable exits.
    function testFuzz_SellAlwaysPossibleAfterMaxWithdraw(
        uint256 big, uint256 dustN, uint256 down, int256 moveBps, uint256 sellFrac
    ) public {
        big = bound(big, 1, 50_000e6);
        dustN = bound(dustN, 0, 20);
        down = bound(down, 0, 50_000e6);
        moveBps = bound(moveBps, -60, 60);
        sellFrac = bound(sellFrac, 1, 10_000);
        uint256 mid = _create(3600);
        _buy(alice, mid, true, big);
        if (down > 0) _buy(bob, mid, false, down);
        for (uint256 i; i < dustN; ++i) {
            _buy(keeper, mid, i % 2 == 0, 1);
        }
        _withdrawMax(lp);
        _assertFullySolvent();
        _setPrice(SPOT8 + (SPOT8 * moveBps) / 10_000);
        uint256 units = big * sellFrac / 10_000;
        if (units == 0) units = 1;
        vm.prank(alice);
        pm.sell(mid, true, units, 0);
        _assertFullySolvent();
        if (down > 0) {
            vm.prank(bob);
            pm.sell(mid, false, down, 0);
            _assertFullySolvent();
        }
    }

    /// @dev previewWithdraw of the full supply never exceeds freeLiquidity (withdraw cap redundant-safe).
    function testFuzz_PreviewWithdrawWithinFree(uint256 up, uint256 down, uint256 loss) public {
        up = bound(up, 0, 80_000e6);
        down = bound(down, 0, 80_000e6);
        uint256 mid = _create(300);
        if (up > 0) _buy(alice, mid, true, up);
        if (down > 0) _buy(bob, mid, false, down);
        loss = bound(loss, 0, 1);
        if (loss == 1) {
            _settleWith(mid, SPOT8 + 1e8, 5);
        }
        assertLe(pm.previewWithdraw(pm.totalShares()), pm.freeLiquidity());
        _withdrawMax(lp);
        _assertFullySolvent();
    }

    /// @dev Claims and withdrawals cannot be bricked by a shortfall of free liquidity: once all
    ///      markets resolve and are claimed, every LP share is redeemable for the full balance.
    function test_EverythingRedeemableAfterResolution() public {
        vm.prank(bob);
        pm.deposit(50_000e6, 0);
        uint256 m1 = _create(300);
        uint256 m2 = _create(900);
        _buy(alice, m1, true, 30_000e6);
        _buy(attacker, m1, false, 10_000e6);
        _buy(alice, m2, false, 40_000e6);
        _settleWith(m1, SPOT8 + 1e8, 1);
        vm.warp(_expiry(m2) + 24 hours);
        pm.voidMarket(m2);
        vm.prank(alice);
        pm.claim(m1);
        vm.prank(alice);
        pm.claim(m2);
        vm.prank(attacker);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        pm.claim(m1);
        assertEq(pm.unclaimedPayouts(), 0);
        assertEq(pm.totalLocked(), 0);
        assertEq(_buffer(), 0);
        _withdrawAll(lp);
        _withdrawAll(bob);
        assertLe(usdc.balanceOf(address(pm)), 2, "only rounding dust left");
    }
}
