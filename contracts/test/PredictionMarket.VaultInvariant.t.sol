// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PMTestBase, MockUSDC} from "./PredictionMarket.Base.t.sol";
import {PMHandler} from "./PredictionMarket.Invariant.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";
import {MockAggregator} from "../MockAggregator.sol";

/// @dev Extends the stock handler with rounding-dust buys and USDC donations.
contract VaultHandler is PMHandler {
    MockUSDC internal token;
    uint256 public okDust;
    uint256 public donated;

    constructor(PredictionMarket pm_, MockAggregator agg_, PriceOracleAdapter oracle_, address[] memory actors_)
        PMHandler(pm_, agg_, oracle_, actors_)
    {
        token = MockUSDC(address(pm_.usdc()));
    }

    /// @dev 1..3 unit buys cost ceil(units*price) = 1..3 raw: maximal rounding excess.
    function buyDust(uint256 aSeed, uint256 mSeed, bool up, uint256 n) public {
        (bool ok, uint256 id) = _market(mSeed);
        if (!ok) return;
        n = bound(n, 1, 8);
        address a = _actor(aSeed);
        for (uint256 i; i < n; ++i) {
            vm.prank(a);
            try pm.buy(id, up, 1 + (i % 3), type(uint256).max) {
                ++okDust;
            } catch {}
        }
    }

    function donate(uint256 amt) public {
        amt = bound(amt, 1, 5_000e6);
        token.mint(address(pm), amt);
        donated += amt;
    }
}

/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 120
contract VaultInvariantTest is PMTestBase {
    VaultHandler internal handler;
    address[] internal actorList;

    function setUp() public override {
        super.setUp();
        actorList = [lp, alice, bob, keeper, attacker];
        handler = new VaultHandler(pm, agg, oracle, actorList);
        agg.setUpdater(address(handler), true);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](14);
        sels[0] = PMHandler.advance.selector;
        sels[1] = PMHandler.create.selector;
        sels[2] = PMHandler.buy.selector;
        sels[3] = PMHandler.sell.selector;
        sels[4] = PMHandler.deposit.selector;
        sels[5] = PMHandler.withdraw.selector;
        sels[6] = PMHandler.settle.selector;
        sels[7] = PMHandler.claim.selector;
        sels[8] = PMHandler.jump.selector;
        sels[9] = PMHandler.voidIt.selector;
        sels[10] = PMHandler.placeOrder.selector;
        sels[11] = PMHandler.execOrder.selector;
        sels[12] = VaultHandler.buyDust.selector;
        sels[13] = VaultHandler.donate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function _buffer() internal view returns (uint256) {
        return uint256(vm.load(address(pm), bytes32(uint256(15))));
    }

    function _reserve(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 mx = a > b ? a : b;
        uint256 mn = a > b ? b : a;
        return mx + (mn * 99 + 99) / 100;
    }

    /// @dev Full solvency including the void-refund buffer (the stock suite omits the buffer).
    function invariant_FullSolvency() public view {
        assertGe(usdc.balanceOf(address(pm)), pm.totalLocked() + pm.unclaimedPayouts() + _buffer());
    }

    /// @dev _voidRefundBuffer equals the sum of per-market max(0, totalCost - reserve) over open markets.
    function invariant_VoidBufferMatchesMarkets() public view {
        uint256 sum;
        for (uint256 id = 1; id <= pm.marketCount(); ++id) {
            PredictionMarket.Market memory m = pm.getMarket(id);
            if (m.status != 0) continue;
            uint256 r = _reserve(m.upUnits, m.downUnits);
            if (m.totalCost > r) sum += m.totalCost - r;
        }
        assertEq(_buffer(), sum);
    }

    /// @dev unclaimedPayouts equals outstanding winning units / void cost bases of all holders.
    function invariant_UnclaimedMatchesOutstandingClaims() public view {
        uint256 sum;
        for (uint256 id = 1; id <= pm.marketCount(); ++id) {
            PredictionMarket.Market memory m = pm.getMarket(id);
            if (m.status == 0) continue;
            for (uint256 i; i < actorList.length; ++i) {
                (uint256 u, uint256 d, uint256 uc, uint256 dc) = pm.getPosition(id, actorList[i]);
                if (m.status == 1) sum += m.upWon ? u : d;
                else sum += uc + dc;
            }
        }
        assertEq(pm.unclaimedPayouts(), sum);
    }

    /// @dev Market totalCost equals the sum of holders' remaining cost bases (open markets).
    function invariant_TotalCostMatchesPositions() public view {
        for (uint256 id = 1; id <= pm.marketCount(); ++id) {
            PredictionMarket.Market memory m = pm.getMarket(id);
            if (m.status != 0) continue;
            uint256 c;
            for (uint256 i; i < actorList.length; ++i) {
                (,, uint256 uc, uint256 dc) = pm.getPosition(id, actorList[i]);
                c += uc + dc;
            }
            assertEq(m.totalCost, c);
        }
    }

    /// @dev Redeeming the whole supply can never exceed free liquidity; LOW NAV <= HIGH NAV.
    function invariant_WithdrawBoundedByFree() public view {
        assertLe(pm.previewWithdraw(pm.totalShares()), pm.freeLiquidity());
        assertLe(pm.freeLiquidity(), pm.totalAssets());
    }

    function invariant_ShareSupplyIsSumOfHolders() public view {
        uint256 sum;
        for (uint256 i; i < actorList.length; ++i) {
            sum += pm.shares(actorList[i]);
        }
        assertEq(pm.totalShares(), sum);
    }

    /// @dev Non-vacuity check for the extended handler.
    function test_VaultHandler_Exercises() public {
        for (uint256 s; s < 10; ++s) {
            handler.runSequence(s, 60);
            handler.buyDust(s, s, s % 2 == 0, 8);
            handler.donate(s * 1e6 + 1);
        }
        assertGt(handler.okDust(), 0, "dust buys");
        invariant_FullSolvency();
        invariant_VoidBufferMatchesMarkets();
        invariant_UnclaimedMatchesOutstandingClaims();
        invariant_TotalCostMatchesPositions();
    }
}

/// @dev Replays the cached invariant failure
///      cache/invariant/failures/PredictionMarketInvariantTest/invariant_ShareSupplyIsSumOfHolders
///      (create(7.8e47) then sell(type(uint256).max, 2.2e53, true, 6.4e46) under fail_on_revert=true,
///      assertion_failure=false, 11 target selectors without execOrder) against the current handler.
contract CachedInvariantReplayTest is PMTestBase {
    PMHandler internal handler;
    address[] internal actorList;

    function setUp() public override {
        super.setUp();
        actorList = [lp, alice, bob, keeper, attacker];
        handler = new PMHandler(pm, agg, oracle, actorList);
        agg.setUpdater(address(handler), true);
    }

    function test_ReplayCachedShareSupplyFailure() public {
        handler.create(784553096387740759119077612453493415116840100410);
        // current handler: no holder on this side -> returns early instead of reverting
        handler.sell(
            type(uint256).max, 220773229918221350352712529802559385427257831322995302, true,
            63664776894314612124703925026468326684268757368
        );
        uint256 sum;
        for (uint256 i; i < actorList.length; ++i) sum += pm.shares(actorList[i]);
        assertEq(pm.totalShares(), sum, "share supply invariant holds after replay");
    }

    /// @dev What an unguarded handler (bound(frac, 1, held) with held == 0) does on that sequence:
    ///      forge-std's bound reverts, which under fail_on_revert=true is reported as a failure
    ///      of whichever invariant is checked, with assertion_failure=false.
    function test_UnguardedBoundReverts() public {
        vm.expectRevert();
        this.unguardedBound(63664776894314612124703925026468326684268757368, 0);
    }

    function unguardedBound(uint256 frac, uint256 held) external pure returns (uint256) {
        return bound(frac, 1, held);
    }
}
