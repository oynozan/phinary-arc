// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PMTestBase} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";

contract VaultTest is PMTestBase {
    uint256 internal constant U = 100e6;

    // ---------------------------------------------------------- share math
    function test_Deposit_FirstDepositorGetsThousandSharesPerRawUnit() public {
        _deployPM(); // empty vault
        (,,,,,, uint256 price0,) = pm.vaultStats();
        assertEq(price0, 1e18, "initial share price");
        vm.expectEmit(true, false, false, true, address(pm));
        emit PredictionMarket.Deposited(bob, 1e6, 1e9);
        vm.prank(bob);
        pm.deposit(1e6); // 1 USDC -> 1e9 share units (9 display decimals)
        assertEq(pm.shares(bob), 1e9);
        assertEq(pm.sharesOf(bob), 1e9);
        assertEq(pm.totalShares(), 1e9);
        (,,,,,, uint256 price1,) = pm.vaultStats();
        assertEq(price1, 1e18);
    }

    function test_Deposit_ProportionalToExistingPool() public {
        assertEq(pm.shares(lp), LP_DEPOSIT * 1000);
        uint256 preview = pm.previewDeposit(1000e6);
        vm.prank(bob);
        pm.deposit(1000e6);
        assertEq(pm.shares(bob), preview);
        assertEq(preview, 1000e6 * 1000);
        assertEq(usdc.balanceOf(address(pm)), LP_DEPOSIT + 1000e6);
    }

    function test_Deposit_ZeroReverts() public {
        vm.expectRevert(PredictionMarket.InvalidAmount.selector);
        vm.prank(bob);
        pm.deposit(0);
    }

    function test_Withdraw_FullRoundTripReturnsDeposit() public {
        vm.prank(bob);
        pm.deposit(1000e6);
        skip(1 hours);
        uint256 b0 = usdc.balanceOf(bob);
        uint256 s = pm.shares(bob);
        uint256 expected = pm.previewWithdraw(s);
        vm.expectEmit(true, false, false, true, address(pm));
        emit PredictionMarket.Withdrawn(bob, s, expected);
        vm.prank(bob);
        pm.withdraw(s);
        assertApproxEqAbs(usdc.balanceOf(bob) - b0, 1000e6, 2);
        assertEq(pm.shares(bob), 0);
        assertEq(pm.totalShares(), LP_DEPOSIT * 1000);
    }

    function test_Withdraw_PartialIsProportional() public {
        vm.prank(bob);
        pm.deposit(1000e6);
        skip(1 hours);
        uint256 s = pm.shares(bob);
        uint256 b0 = usdc.balanceOf(bob);
        vm.prank(bob);
        pm.withdraw(s / 4);
        assertApproxEqAbs(usdc.balanceOf(bob) - b0, 250e6, 2);
        assertEq(pm.shares(bob), s - s / 4);
    }

    function test_Withdraw_Validation() public {
        vm.expectRevert(PredictionMarket.InvalidAmount.selector);
        vm.prank(lp);
        pm.withdraw(0);
        uint256 tooMany = pm.shares(lp) + 1;
        vm.expectRevert(PredictionMarket.InsufficientShares.selector);
        vm.prank(lp);
        pm.withdraw(tooMany);
        vm.expectRevert(PredictionMarket.InsufficientShares.selector);
        vm.prank(bob); // never deposited
        pm.withdraw(1);
    }

    // ------------------------------------------------------------ deposit lock
    function test_Lock_OneHourFromDeposit() public {
        assertEq(pm.depositUnlockAt(bob), 0);
        vm.prank(bob);
        pm.deposit(1000e6);
        uint256 unlock = block.timestamp + 1 hours;
        assertEq(pm.depositUnlockAt(bob), unlock);
        uint256 s = pm.shares(bob);

        vm.warp(unlock - 1);
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.DepositLocked.selector, unlock));
        vm.prank(bob);
        pm.withdraw(s);

        vm.warp(unlock);
        vm.prank(bob);
        pm.withdraw(s);
        assertEq(pm.shares(bob), 0);
    }

    function test_Lock_AnyDepositRelocksAllShares() public {
        vm.prank(bob);
        pm.deposit(1000e6);
        skip(59 minutes);
        vm.prank(bob);
        pm.deposit(1e6);
        uint256 unlock = block.timestamp + 1 hours;
        assertEq(pm.depositUnlockAt(bob), unlock);
        skip(2 minutes); // original lock would have expired
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.DepositLocked.selector, unlock));
        vm.prank(bob);
        pm.withdraw(1);
    }

    // -------------------------------------------------------------- two-sided NAV
    function test_Nav_EqualWhenNoExposure() public {
        uint256 s = pm.previewDeposit(1000e6);
        assertApproxEqAbs(pm.previewWithdraw(s), 1000e6, 2);
        (,,,,,, uint256 hi, uint256 lo) = pm.vaultStats();
        assertEq(hi, lo, "deposit and withdraw NAV coincide without exposure");
    }

    function test_Nav_DepositHighWithdrawLowWithExposure() public {
        _buy(alice, pm.marketCount() == 0 ? _create(3600) : 1, true, 5_000e6);
        assertGt(pm.totalLocked(), 0);
        uint256 s = pm.previewDeposit(1000e6);
        uint256 back = pm.previewWithdraw(s);
        assertLt(back, 1000e6, "round trip through open exposure loses value");
        (,,,,,, uint256 hi, uint256 lo) = pm.vaultStats();
        assertGt(hi, lo);
        assertEq(pm.freeLiquidity(), pm.totalAssets() - pm.totalLocked());
    }

    function test_Nav_RecoversAfterSettlement() public {
        uint256 mid = _create(300);
        _buy(alice, mid, true, 5_000e6);
        _buy(bob, mid, false, 5_000e6);
        _settleWith(mid, SPOT8 + 1e8, 5);
        vm.prank(alice);
        pm.claim(mid);
        assertEq(pm.totalLocked(), 0);
        (,,,,,, uint256 hi, uint256 lo) = pm.vaultStats();
        assertEq(hi, lo);
        assertGt(hi, 1e18, "LPs earned the edge");
    }

    // -------------------------------------------------- LP cannot self-deal for profit
    function _attack(uint256 depositAmt, uint256 u) internal {
        uint256 start = usdc.balanceOf(attacker);
        vm.prank(attacker);
        pm.deposit(depositAmt);
        skip(1 hours + 1);
        uint256 mid = _create(3600);
        _buy(attacker, mid, true, u);
        _buy(attacker, mid, false, u);
        // withdraw everything during exposure (low NAV)
        uint256 s = pm.shares(attacker);
        vm.prank(attacker);
        pm.withdraw(s);
        _assertSolvent();
        // resolve and collect the guaranteed winning side
        _settleWith(mid, SPOT8 + 1e8, 5);
        vm.prank(attacker);
        pm.claim(mid);
        assertLt(usdc.balanceOf(attacker), start, "LP self-dealing must lose money");

        // honest LP is made whole or better
        uint256 lpBefore = usdc.balanceOf(lp);
        uint256 lpShares = pm.shares(lp);
        vm.prank(lp);
        pm.withdraw(lpShares);
        assertGe(usdc.balanceOf(lp) - lpBefore + 1, LP_DEPOSIT, "honest LP not diluted");
    }

    function test_Attack_BuyBothSidesThenWithdrawLoses() public {
        _attack(50_000e6, 20_000e6);
    }

    function testFuzz_Attack_BuyBothSidesThenWithdrawLoses(uint256 depositAmt, uint256 u) public {
        depositAmt = bound(depositAmt, 1e6, 500_000e6);
        u = bound(u, 1e6, 60_000e6);
        _attack(depositAmt, u);
    }

    function test_Attack_DepositWhileExposedGetsFewerShares() public {
        _buy(alice, _create(3600), true, 10_000e6);
        uint256 withExposure = pm.previewDeposit(1000e6);
        assertLt(withExposure, 1000e6 * 1000, "depositor pays the high NAV");
    }

    // -------------------------------------------- withdraw capped to free liquidity
    function test_Withdraw_NeverTakesReservedLiquidity() public {
        uint256 mid = _create(3600);
        _buy(alice, mid, true, 50_000e6);
        _buy(bob, mid, false, 50_000e6);
        uint256 free0 = pm.freeLiquidity();
        uint256 s = pm.shares(lp);
        uint256 l0 = usdc.balanceOf(lp);
        vm.prank(lp);
        pm.withdraw(s); // withdraw everything allowed
        uint256 got = usdc.balanceOf(lp) - l0;
        assertLe(got, free0, "payout bounded by free liquidity");
        assertLe(pm.freeLiquidity(), 1, "all free liquidity consumed");
        assertGe(usdc.balanceOf(address(pm)), pm.totalLocked() + pm.unclaimedPayouts());
        assertEq(pm.shares(lp), 0);
    }

    // ------------------------------------------------------- exposure cap
    function test_ExposureCap_BuyRevertsWhenVaultTooSmall() public {
        _deployPM();
        vm.prank(lp);
        pm.deposit(100e6);
        uint256 mid = _create(3600);
        _buy(alice, mid, true, 200e6); // balance 100 + ~104 >= 200
        _refresh();
        vm.expectRevert(PredictionMarket.InsufficientVaultLiquidity.selector);
        vm.prank(bob);
        pm.buy(mid, true, 100e6, type(uint256).max); // would push reserve past balance
        _assertSolvent();
    }

    function test_ExposureCap_NoLiquidityNoBuy() public {
        _deployPM();
        uint256 mid = _create(3600);
        _refresh();
        vm.expectRevert(PredictionMarket.InsufficientVaultLiquidity.selector);
        vm.prank(alice);
        pm.buy(mid, true, 1e6, type(uint256).max);
    }

    function test_ExposureCap_OppositeSideAddsNinetyNinePercentReserve() public {
        _deployPM();
        vm.prank(lp);
        pm.deposit(100e6);
        uint256 mid = _create(3600);
        _buy(alice, mid, true, 200e6);
        uint256 locked0 = pm.totalLocked();
        _buy(bob, mid, false, 1e6); // small hedge fits
        assertEq(pm.totalLocked(), locked0 + 990_000, "min side adds ceil(0.99*units) of reserve");
        _refresh();
        vm.expectRevert(PredictionMarket.InsufficientVaultLiquidity.selector);
        vm.prank(bob);
        pm.buy(mid, false, 100e6, type(uint256).max); // 0.99*100 reserve > ~0.52*100 cash
        _assertSolvent();
    }

    // ---------------------------------------------- sell-back after LPs exit
    function _sellBack(uint256 u1, uint256 u2, int256 moveBps) internal {
        _deployPM();
        vm.prank(lp);
        pm.deposit(u1 + u2);
        skip(1 hours + 1);
        _setPrice(SPOT8);
        uint256 mid = _create(3600);
        _buy(alice, mid, true, u1);
        _buy(bob, mid, false, u2);

        uint256 s = pm.shares(lp);
        vm.prank(lp);
        pm.withdraw(s); // LP takes the maximum allowed
        _assertSolvent();

        _setPrice(SPOT8 + (SPOT8 * moveBps) / 10_000);
        vm.prank(alice);
        pm.sell(mid, true, u1, 0);
        _assertSolvent();
        vm.prank(bob);
        pm.sell(mid, false, u2, 0);
        _assertSolvent();
        assertEq(pm.totalLocked(), 0);
    }

    function test_SellBack_AfterLpMaxWithdraw_Balanced() public {
        _sellBack(10_000e6, 10_000e6, 0);
    }

    function test_SellBack_AfterLpMaxWithdraw_OneSided() public {
        _sellBack(10_000e6, 1, 0);
        _sellBack(777e6, 3e6, 25);
    }

    function test_SellBack_AfterLpMaxWithdraw_PriceUp() public {
        _sellBack(5_000e6, 3_000e6, 30);
    }

    function test_SellBack_AfterLpMaxWithdraw_PriceDown() public {
        _sellBack(5_000e6, 3_000e6, -30);
    }

    function testFuzz_SellBack_AfterLpMaxWithdraw(uint256 u1, uint256 u2, int256 moveBps) public {
        u1 = bound(u1, 1, 100_000e6);
        u2 = bound(u2, 1, 100_000e6);
        moveBps = bound(moveBps, -40, 40);
        _sellBack(u1, u2, moveBps);
    }
}
