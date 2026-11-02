// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PMTestBase} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";

contract TradeTest is PMTestBase {
    uint256 internal id;
    uint256 internal constant U = 100e6; // payout units (= 100 USDC at settlement)

    function setUp() public override {
        super.setUp();
        id = _create(3600);
    }

    // -------------------------------------------------------------------- buy
    function test_Buy_Up_HappyPath() public {
        _refresh();
        oracle.poke(ASSET); // record this block's observation first so the quote matches execution
        Q memory q = _q(id);
        uint256 cost = _ceilMul(U, q.buyUp);
        uint256 a0 = usdc.balanceOf(alice);
        uint256 p0 = usdc.balanceOf(address(pm));

        vm.expectEmit(true, true, false, true, address(pm));
        emit PredictionMarket.Bought(id, alice, true, U, cost, q.fairUp, q.spot, block.timestamp);
        vm.prank(alice);
        pm.buy(id, true, U, cost);

        assertEq(a0 - usdc.balanceOf(alice), cost);
        assertEq(usdc.balanceOf(address(pm)) - p0, cost);
        (uint256 up, uint256 down, uint256 upC, uint256 downC) = pm.getPosition(id, alice);
        assertEq(up, U);
        assertEq(down, 0);
        assertEq(upC, cost);
        assertEq(downC, 0);
        PredictionMarket.Market memory m = pm.getMarket(id);
        assertEq(m.upUnits, U);
        assertEq(m.totalCost, cost);
        assertEq(pm.totalLocked(), U, "worst-case payout reserved");
        _assertSolvent();
    }

    function test_Buy_Down_HappyPath() public {
        _refresh();
        oracle.poke(ASSET);
        Q memory q = _q(id);
        uint256 cost = _ceilMul(U, q.buyDown);
        vm.expectEmit(true, true, false, true, address(pm));
        emit PredictionMarket.Bought(id, bob, false, U, cost, WAD - q.fairUp, q.spot, block.timestamp);
        vm.prank(bob);
        pm.buy(id, false, U, cost);
        (uint256 up, uint256 down, uint256 upC, uint256 downC) = pm.getPosition(id, bob);
        assertEq(up, 0);
        assertEq(down, U);
        assertEq(upC, 0);
        assertEq(downC, cost);
        assertEq(pm.getMarket(id).downUnits, U);
        assertEq(pm.totalLocked(), U);
    }

    function test_Buy_BothSidesReserveFormula() public {
        _buy(alice, id, true, 100e6);
        _buy(bob, id, false, 60e6);
        // reserve = max + ceil(0.99 * min)
        assertEq(pm.totalLocked(), 100e6 + 59_400_000);
        _buy(bob, id, false, 1);
        // ceil(0.99 * 60_000_001) = 59_400_001 (60_000_001*99 = 5_940_000_099 -> ceil/100 = 59_400_001)
        assertEq(pm.totalLocked(), 100e6 + 59_400_001);
    }

    function test_Buy_RejectsZeroUnits() public {
        vm.expectRevert(PredictionMarket.InvalidAmount.selector);
        vm.prank(alice);
        pm.buy(id, true, 0, type(uint256).max);
    }

    function test_Buy_InvalidMarket() public {
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.InvalidMarket.selector, uint256(99)));
        vm.prank(alice);
        pm.buy(99, true, U, type(uint256).max);
    }

    function test_Buy_SlippageMaxCost() public {
        _refresh();
        oracle.poke(ASSET);
        Q memory q = _q(id);
        uint256 cost = _ceilMul(U, q.buyUp);
        vm.expectRevert(PredictionMarket.SlippageExceeded.selector);
        vm.prank(alice);
        pm.buy(id, true, U, cost - 1);
        vm.prank(alice);
        pm.buy(id, true, U, cost); // exactly maxCost passes
    }

    function test_Buy_UnavailablePriceReverts() public {
        _setPrice(2040e8); // buyUp quote >= 0.99 -> not executable
        vm.expectRevert(PredictionMarket.BuyPriceTooHigh.selector);
        vm.prank(alice);
        pm.buy(id, true, U, type(uint256).max);
    }

    function test_Buy_StaleOracleReverts() public {
        skip(121);
        vm.expectRevert();
        vm.prank(alice);
        pm.buy(id, true, U, type(uint256).max);
    }

    function test_Buy_RecordsOracleObservation() public {
        _buy(alice, id, true, U);
        assertEq(oracle.getObservationCount(ASSET), 1);
    }

    // ------------------------------------------------------------------- sell
    function test_Sell_Partial() public {
        _buy(alice, id, true, U);
        (,, uint256 cost0,) = pm.getPosition(id, alice);
        _refresh();
        Q memory q = _q(id);
        uint256 units = 40e6;
        uint256 proceeds = units * q.sellUp / WAD;
        uint256 a0 = usdc.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(pm));
        emit PredictionMarket.Sold(id, alice, true, units, proceeds, q.fairUp, q.spot, block.timestamp);
        vm.prank(alice);
        pm.sell(id, true, units, proceeds);

        assertEq(usdc.balanceOf(alice) - a0, proceeds);
        (uint256 up,, uint256 upC,) = pm.getPosition(id, alice);
        assertEq(up, 60e6);
        uint256 basis = cost0 * units / U;
        assertEq(upC, cost0 - basis, "cost basis reduced pro rata");
        assertEq(pm.getMarket(id).upUnits, 60e6);
        assertEq(pm.getMarket(id).totalCost, cost0 - basis);
        assertEq(pm.totalLocked(), 60e6);
        _assertSolvent();
    }

    function test_Sell_AllClearsPosition() public {
        _buy(alice, id, false, U);
        _refresh();
        vm.prank(alice);
        pm.sell(id, false, U, 0);
        (uint256 up, uint256 down, uint256 upC, uint256 downC) = pm.getPosition(id, alice);
        assertEq(up + down + upC + downC, 0);
        assertEq(pm.totalLocked(), 0);
        assertEq(pm.getMarket(id).totalCost, 0);
    }

    function test_Sell_MoreThanHeldReverts() public {
        _buy(alice, id, true, U);
        _refresh();
        vm.expectRevert(PredictionMarket.InsufficientPosition.selector);
        vm.prank(alice);
        pm.sell(id, true, U + 1, 0);
        vm.expectRevert(PredictionMarket.InsufficientPosition.selector);
        vm.prank(alice);
        pm.sell(id, false, 1, 0); // holds no DOWN
        vm.expectRevert(PredictionMarket.InsufficientPosition.selector);
        vm.prank(bob);
        pm.sell(id, true, 1, 0); // bob holds nothing
    }

    function test_Sell_ZeroUnitsReverts() public {
        _buy(alice, id, true, U);
        vm.expectRevert(PredictionMarket.InvalidAmount.selector);
        vm.prank(alice);
        pm.sell(id, true, 0, 0);
    }

    function test_Sell_SlippageMinProceeds() public {
        _buy(alice, id, true, U);
        _refresh();
        uint256 proceeds = U * _q(id).sellUp / WAD;
        vm.expectRevert(PredictionMarket.SlippageExceeded.selector);
        vm.prank(alice);
        pm.sell(id, true, U, proceeds + 1);
        vm.prank(alice);
        pm.sell(id, true, U, proceeds);
    }

    // ------------------------------------------------------------- round trip
    function test_RoundTrip_CostsTheSpread() public {
        uint256 a0 = usdc.balanceOf(alice);
        _buy(alice, id, true, U);
        _refresh();
        vm.prank(alice);
        pm.sell(id, true, U, 0);
        uint256 loss = a0 - usdc.balanceOf(alice);
        // spread = 2 * edge = 4% of units
        assertApproxEqAbs(loss, U * 4 / 100, 2);
        assertGt(loss, 0);
    }

    function testFuzz_RoundTrip_NeverProfits(uint256 units, bool isUp, int256 moveBps) public {
        units = bound(units, 1, 5_000e6);
        moveBps = bound(moveBps, -30, 30); // stay within executable price range
        _setPrice(SPOT8 + (SPOT8 * moveBps) / 10_000);
        _refresh();
        Q memory q = _q(id);
        if ((isUp ? q.buyUp : q.buyDown) == 0) return;
        uint256 a0 = usdc.balanceOf(alice);
        _buy(alice, id, isUp, units);
        _refresh();
        vm.prank(alice);
        pm.sell(id, isUp, units, 0);
        assertLt(usdc.balanceOf(alice), a0, "round trip must lose the spread");
        _assertSolvent();
    }

    // ---------------------------------------------------------- trading window
    function test_Window_ClosesFifteenSecondsBeforeExpiry() public {
        uint256 id2 = _create(300);
        uint256 e = _expiry(id2);
        _buy(alice, id2, true, U);

        vm.warp(e - 16);
        _buy(alice, id2, true, 1e6); // last second allowed
        _refresh();
        vm.prank(alice);
        pm.sell(id2, true, 1e6, 0);

        vm.warp(e - 15);
        _refresh();
        vm.expectRevert(PredictionMarket.TradingClosed.selector);
        vm.prank(alice);
        pm.buy(id2, true, 1e6, type(uint256).max);
        vm.expectRevert(PredictionMarket.TradingClosed.selector);
        vm.prank(alice);
        pm.sell(id2, true, 1e6, 0);
    }

    function test_Window_ClosedAfterExpiryWhileUnsettled() public {
        uint256 id2 = _create(300);
        _buy(alice, id2, true, U);
        vm.warp(_expiry(id2) + 1);
        _refresh();
        vm.expectRevert(PredictionMarket.TradingClosed.selector);
        vm.prank(alice);
        pm.buy(id2, true, U, type(uint256).max);
        vm.expectRevert(PredictionMarket.TradingClosed.selector);
        vm.prank(alice);
        pm.sell(id2, true, U, 0);
    }
}
