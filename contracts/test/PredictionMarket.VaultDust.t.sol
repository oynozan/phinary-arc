// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PMTestBase} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";

/// @dev Void-refund buffer vs sell-back guarantee at zero slack (no free liquidity left).
contract VaultDustTest is PMTestBase {
    /// @dev Known limitation (VAULT-4, not fixed): ceil-rounded 1-unit buys push a market's
    ///      totalCost above its sell-back reserve, and the sell path also requires that
    ///      _voidRefundBuffer. With zero free liquidity a profitable sell can then revert by a
    ///      few raw units. It takes thousands of dust buys per market, no funds are at risk
    ///      (the position stays fully reserved for settlement), and any deposit restores the sell.
    ///      LP withdrawals alone cannot reach zero slack: the MIN_RESIDUAL_SHARES the last LP keeps
    ///      hold about one USDC of free liquidity, so buys in another market use it up here.
    function test_KnownLimitation_DustBufferCanBlockSellAtZeroSlack() public {
        uint256 mid = _create(3600);
        _refresh();
        vm.startPrank(keeper);
        for (uint256 i; i < 1000; ++i) {
            pm.buy(mid, true, 1, type(uint256).max);
            pm.buy(mid, false, 1, type(uint256).max);
        }
        vm.stopPrank();
        _buy(alice, mid, true, 100);
        _withdrawMax(lp);
        uint256 other = _create(3600);
        uint256 free = pm.freeLiquidity();
        assertGt(free, 0, "the residual share keeps some slack");
        vm.startPrank(bob); // each UP unit at ~0.52 adds 1 of reserve: consume the remaining slack
        while (free > 1) {
            uint256 units = free * WAD / (WAD - _q(other).buyUp);
            if (units == 0) break;
            pm.buy(other, true, units, type(uint256).max);
            free = pm.freeLiquidity();
        }
        vm.stopPrank();
        assertLe(pm.freeLiquidity(), 1);
        _setPrice(SPOT8 * 110 / 100); // UP deep in the money: sellUp at the 0.96 cap
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.InsufficientVaultLiquidity.selector);
        pm.sell(mid, true, 100, 0);
        // any slack restores it
        vm.prank(bob);
        pm.deposit(1e6, 0);
        vm.prank(alice);
        pm.sell(mid, true, 100, 0);
        (uint256 up,,,) = pm.getPosition(mid, alice);
        assertEq(up, 0);
    }
}
