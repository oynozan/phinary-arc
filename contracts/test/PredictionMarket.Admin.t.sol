// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PMTestBase} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {MockAggregator} from "../MockAggregator.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract AdminTest is PMTestBase {
    uint256 internal constant U = 100e6;

    // -------------------------------------------------------------- ownership
    function test_Renounce_RevertsForEveryone() public {
        vm.expectRevert(PredictionMarket.RenounceDisabled.selector);
        vm.prank(owner);
        pm.renounceOwnership();
        vm.expectRevert(PredictionMarket.RenounceDisabled.selector);
        vm.prank(alice);
        pm.renounceOwnership();
        assertEq(pm.owner(), owner);
    }

    function test_Renounce_DisabledOnMockAggregator() public {
        vm.expectRevert(MockAggregator.RenounceDisabled.selector);
        agg.renounceOwnership();
    }

    function test_TwoStepOwnershipTransfer() public {
        vm.prank(owner);
        pm.transferOwnership(alice);
        assertEq(pm.owner(), owner);
        assertEq(pm.pendingOwner(), alice);
        vm.prank(alice);
        pm.acceptOwnership();
        assertEq(pm.owner(), alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        pm.pause();
    }

    // ------------------------------------------------------------------ pause
    function test_Pause_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        pm.pause();
        vm.prank(owner);
        pm.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        pm.unpause();
    }

    function test_Pause_BlocksBuyCreateDeposit() public {
        uint256 id = _create(300);
        vm.prank(owner);
        pm.pause();
        _refresh();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        pm.buy(id, true, U, type(uint256).max);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        pm.createMarket(ASSET, 0, 300);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(bob);
        pm.deposit(1e6);
    }

    function test_Pause_DoesNotBlockSellClaimWithdraw() public {
        uint256 id = _create(300);
        _buy(alice, id, true, U);
        _buy(bob, id, false, U);
        uint256 tenth = pm.shares(lp) / 10;
        vm.prank(lp);
        pm.withdraw(tenth); // lp is long past its lock
        vm.prank(owner);
        pm.pause();
        _refresh();

        // sell
        vm.prank(alice);
        pm.sell(id, true, U / 2, 0);
        // withdraw
        uint256 l0 = usdc.balanceOf(lp);
        vm.prank(lp);
        pm.withdraw(tenth);
        assertGt(usdc.balanceOf(lp), l0);
        // settle + claim
        _settleWith(id, SPOT8 - 1e8, 5); // DOWN wins
        uint256 b0 = usdc.balanceOf(bob);
        vm.prank(bob);
        pm.claim(id);
        assertEq(usdc.balanceOf(bob) - b0, U);
        assertTrue(pm.paused());
    }

    function test_Pause_DoesNotBlockVoidAndRefundClaim() public {
        uint256 id = _create(300);
        _buy(alice, id, true, U);
        (,, uint256 cost,) = pm.getPosition(id, alice);
        vm.prank(owner);
        pm.pause();
        vm.warp(_expiry(id) + 24 hours);
        pm.voidMarket(id);
        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pm.claim(id);
        assertEq(usdc.balanceOf(alice) - a0, cost);
    }

    function test_Unpause_RestoresEntryPoints() public {
        vm.prank(owner);
        pm.pause();
        vm.prank(owner);
        pm.unpause();
        uint256 id = _create(300);
        _buy(alice, id, true, U);
        vm.prank(bob);
        pm.deposit(1e6);
        assertFalse(pm.paused());
    }

    // --------------------------------------------------------- owner parameters
    function test_SetEdge() public {
        vm.expectEmit(false, false, false, true, address(pm));
        emit PredictionMarket.EdgeSet(0.02e18, 0.05e18);
        vm.prank(owner);
        pm.setEdge(0.05e18);
        assertEq(pm.priceEdge(), 0.05e18);
        vm.expectRevert(PredictionMarket.InvalidParameter.selector);
        vm.prank(owner);
        pm.setEdge(0.05e18 + 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        pm.setEdge(0);
    }

    function test_SetDurationAllowed() public {
        vm.prank(owner);
        pm.setDurationAllowed(600, true);
        _refresh();
        vm.prank(alice);
        pm.createMarket(ASSET, 0, 600);
        vm.prank(owner);
        pm.setDurationAllowed(300, false);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        vm.prank(alice);
        pm.createMarket(ASSET, 0, 300);
        vm.expectRevert(PredictionMarket.InvalidDuration.selector);
        vm.prank(owner);
        pm.setDurationAllowed(15, true); // must exceed close buffer
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        pm.setDurationAllowed(600, false);
    }

    function test_SetMaxStrikeDeviation() public {
        vm.prank(owner);
        pm.setMaxStrikeDeviation(WAD);
        assertEq(pm.maxStrikeDeviation(), WAD);
        vm.expectRevert(PredictionMarket.InvalidParameter.selector);
        vm.prank(owner);
        pm.setMaxStrikeDeviation(WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        pm.setMaxStrikeDeviation(0);
    }

    function test_SetMaxTradeStaleness() public {
        vm.startPrank(owner);
        vm.expectRevert(PredictionMarket.InvalidParameter.selector);
        pm.setMaxTradeStaleness(9);
        vm.expectRevert(PredictionMarket.InvalidParameter.selector);
        pm.setMaxTradeStaleness(86401);
        pm.setMaxTradeStaleness(600);
        vm.stopPrank();
        skip(300); // stale under the old 120s bound, fine under 600s
        vm.prank(alice);
        pm.createMarket(ASSET, 0, 300);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        pm.setMaxTradeStaleness(100);
    }
}
