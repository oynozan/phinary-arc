// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/Test.sol";
import {ArcForkBase, ILegacyVault} from "./ArcForkBase.sol";
import {PredictionMarket} from "../../PredictionMarket.sol";
import {PriceOracleAdapter} from "../../PriceOracleAdapter.sol";

/// @notice Read-mostly checks of the contracts actually deployed on Arc Testnet (their bytecode
///         predates the current sources; only ABI-compatible calls are used). Run with:
///         forge test --match-path 'contracts/test-integration/*' -vv
contract LiveDeploymentForkTest is ArcForkBase {
    function setUp() public {
        _fork();
        for (uint8 a; a < 3; ++a) _refresh(a);
    }

    function test_Fork_DeployedWiring() public view {
        assertEq(address(pm.usdc()), USDC);
        assertEq(address(pm.oracle()), ORACLE_ADDR);
        assertEq(pm.owner(), KEEPER);
        assertEq(oracle.owner(), KEEPER);
        for (uint8 a; a < 3; ++a) assertEq(_feed(a).owner(), KEEPER);
        assertEq(pm.priceEdge(), 0.02e18);
        assertEq(pm.maxTradeStaleness(), 120);
        assertEq(pm.maxStrikeDeviation(), 0.10e18);
        assertTrue(pm.durationAllowed(300) && pm.durationAllowed(900) && pm.durationAllowed(3600));
        assertFalse(pm.paused());
        assertEq(_feed(0).decimals(), 8);
    }

    function test_Fork_SolvencyAndAccountingAtHead() public view {
        (uint256 bal, uint256 assets,, uint256 locked, uint256 pending, uint256 free,,) = pm.vaultStats();
        assertEq(bal, usdc.balanceOf(PM_ADDR));
        assertGe(bal, locked + pending, "balance < locked + pending");
        assertEq(assets, bal > pending ? bal - pending : 0);
        assertLe(free, assets);
        // Recompute totalLocked from every open market.
        uint256 n = pm.marketCount();
        PredictionMarket.Market[] memory ms = pm.getMarketsRange(1, n);
        uint256 sumLocked;
        uint256 sumBuffer;
        uint256 sumPending;
        uint256 expiredOpen;
        for (uint256 i; i < ms.length; ++i) {
            PredictionMarket.Market memory m = ms[i];
            if (m.status == 0) {
                uint256 hi = m.upUnits > m.downUnits ? m.upUnits : m.downUnits;
                uint256 lo = m.upUnits > m.downUnits ? m.downUnits : m.upUnits;
                uint256 r = hi + (lo * 99 + 99) / 100;
                sumLocked += r;
                if (m.totalCost > r) sumBuffer += m.totalCost - r;
                if (block.timestamp > uint256(m.expiry) + 600) ++expiredOpen;
            } else if (m.status == 1) {
                sumPending += m.upWon ? m.upUnits : m.downUnits;
                assertEq(m.upWon, m.settlePrice > m.strike, "upWon inconsistent");
            } else {
                sumPending += m.totalCost;
            }
        }
        assertEq(locked, sumLocked, "totalLocked != sum of open reserves");
        assertEq(assets - free, locked + sumBuffer > assets ? assets : locked + sumBuffer, "void buffer mismatch");
        // Claims reduce unclaimedPayouts but not market units, so pending <= gross liabilities.
        assertLe(pending, sumPending);
        console2.log("marketCount", n);
        console2.log("balance", bal);
        console2.log("pending", pending);
        console2.log("markets expired >10min ago and still open", expiredOpen);
    }

    function test_Fork_FeedsFreshAndOracleConfigured() public {
        // setUp refreshed the feeds; the oracle accepts them with the market's age bound.
        for (uint8 a; a < 3; ++a) {
            (uint256 p, uint256 t) = oracle.getPriceMaxAge(a, pm.maxTradeStaleness());
            assertGt(p, 0);
            assertEq(t, block.timestamp);
            assertGt(oracle.getVol(a), 0);
        }
        vm.expectRevert(abi.encodeWithSelector(PriceOracleAdapter.AssetNotEnabled.selector, uint8(3)));
        oracle.getPrice(3);
    }

    /// @dev The live bytecode still has the one-argument withdraw. Every LP can exit with what
    ///      previewWithdraw quotes, and outstanding winners stay payable afterwards.
    function test_Fork_ExistingLpsCanExitAndWinnersStayPayable() public {
        uint256 kShares = pm.shares(KEEPER);
        if (kShares == 0) return;
        uint256 pending = pm.unclaimedPayouts();
        uint256 out = pm.previewWithdraw(kShares);
        if (out == 0) return;
        uint256 before = usdc.balanceOf(KEEPER);
        vm.prank(KEEPER);
        ILegacyVault(PM_ADDR).withdraw(kShares);
        assertEq(usdc.balanceOf(KEEPER) - before, out);
        assertGe(usdc.balanceOf(PM_ADDR), pending + pm.totalLocked());
        console2.log("keeper LP exit", out);
        console2.log("residual balance", usdc.balanceOf(PM_ADDR));
    }
}
