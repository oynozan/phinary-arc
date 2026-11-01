// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PMTestBase, MockUSDC} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";

contract CreateQuoteTest is PMTestBase {
    // ------------------------------------------------------------ constructor
    function test_Constructor_StoresConfig() public view {
        assertEq(address(pm.usdc()), address(usdc));
        assertEq(address(pm.oracle()), address(oracle));
        assertEq(pm.owner(), owner);
        assertEq(pm.priceEdge(), 0.02e18);
        assertEq(pm.maxStrikeDeviation(), 0.10e18);
        assertEq(pm.maxTradeStaleness(), 120);
        assertTrue(pm.durationAllowed(300));
        assertTrue(pm.durationAllowed(900));
        assertTrue(pm.durationAllowed(3600));
        assertFalse(pm.durationAllowed(600));
    }

    function test_Constructor_RejectsBadAddresses() public {
        vm.expectRevert(PredictionMarket.InvalidAddress.selector);
        new PredictionMarket(address(0), address(oracle), owner);
        vm.expectRevert(PredictionMarket.InvalidAddress.selector);
        new PredictionMarket(address(usdc), address(0), owner);
        vm.expectRevert(PredictionMarket.InvalidAddress.selector);
        new PredictionMarket(alice, address(oracle), owner); // EOA token
        vm.expectRevert(PredictionMarket.InvalidAddress.selector);
        new PredictionMarket(address(usdc), alice, owner); // EOA oracle
    }

    function test_Constructor_RejectsNonSixDecimalToken() public {
        MockUSDC t18 = new MockUSDC(18);
        vm.expectRevert(PredictionMarket.InvalidUSDC.selector);
        new PredictionMarket(address(t18), address(oracle), owner);
    }

    // ----------------------------------------------------------- createMarket
    function test_Create_AllowedDurations() public {
        uint32[3] memory ds = [uint32(300), 900, 3600];
        for (uint256 i; i < 3; ++i) {
            uint256 id = _create(ds[i]);
            assertEq(id, i + 1, "ids start at 1");
            PredictionMarket.Market memory m = pm.getMarket(id);
            assertEq(m.status, 0);
            assertEq(m.assetId, ASSET);
            assertEq(m.createdAt, block.timestamp);
            assertEq(m.expiry, block.timestamp + ds[i]);
            assertEq(m.strike, SPOT);
        }
        assertEq(pm.marketCount(), 3);
    }

    function test_Create_EmitsEvent() public {
        _refresh();
        vm.expectEmit(true, true, false, true, address(pm));
        emit PredictionMarket.MarketCreated(1, ASSET, SPOT, block.timestamp + 900, alice);
        vm.prank(alice);
        pm.createMarket(ASSET, 0, 900);
    }

    function test_Create_RejectsDisallowedDuration() public {
        _refresh();
        uint32[4] memory bad = [uint32(0), 60, 600, 7200];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(PredictionMarket.InvalidDuration.selector);
            pm.createMarket(ASSET, 0, bad[i]);
        }
    }

    function test_Create_ExplicitStrikeWithinBand() public {
        _refresh();
        uint256 hi = SPOT * 110 / 100;
        uint256 lo = SPOT * 90 / 100;
        uint256 id1 = pm.createMarket(ASSET, hi, 300);
        uint256 id2 = pm.createMarket(ASSET, lo, 300);
        assertEq(pm.getMarket(id1).strike, hi);
        assertEq(pm.getMarket(id2).strike, lo);
    }

    function test_Create_RejectsStrikeOutsideBand() public {
        _refresh();
        vm.expectRevert(PredictionMarket.InvalidStrike.selector);
        pm.createMarket(ASSET, SPOT * 110 / 100 + 1, 300);
        vm.expectRevert(PredictionMarket.InvalidStrike.selector);
        pm.createMarket(ASSET, SPOT * 90 / 100 - 1, 300);
    }

    function test_Create_RespectsUpdatedStrikeBand() public {
        vm.prank(owner);
        pm.setMaxStrikeDeviation(0.01e18);
        _refresh();
        pm.createMarket(ASSET, SPOT * 101 / 100, 300);
        vm.expectRevert(PredictionMarket.InvalidStrike.selector);
        pm.createMarket(ASSET, SPOT * 102 / 100, 300);
    }

    function test_Create_StaleOracleReverts() public {
        skip(121); // > maxTradeStaleness (120) though within feed staleness
        vm.expectRevert(PriceOracleAdapter.StalePrice.selector);
        pm.createMarket(ASSET, 0, 300);
    }

    function test_Create_UnknownAssetReverts() public {
        vm.expectRevert(abi.encodeWithSelector(PriceOracleAdapter.AssetNotEnabled.selector, uint8(7)));
        pm.createMarket(7, 0, 300);
    }

    function test_GetMarket_InvalidIds() public {
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.InvalidMarket.selector, uint256(0)));
        pm.getMarket(0);
        vm.expectRevert(abi.encodeWithSelector(PredictionMarket.InvalidMarket.selector, uint256(1)));
        pm.getMarket(1);
    }

    function test_GetMarketsRange_PaginatesAndClamps() public {
        _create(300);
        _create(900);
        _create(3600);
        assertEq(pm.getMarketsRange(0, 10).length, 3, "from 0 aliases 1; count clamped");
        PredictionMarket.Market[] memory r = pm.getMarketsRange(2, 1);
        assertEq(r.length, 1);
        assertEq(r[0].expiry, block.timestamp + 900);
        assertEq(pm.getMarketsRange(4, 5).length, 0);
    }

    // ------------------------------------------------------------------ quote
    function test_Quote_ConsistentSpread() public {
        uint256 id = _create(3600);
        Q memory q = _q(id);
        uint256 e = pm.priceEdge();
        assertEq(q.spot, SPOT);
        assertEq(q.sigma, DEFAULT_VOL);
        assertEq(q.timeLeft, 3600);
        assertApproxEqAbs(q.fairUp, 0.4983e18, 1e15); // ATM, slightly below 0.5
        assertEq(q.buyUp, q.fairUp + e);
        assertEq(q.sellUp, q.fairUp - e);
        assertEq(q.buyDown, (WAD - q.fairUp) + e);
        assertEq(q.sellDown, (WAD - q.fairUp) - e);
        // buy > fair > sell on both sides
        assertGt(q.buyUp, q.fairUp);
        assertGt(q.fairUp, q.sellUp);
        assertGt(q.buyDown, WAD - q.fairUp);
        assertGt(WAD - q.fairUp, q.sellDown);
        // buyDown = 1 - sellUp ; buyUp = 1 - sellDown
        assertEq(q.buyDown, WAD - q.sellUp);
        assertEq(q.buyUp, WAD - q.sellDown);
        // buying both sides always costs more than the $1 payout
        assertEq(q.buyUp + q.buyDown, WAD + 2 * e);
    }

    function test_Quote_FollowsSpot() public {
        uint256 id = _create(3600);
        uint256 before_ = _q(id).fairUp;
        _setPrice(SPOT8 + 5e8);
        uint256 afterUp = _q(id).fairUp;
        assertGt(afterUp, before_);
        _setPrice(SPOT8 - 5e8);
        assertLt(_q(id).fairUp, before_);
    }

    function test_Quote_ClampedHighFairMakesBuyUpUnavailable() public {
        uint256 id = _create(3600);
        _setPrice(2040e8); // +2%: far in the money
        Q memory q = _q(id);
        assertEq(q.fairUp, pm.MAX_FAIR());
        assertEq(q.buyUp, 0, "buy >= 0.99 reported as zero");
        assertEq(q.sellUp, 0.96e18);
        assertEq(q.buyDown, 0.04e18);
        assertEq(q.sellDown, 0.01e18, "sell floor");
    }

    function test_Quote_ClampedLowFairMakesBuyDownUnavailable() public {
        uint256 id = _create(3600);
        _setPrice(1960e8);
        Q memory q = _q(id);
        assertEq(q.fairUp, pm.MIN_FAIR());
        assertEq(q.buyDown, 0);
        assertEq(q.buyUp, 0.04e18);
        assertEq(q.sellUp, 0.01e18);
        assertEq(q.sellDown, 0.96e18);
    }

    function test_Quote_ZeroPricesInsideCloseBuffer() public {
        uint256 id = _create(300);
        vm.warp(_expiry(id) - 15);
        _refresh();
        Q memory q = _q(id);
        assertEq(q.timeLeft, 15);
        assertGt(q.fairUp, 0);
        assertEq(q.spot, SPOT);
        assertEq(q.buyUp + q.sellUp + q.buyDown + q.sellDown, 0);
    }

    function test_Quote_AllZeroAfterExpiry() public {
        uint256 id = _create(300);
        vm.warp(_expiry(id));
        Q memory q = _q(id);
        assertEq(q.fairUp + q.buyUp + q.sellUp + q.buyDown + q.sellDown + q.spot + q.sigma + q.timeLeft, 0);
    }

    function test_Quote_StaleOracleReverts() public {
        uint256 id = _create(3600);
        skip(121);
        vm.expectRevert(PriceOracleAdapter.StalePrice.selector);
        pm.quote(id);
    }

    function test_Quote_ReflectsOwnerEdge() public {
        uint256 id = _create(3600);
        vm.prank(owner);
        pm.setEdge(0.01e18);
        Q memory q = _q(id);
        assertEq(q.buyUp, q.fairUp + 0.01e18);
        assertEq(q.sellUp, q.fairUp - 0.01e18);
    }
}
