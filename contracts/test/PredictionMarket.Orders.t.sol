// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PMTestBase} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract OrdersTest is PMTestBase {
    uint256 internal id;
    uint256 internal constant U = 100e6;

    function setUp() public override {
        super.setUp();
        id = _create(3600);
        _buy(alice, id, true, U); // UP holder
        _buy(bob, id, false, U); // DOWN holder
    }

    function _order(address u, bool up) internal view returns (uint256 stop, uint256 tp) {
        PredictionMarket.Order memory o = pm.getOrder(id, u, up);
        return (o.stopPrice, o.takeProfitPrice);
    }

    // ----------------------------------------------------------------- setOrder
    function test_SetOrder_UpStopAndTakeProfit() public {
        vm.expectEmit(true, true, false, true, address(pm));
        emit PredictionMarket.OrderSet(id, alice, true, 1990e18, 2010e18);
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 2010e18);
        (uint256 s, uint256 t) = _order(alice, true);
        assertEq(s, 1990e18);
        assertEq(t, 2010e18);
    }

    function test_SetOrder_SingleLegsAllowed() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        (uint256 s, uint256 t) = _order(alice, true);
        assertEq(s, 1990e18);
        assertEq(t, 0);
        vm.prank(alice);
        pm.setOrder(id, true, 0, 2010e18); // overwrites
        (s, t) = _order(alice, true);
        assertEq(s, 0);
        assertEq(t, 2010e18);
    }

    function test_SetOrder_UpWrongSideReverts() public {
        _refresh();
        vm.startPrank(alice);
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        pm.setOrder(id, true, SPOT, 0); // stop == spot
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        pm.setOrder(id, true, 2010e18, 0); // stop above spot
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        pm.setOrder(id, true, 0, SPOT); // tp == spot
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        pm.setOrder(id, true, 0, 1990e18); // tp below spot
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        pm.setOrder(id, true, 1990e18, 1995e18); // valid stop, invalid tp
        vm.stopPrank();
    }

    function test_SetOrder_DownStopAndTakeProfit() public {
        vm.prank(bob);
        pm.setOrder(id, false, 2010e18, 1990e18);
        (uint256 s, uint256 t) = _order(bob, false);
        assertEq(s, 2010e18);
        assertEq(t, 1990e18);
    }

    function test_SetOrder_DownWrongSideReverts() public {
        _refresh();
        vm.startPrank(bob);
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        pm.setOrder(id, false, SPOT, 0);
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        pm.setOrder(id, false, 1990e18, 0); // stop below spot
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        pm.setOrder(id, false, 0, SPOT);
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        pm.setOrder(id, false, 0, 2010e18); // tp above spot
        vm.stopPrank();
    }

    function test_SetOrder_BothZeroReverts() public {
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        vm.prank(alice);
        pm.setOrder(id, true, 0, 0);
    }

    function test_SetOrder_RequiresPositionOnThatSide() public {
        vm.expectRevert(PredictionMarket.InsufficientPosition.selector);
        vm.prank(alice);
        pm.setOrder(id, false, 2010e18, 0); // alice holds only UP
        vm.expectRevert(PredictionMarket.InsufficientPosition.selector);
        vm.prank(keeper);
        pm.setOrder(id, true, 1990e18, 0);
    }

    function test_SetOrder_ClosedOrStaleReverts() public {
        skip(121);
        vm.expectRevert(PriceOracleAdapter.StalePrice.selector);
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);

        vm.warp(_expiry(id) - 15);
        _refresh();
        vm.expectRevert(PredictionMarket.TradingClosed.selector);
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
    }

    function test_SetOrder_InvalidMarket() public {
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.InvalidMarket.selector, uint256(9)));
        vm.prank(alice);
        pm.setOrder(9, true, 1990e18, 0);
    }

    // -------------------------------------------------------------- executeOrder
    function test_Execute_NoOrderReverts() public {
        _refresh();
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        vm.prank(keeper);
        pm.executeOrder(id, alice, true);
    }

    function test_Execute_NotTriggeredReverts() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 2010e18);
        _setPrice(2005e8); // between stop and take-profit
        vm.expectRevert(PredictionMarket.OrderNotTriggered.selector);
        vm.prank(keeper);
        pm.executeOrder(id, alice, true);
    }

    /// @dev Moves price, then executes and asserts the full-sell-at-sell-price property.
    function _runExec(address u, bool up, int256 newPrice8, uint8 code) internal {
        _setPrice(newPrice8);
        Q memory q = _q(id);
        (uint256 upU, uint256 downU,,) = pm.getPosition(id, u);
        uint256 units = up ? upU : downU;
        uint256 proceeds = units * (up ? q.sellUp : q.sellDown) / WAD;
        uint256 u0 = usdc.balanceOf(u);
        uint256 k0 = usdc.balanceOf(keeper);

        vm.expectEmit(true, true, false, true, address(pm));
        emit PredictionMarket.OrderExecuted(id, u, up, units, proceeds, q.spot, code);
        vm.prank(keeper);
        pm.executeOrder(id, u, up);

        assertEq(usdc.balanceOf(u) - u0, proceeds, "position owner paid sell price");
        assertEq(usdc.balanceOf(keeper), k0, "keeper gets nothing");
        (upU, downU,,) = pm.getPosition(id, u);
        assertEq(up ? upU : downU, 0, "everything sold");
        (uint256 s, uint256 t) = _order(u, up);
        assertEq(s + t, 0, "order cleared after full sell");
        _assertSolvent();
    }

    function test_Execute_UpStop() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 2010e18);
        _runExec(alice, true, 1989e8, 1);
    }

    function test_Execute_UpStopAtExactThreshold() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        _runExec(alice, true, 1990e8, 1);
    }

    function test_Execute_UpTakeProfit() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 2010e18);
        _runExec(alice, true, 2012e8, 2);
    }

    function test_Execute_DownStop() public {
        vm.prank(bob);
        pm.setOrder(id, false, 2010e18, 1990e18);
        _runExec(bob, false, 2011e8, 1);
    }

    function test_Execute_DownTakeProfit() public {
        vm.prank(bob);
        pm.setOrder(id, false, 2010e18, 1990e18);
        _runExec(bob, false, 1988e8, 2);
    }

    function test_Execute_TakeProfitOnlyLegTriggers() public {
        vm.prank(alice);
        pm.setOrder(id, true, 0, 2010e18);
        _setPrice(1900e8); // far below: no stop configured, so nothing to trigger
        vm.expectRevert(PredictionMarket.OrderNotTriggered.selector);
        vm.prank(keeper);
        pm.executeOrder(id, alice, true);
        _runExec(alice, true, 2010e8, 2);
    }

    function test_Execute_TwiceReverts() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        _runExec(alice, true, 1980e8, 1);
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        vm.prank(keeper);
        pm.executeOrder(id, alice, true);
    }

    function test_Execute_WorksWhilePaused() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        vm.prank(owner);
        pm.pause();
        _runExec(alice, true, 1985e8, 1);
    }

    function test_Execute_AfterTradingClosedReverts() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        vm.warp(_expiry(id) - 15);
        _setPrice(1980e8);
        vm.expectRevert(PredictionMarket.TradingClosed.selector);
        vm.prank(keeper);
        pm.executeOrder(id, alice, true);
    }

    function test_Execute_InvalidMarket() public {
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.InvalidMarket.selector, uint256(9)));
        pm.executeOrder(9, alice, true);
    }

    // ---------------------------------------------------- lifecycle of an order
    function test_Order_PartialSellKeepsOrderFullSellClearsIt() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 2010e18);
        _refresh();
        vm.prank(alice);
        pm.sell(id, true, U / 2, 0);
        (uint256 s, uint256 t) = _order(alice, true);
        assertEq(s, 1990e18);
        assertEq(t, 2010e18);

        vm.expectEmit(true, true, false, true, address(pm));
        emit PredictionMarket.OrderCancelled(id, alice, true);
        vm.prank(alice);
        pm.sell(id, true, U / 2, 0);
        (s, t) = _order(alice, true);
        assertEq(s + t, 0);
    }

    function test_Order_ClearedOnClaim() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        _settleWith(id, SPOT8 + 1e8, 5);
        vm.prank(alice);
        pm.claim(id);
        (uint256 s, uint256 t) = _order(alice, true);
        assertEq(s + t, 0);
    }

    // ------------------------------------------------------------- cancelOrder
    function test_Cancel_RemovesOrderAndEmits() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 2010e18);
        vm.expectEmit(true, true, false, true, address(pm));
        emit PredictionMarket.OrderCancelled(id, alice, true);
        vm.prank(alice);
        pm.cancelOrder(id, true);
        (uint256 s, uint256 t) = _order(alice, true);
        assertEq(s + t, 0);
        _setPrice(1980e8);
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        vm.prank(keeper);
        pm.executeOrder(id, alice, true);
    }

    function test_Cancel_NoOrderReverts() public {
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        vm.prank(alice);
        pm.cancelOrder(id, true);
    }

    function test_Cancel_CannotCancelSomeoneElsesOrder() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        vm.expectRevert(PredictionMarket.InvalidOrder.selector);
        vm.prank(keeper);
        pm.cancelOrder(id, true);
        (uint256 s,) = _order(alice, true);
        assertEq(s, 1990e18);
    }

    function test_Cancel_WorksWhilePausedAndAfterClose() public {
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        vm.prank(owner);
        pm.pause();
        vm.warp(_expiry(id) + 1);
        vm.prank(alice);
        pm.cancelOrder(id, true);
        (uint256 s, uint256 t) = _order(alice, true);
        assertEq(s + t, 0);
    }

    function test_Cancel_InvalidMarket() public {
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.InvalidMarket.selector, uint256(9)));
        pm.cancelOrder(9, true);
    }

    function test_SetOrder_WorksWhilePaused() public {
        // setOrder carries no whenNotPaused guard
        vm.prank(owner);
        pm.pause();
        vm.prank(alice);
        pm.setOrder(id, true, 1990e18, 0);
        (uint256 s,) = _order(alice, true);
        assertEq(s, 1990e18);
        assertTrue(pm.paused());
        Pausable p = Pausable(address(pm));
        assertTrue(p.paused());
    }
}
