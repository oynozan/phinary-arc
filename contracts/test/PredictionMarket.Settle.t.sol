// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PMTestBase} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";

contract SettleTest is PMTestBase {
    uint256 internal id;
    uint256 internal constant U = 100e6;

    function setUp() public override {
        super.setUp();
        id = _create(300);
        _buy(alice, id, true, U);
        _buy(bob, id, false, U);
    }

    // ----------------------------------------------------------------- settle
    function test_Settle_UpWinsWhenPriceAboveStrike() public {
        uint256 e = _expiry(id);
        vm.warp(e + 5);
        _setPrice(SPOT8 + 1);
        uint80 r = agg.latestRoundId();
        vm.expectEmit(true, false, false, true, address(pm));
        emit PredictionMarket.Settled(id, uint256(SPOT8 + 1) * 1e10, true);
        vm.prank(keeper); // permissionless
        pm.settle(id, r);

        PredictionMarket.Market memory m = pm.getMarket(id);
        assertEq(m.status, 1);
        assertTrue(m.upWon);
        assertEq(m.settlePrice, uint256(SPOT8 + 1) * 1e10);
        assertEq(pm.unclaimedPayouts(), U);
        assertEq(pm.totalLocked(), 0, "reserve released");
        _assertSolvent();
    }

    function test_Settle_DownWinsOnEquality() public {
        _settleWith(id, SPOT8, 5); // price == strike
        PredictionMarket.Market memory m = pm.getMarket(id);
        assertFalse(m.upWon);
        assertEq(m.settlePrice, SPOT);
        assertEq(pm.unclaimedPayouts(), U);
    }

    function test_Settle_DownWinsWhenPriceBelowStrike() public {
        _settleWith(id, SPOT8 - 1e8, 5);
        assertFalse(pm.getMarket(id).upWon);
    }

    function test_Settle_BeforeExpiryReverts() public {
        vm.warp(_expiry(id) - 1);
        vm.expectRevert(PredictionMarket.NotExpired.selector);
        pm.settle(id, 1);
    }

    function test_Settle_OnlyFirstRoundAfterExpiry() public {
        uint256 e = _expiry(id);
        vm.warp(e + 5);
        _setPrice(SPOT8 + 10e8);
        uint80 first = agg.latestRoundId();
        vm.warp(e + 10);
        _setPrice(SPOT8 - 10e8);
        uint80 second = agg.latestRoundId();
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        pm.settle(id, second);
        pm.settle(id, first);
        assertTrue(pm.getMarket(id).upWon, "first round decides, not the later one");
    }

    function test_Settle_RoundBeforeExpiryRejected() public {
        uint80 early = agg.latestRoundId(); // published before expiry
        vm.warp(_expiry(id) + 5);
        _setPrice(SPOT8);
        vm.expectRevert(PriceOracleAdapter.InvalidSettlementRound.selector);
        pm.settle(id, early);
    }

    function test_Settle_TwiceReverts() public {
        _settleWith(id, SPOT8 + 1e8, 5);
        uint80 r = agg.latestRoundId();
        vm.expectRevert(PredictionMarket.MarketNotOpen.selector);
        pm.settle(id, r);
    }

    function test_Settle_InvalidMarket() public {
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.InvalidMarket.selector, uint256(42)));
        pm.settle(42, 1);
    }

    function test_Settle_NoTradingAfterwards() public {
        _settleWith(id, SPOT8 + 1e8, 5);
        _refresh();
        vm.expectRevert(PredictionMarket.MarketNotOpen.selector);
        vm.prank(alice);
        pm.buy(id, true, U, type(uint256).max);
        vm.expectRevert(PredictionMarket.MarketNotOpen.selector);
        vm.prank(alice);
        pm.sell(id, true, U, 0);
    }

    // ------------------------------------------------------------------ claim
    function test_Claim_WinnerPaidOneToOne() public {
        _settleWith(id, SPOT8 + 1e8, 5);
        uint256 a0 = usdc.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(pm));
        emit PredictionMarket.Claimed(id, alice, U);
        vm.prank(alice);
        pm.claim(id);
        assertEq(usdc.balanceOf(alice) - a0, U, "one raw USDC per winning unit");
        assertEq(pm.unclaimedPayouts(), 0);
        (uint256 up,,,) = pm.getPosition(id, alice);
        assertEq(up, 0);
        _assertSolvent();
    }

    function test_Claim_DownWinnerPaid() public {
        _settleWith(id, SPOT8, 5);
        uint256 b0 = usdc.balanceOf(bob);
        vm.prank(bob);
        pm.claim(id);
        assertEq(usdc.balanceOf(bob) - b0, U);
    }

    function test_Claim_LoserHasNothing() public {
        _settleWith(id, SPOT8 + 1e8, 5);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        vm.prank(bob);
        pm.claim(id);
    }

    function test_Claim_DoubleClaimReverts() public {
        _settleWith(id, SPOT8 + 1e8, 5);
        vm.prank(alice);
        pm.claim(id);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        vm.prank(alice);
        pm.claim(id);
    }

    function test_Claim_BeforeSettlementReverts() public {
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        vm.prank(alice);
        pm.claim(id);
    }

    function test_Claim_NonParticipantReverts() public {
        _settleWith(id, SPOT8 + 1e8, 5);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        vm.prank(keeper);
        pm.claim(id);
    }

    function test_Claim_InvalidMarket() public {
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.InvalidMarket.selector, uint256(42)));
        vm.prank(alice);
        pm.claim(42);
    }

    function test_Settle_LpCanWithdrawEverythingAfterAllClaims() public {
        _settleWith(id, SPOT8 + 1e8, 5);
        vm.prank(alice);
        pm.claim(id);
        assertEq(pm.totalLocked(), 0);
        assertEq(pm.unclaimedPayouts(), 0);
        uint256 lpShares = pm.shares(lp);
        uint256 before_ = usdc.balanceOf(lp);
        vm.prank(lp);
        pm.withdraw(lpShares, 0);
        // LP earned the (cost - payout) margin: 2*0.02*U edge on the matched pair
        assertGe(usdc.balanceOf(lp) - before_, LP_DEPOSIT, "LP never loses on a matched pair");
    }

    // ------------------------------------------------------------------- void
    function test_Void_TooEarlyReverts() public {
        vm.warp(_expiry(id) + 24 hours - 1);
        vm.expectRevert(PredictionMarket.VoidTooEarly.selector);
        pm.voidMarket(id);
    }

    function test_Void_RefundsCostBasis() public {
        (,, uint256 aCost,) = pm.getPosition(id, alice);
        (,,, uint256 bCost) = pm.getPosition(id, bob);
        uint256 a0 = usdc.balanceOf(alice);
        uint256 b0 = usdc.balanceOf(bob);
        vm.warp(_expiry(id) + 24 hours);
        vm.expectEmit(true, false, false, false, address(pm));
        emit PredictionMarket.Voided(id);
        vm.prank(keeper);
        pm.voidMarket(id);

        PredictionMarket.Market memory m = pm.getMarket(id);
        assertEq(m.status, 2);
        assertEq(pm.unclaimedPayouts(), aCost + bCost);
        assertEq(pm.totalLocked(), 0);

        vm.prank(alice);
        pm.claim(id);
        vm.prank(bob);
        pm.claim(id);
        assertEq(usdc.balanceOf(alice) - a0, aCost);
        assertEq(usdc.balanceOf(bob) - b0, bCost);
        assertEq(pm.unclaimedPayouts(), 0);
        _assertSolvent();
    }

    function test_Void_AfterPartialSellRefundsRemainingBasis() public {
        _refresh();
        vm.prank(alice);
        pm.sell(id, true, U / 2, 0);
        (,, uint256 remaining,) = pm.getPosition(id, alice);
        uint256 a0 = usdc.balanceOf(alice);
        vm.warp(_expiry(id) + 24 hours);
        pm.voidMarket(id);
        vm.prank(alice);
        pm.claim(id);
        assertEq(usdc.balanceOf(alice) - a0, remaining);
    }

    function test_Void_DoubleClaimReverts() public {
        vm.warp(_expiry(id) + 24 hours);
        pm.voidMarket(id);
        vm.prank(alice);
        pm.claim(id);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        vm.prank(alice);
        pm.claim(id);
    }

    function test_Void_NotAfterSettleOrTwice() public {
        _settleWith(id, SPOT8 + 1e8, 5);
        vm.warp(_expiry(id) + 24 hours);
        vm.expectRevert(PredictionMarket.MarketNotOpen.selector);
        pm.voidMarket(id);

        uint256 id2 = _create(300);
        vm.warp(_expiry(id2) + 24 hours);
        pm.voidMarket(id2);
        vm.expectRevert(PredictionMarket.MarketNotOpen.selector);
        pm.voidMarket(id2);
        vm.expectRevert(PredictionMarket.MarketNotOpen.selector);
        pm.settle(id2, 1);
    }

    function test_Void_UnknownMarket() public {
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.InvalidMarket.selector, uint256(5)));
        pm.voidMarket(5);
    }
}
