// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {StreamsFeed} from "../StreamsFeed.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {MockVerifierProxy} from "./helpers/MockVerifierProxy.sol";
import {MockUSDC} from "./PredictionMarket.Base.t.sol";

contract StreamsFeedTest is Test {
    bytes32 internal constant BTC_V3 = 0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8;
    bytes32 internal constant NVDA_V2 = 0x0002d9b165cfb7309e8a13af14cbbb608d9990f9fa094d2ac6199d2567f2dae8;
    bytes32 internal constant NVDA_V8 = 0x0008adc184847ba8d17f0030c15e78f61b83eda2e190f30346c4ea3babed647d;
    uint256 internal constant T0 = 1_793_553_400;
    uint256 internal constant MAX_AGE = 30;

    MockVerifierProxy internal proxy;
    StreamsFeed internal btc;
    StreamsFeed internal nvda;
    StreamsFeed internal nvdaEquity;

    function setUp() public {
        vm.warp(T0);
        proxy = new MockVerifierProxy();
        btc = new StreamsFeed(address(proxy), BTC_V3, 18, "BTC / USD", MAX_AGE);
        nvda = new StreamsFeed(address(proxy), NVDA_V2, 18, "NVDA / USD", MAX_AGE);
        nvdaEquity = new StreamsFeed(address(proxy), NVDA_V8, 18, "NVDA / USD equity", MAX_AGE);
    }

    // ------------------------------------------------------------------ report builders
    function _full(bytes memory reportData) internal pure returns (bytes memory) {
        bytes32[3] memory ctx;
        return abi.encode(ctx, reportData, new bytes32[](0), new bytes32[](0), bytes32(0));
    }

    function _v3Data(bytes32 id, uint256 obs, int192 price) internal pure returns (bytes memory) {
        return abi.encode(StreamsFeed.ReportV3(
            id, uint32(obs), uint32(obs), 0, 0, uint32(obs + 86400), price, price - 1e18, price + 1e18
        ));
    }

    function _v3(bytes32 id, uint256 obs, int192 price) internal pure returns (bytes memory) {
        return _full(_v3Data(id, obs, price));
    }

    function _v2(bytes32 id, uint256 obs, int192 price) internal pure returns (bytes memory) {
        return _full(abi.encode(StreamsFeed.ReportV2(id, uint32(obs), uint32(obs), 0, 0, uint32(obs + 86400), price)));
    }

    function _v8(bytes32 id, uint256 obs, int192 price, uint32 status) internal pure returns (bytes memory) {
        return _full(abi.encode(StreamsFeed.ReportV8(
            id, uint32(obs), uint32(obs), 0, 0, uint32(obs + 86400), uint64(obs * 1e9), price, status
        )));
    }

    function _assertLatest(StreamsFeed f, uint80 round, int256 price, uint256 at) internal view {
        (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) = f.latestRoundData();
        assertEq(id, round, "round id");
        assertEq(answer, price, "answer");
        assertEq(startedAt, at, "startedAt");
        assertEq(updatedAt, at, "updatedAt");
        assertEq(answeredIn, round, "answeredInRound");
    }

    // ------------------------------------------------------------------ decoding
    function test_V3_AppendsRoundAndEmitsAnswerUpdated() public {
        vm.expectEmit(true, true, false, true, address(btc));
        emit StreamsFeed.AnswerUpdated(78_000e18, 1, T0 - 2);
        assertTrue(btc.submit(_v3(BTC_V3, T0 - 2, 78_000e18)));
        _assertLatest(btc, 1, 78_000e18, T0 - 2);
        skip(5);
        assertTrue(btc.submit(_v3(BTC_V3, T0 + 4, 78_100e18)));
        _assertLatest(btc, 2, 78_100e18, T0 + 4);
        (, int256 first,, uint256 firstAt,) = btc.getRoundData(1);
        assertEq(first, 78_000e18);
        assertEq(firstAt, T0 - 2);
        assertEq(btc.decimals(), 18);
        assertEq(btc.description(), "BTC / USD");
    }

    function test_V2_247EquityStream() public {
        assertTrue(nvda.submit(_v2(NVDA_V2, T0, 205e18)));
        _assertLatest(nvda, 1, 205e18, T0);
    }

    function test_V8_OpenMarketAccepted_ClosedOrUnknownRejected() public {
        assertTrue(nvdaEquity.submit(_v8(NVDA_V8, T0 - 1, 205e18, 2)));
        _assertLatest(nvdaEquity, 1, 205e18, T0 - 1);
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.MarketNotOpen.selector, uint32(1)));
        nvdaEquity.submit(_v8(NVDA_V8, T0, 206e18, 1));
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.MarketNotOpen.selector, uint32(0)));
        nvdaEquity.submit(_v8(NVDA_V8, T0, 206e18, 0));
    }

    // ------------------------------------------------------------------ validation
    function test_WrongFeedIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.FeedIdMismatch.selector, NVDA_V2));
        btc.submit(_v3(NVDA_V2, T0, 78_000e18));
        // another stream of the same schema
        bytes32 eth = 0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9;
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.FeedIdMismatch.selector, eth));
        btc.submit(_v3(eth, T0, 2_000e18));
    }

    function test_StaleReportReverts_BoundaryAccepted() public {
        vm.expectRevert(StreamsFeed.StaleReport.selector);
        btc.submit(_v3(BTC_V3, T0 - MAX_AGE - 1, 78_000e18));
        assertTrue(btc.submit(_v3(BTC_V3, T0 - MAX_AGE, 78_000e18)));
    }

    function test_FutureReportReverts() public {
        vm.expectRevert(StreamsFeed.ReportFromFuture.selector);
        btc.submit(_v3(BTC_V3, T0 + 1, 78_000e18));
    }

    function test_NonPositivePriceReverts() public {
        vm.expectRevert(StreamsFeed.InvalidPrice.selector);
        btc.submit(_v3(BTC_V3, T0, -1));
        vm.expectRevert(StreamsFeed.InvalidPrice.selector);
        nvda.submit(_v2(NVDA_V2, T0, 0));
        vm.expectRevert(StreamsFeed.InvalidPrice.selector);
        nvdaEquity.submit(_v8(NVDA_V8, T0, -5, 2));
    }

    /// @notice Racing submitters: an equal or older report is a no-op, not a revert.
    function test_NotNewerReportIsNoOp() public {
        assertTrue(btc.submit(_v3(BTC_V3, T0 - 5, 78_000e18)));
        vm.recordLogs();
        assertFalse(btc.submit(_v3(BTC_V3, T0 - 5, 79_000e18)), "equal timestamp");
        assertFalse(btc.submit(_v3(BTC_V3, T0 - 6, 79_000e18)), "older");
        assertEq(vm.getRecordedLogs().length, 0, "no event");
        _assertLatest(btc, 1, 78_000e18, T0 - 5);
        assertTrue(btc.submit(_v3(BTC_V3, T0 - 4, 79_000e18)));
        assertEq(btc.latestRound(), 2);
    }

    function test_FeeManagerSetReverts() public {
        proxy.setFeeManager(makeAddr("feeManager"));
        vm.expectRevert(StreamsFeed.FeesNotSupported.selector);
        btc.submit(_v3(BTC_V3, T0, 78_000e18));
    }

    function test_VerificationFailureBubbles() public {
        proxy.setRejectAll(true);
        vm.expectRevert(MockVerifierProxy.BadVerification.selector);
        btc.submit(_v3(BTC_V3, T0, 78_000e18));
    }

    function test_Constructor_RejectsUnknownSchemaAndBadConfig() public {
        bytes32 v4 = 0x0004d9b165cfb7309e8a13af14cbbb608d9990f9fa094d2ac6199d2567f2dae8;
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.UnsupportedSchema.selector, uint16(4)));
        new StreamsFeed(address(proxy), v4, 18, "X", MAX_AGE);
        bytes32 v11 = 0x000bd9b165cfb7309e8a13af14cbbb608d9990f9fa094d2ac6199d2567f2dae8;
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.UnsupportedSchema.selector, uint16(11)));
        new StreamsFeed(address(proxy), v11, 18, "X", MAX_AGE);
        vm.expectRevert(StreamsFeed.InvalidConfiguration.selector);
        new StreamsFeed(makeAddr("eoa"), BTC_V3, 18, "X", MAX_AGE);
        vm.expectRevert(StreamsFeed.InvalidConfiguration.selector);
        new StreamsFeed(address(proxy), BTC_V3, 18, "X", 0);
        vm.expectRevert(StreamsFeed.InvalidConfiguration.selector);
        new StreamsFeed(address(proxy), BTC_V3, 37, "X", MAX_AGE);
    }

    function test_UnknownRoundsRevert() public {
        vm.expectRevert(StreamsFeed.NoDataPresent.selector);
        btc.latestRoundData();
        vm.expectRevert(StreamsFeed.NoDataPresent.selector);
        btc.getRoundData(0);
        btc.submit(_v3(BTC_V3, T0, 78_000e18));
        vm.expectRevert(StreamsFeed.NoDataPresent.selector);
        btc.getRoundData(2);
    }

    // ------------------------------------------------------------------ settlement reports
    uint256 internal constant EXP = T0 + 300;

    function test_Settlement_ExactExpiryFinalOnlyAfterDisputePeriod() public {
        vm.warp(EXP + 2);
        vm.expectEmit(true, false, false, true, address(btc));
        emit StreamsFeed.SettlementSubmitted(EXP, 78_000e18, EXP);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP, 78_000e18), EXP));
        vm.expectRevert(StreamsFeed.SettlementNotFinal.selector);
        btc.settlementAnswer(EXP);
        skip(btc.DISPUTE_PERIOD());
        (int256 answer, uint256 at) = btc.settlementAnswer(EXP);
        assertEq(answer, 78_000e18);
        assertEq(at, EXP);
        assertEq(btc.latestRound(), 0, "settlement reports are not trading rounds");
    }

    function test_Settlement_LaterReportFinalOnlyAfterDisputePeriod() public {
        vm.warp(EXP + 5);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP + 3, 78_000e18), EXP));
        vm.expectRevert(StreamsFeed.SettlementNotFinal.selector);
        btc.settlementAnswer(EXP);
        vm.warp(EXP + 5 + btc.DISPUTE_PERIOD() - 1);
        vm.expectRevert(StreamsFeed.SettlementNotFinal.selector);
        btc.settlementAnswer(EXP);
        skip(1);
        (int256 answer, uint256 at) = btc.settlementAnswer(EXP);
        assertEq(answer, 78_000e18);
        assertEq(at, EXP + 3);
    }

    function test_Settlement_EarlierReplacesLaterDuringDispute() public {
        vm.warp(EXP + 9);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP + 8, 70_000e18), EXP));
        skip(100);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP + 4, 78_000e18), EXP));
        (int256 answer, uint256 at, uint32 first,) = btc.settlements(EXP);
        assertEq(answer, 78_000e18);
        assertEq(at, EXP + 4);
        assertEq(first, EXP + 9, "the dispute period runs from the first submission");
        vm.warp(EXP + 9 + btc.DISPUTE_PERIOD());
        (answer,) = btc.settlementAnswer(EXP);
        assertEq(answer, 78_000e18);
    }

    function test_Settlement_LaterOrSameReportNeverReplaces() public {
        vm.warp(EXP + 6);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP + 4, 78_000e18), EXP));
        vm.recordLogs();
        assertFalse(btc.submitSettlement(_v3(BTC_V3, EXP + 4, 78_000e18), EXP), "same report");
        assertFalse(btc.submitSettlement(_v3(BTC_V3, EXP + 5, 70_000e18), EXP), "later");
        assertEq(vm.getRecordedLogs().length, 0, "no event");
        (int256 answer, uint256 at,,) = btc.settlements(EXP);
        assertEq(answer, 78_000e18);
        assertEq(at, EXP + 4);
    }

    /// @notice Attack regression: two signed reports share the expiry second with different prices.
    ///         Whoever lands first, the one with the smaller report hash is the settlement price,
    ///         and an exact-expiry record is not final before DISPUTE_PERIOD.
    function test_Settlement_SameSecondTieGoesToSmallerHash() public {
        (int192 a, int192 b) = (77_999e18, 78_001e18);
        (int192 canonical, int192 other) =
            keccak256(_v3Data(BTC_V3, EXP, a)) < keccak256(_v3Data(BTC_V3, EXP, b)) ? (a, b) : (b, a);
        vm.warp(EXP + 1);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP, other), EXP), "attacker first");
        vm.expectRevert(StreamsFeed.SettlementNotFinal.selector);
        btc.settlementAnswer(EXP);
        skip(30);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP, canonical), EXP), "canonical overrides");
        assertFalse(btc.submitSettlement(_v3(BTC_V3, EXP, other), EXP), "and stays");
        (,,, bytes32 h) = btc.settlements(EXP);
        assertEq(h, keccak256(_v3Data(BTC_V3, EXP, canonical)));
        vm.warp(EXP + 1 + btc.DISPUTE_PERIOD());
        (int256 answer, uint256 at) = btc.settlementAnswer(EXP);
        assertEq(answer, canonical);
        assertEq(at, EXP);
    }

    function test_Settlement_FinalRecordNeverChanges() public {
        // an exact-expiry record after the dispute period: a same-second report is refused
        vm.warp(EXP + 1);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP, 78_000e18), EXP));
        skip(btc.DISPUTE_PERIOD());
        assertFalse(btc.submitSettlement(_v3(BTC_V3, EXP, 70_000e18), EXP));
        assertFalse(btc.submitSettlement(_v3(BTC_V3, EXP, 79_000e18), EXP));
        // final by elapsed dispute period: even an earlier report is refused
        uint256 exp2 = EXP + 600;
        vm.warp(exp2 + 10);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, exp2 + 10, 78_000e18), exp2));
        skip(btc.DISPUTE_PERIOD());
        assertFalse(btc.submitSettlement(_v3(BTC_V3, exp2, 70_000e18), exp2));
        (int256 a1,) = btc.settlementAnswer(EXP);
        (int256 a2, uint256 at2) = btc.settlementAnswer(exp2);
        assertEq(a1, 78_000e18);
        assertEq(a2, 78_000e18);
        assertEq(at2, exp2 + 10);
    }

    function test_Settlement_OutsideWindowAndFutureRevert() public {
        vm.warp(EXP + 60);
        vm.expectRevert(StreamsFeed.OutsideSettlementWindow.selector);
        btc.submitSettlement(_v3(BTC_V3, EXP - 1, 78_000e18), EXP);
        vm.expectRevert(StreamsFeed.OutsideSettlementWindow.selector);
        btc.submitSettlement(_v3(BTC_V3, EXP + 11, 78_000e18), EXP);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP + 10, 78_000e18), EXP), "window edge");
        vm.warp(EXP + 600);
        vm.expectRevert(StreamsFeed.ReportFromFuture.selector);
        btc.submitSettlement(_v3(BTC_V3, EXP + 601, 78_000e18), EXP + 601);
        vm.expectRevert(StreamsFeed.NoDataPresent.selector);
        btc.settlementAnswer(EXP + 601);
    }

    /// @notice Settlement has no maxReportAge: a report from hours ago still settles its expiry.
    function test_Settlement_HistoricalReportAccepted() public {
        vm.warp(EXP + 6 hours);
        vm.expectRevert(StreamsFeed.StaleReport.selector);
        btc.submit(_v3(BTC_V3, EXP, 78_000e18));
        assertTrue(btc.submitSettlement(_v3(BTC_V3, EXP, 78_000e18), EXP));
        skip(btc.DISPUTE_PERIOD());
        (int256 answer,) = btc.settlementAnswer(EXP);
        assertEq(answer, 78_000e18);
    }

    /// @notice The settlement path runs the same verification and decoding checks as submit.
    function test_Settlement_SharesReportChecks() public {
        vm.warp(EXP + 1);
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.FeedIdMismatch.selector, NVDA_V2));
        btc.submitSettlement(_v3(NVDA_V2, EXP, 78_000e18), EXP);
        vm.expectRevert(StreamsFeed.InvalidPrice.selector);
        btc.submitSettlement(_v3(BTC_V3, EXP, 0), EXP);
        vm.expectRevert(abi.encodeWithSelector(StreamsFeed.MarketNotOpen.selector, uint32(1)));
        nvdaEquity.submitSettlement(_v8(NVDA_V8, EXP, 205e18, 1), EXP);
        assertTrue(nvda.submitSettlement(_v2(NVDA_V2, EXP, 205e18), EXP));
        proxy.setRejectAll(true);
        vm.expectRevert(MockVerifierProxy.BadVerification.selector);
        btc.submitSettlement(_v3(BTC_V3, EXP, 78_000e18), EXP);
        proxy.setRejectAll(false);
        proxy.setFeeManager(makeAddr("feeManager"));
        vm.expectRevert(StreamsFeed.FeesNotSupported.selector);
        btc.submitSettlement(_v3(BTC_V3, EXP, 78_000e18), EXP);
    }

    // ------------------------------------------------------------------ adapter + market
    function _wire() internal returns (PriceOracleAdapter oracle, PredictionMarket pm, MockUSDC usdc) {
        usdc = new MockUSDC(6);
        oracle = new PriceOracleAdapter(address(this));
        btc.submit(_v3(BTC_V3, block.timestamp, 78_000e18));
        oracle.setFeed(0, address(btc), 600, 0.30e18, 1.5e18, 0.55e18);
        pm = new PredictionMarket(address(usdc), address(oracle), address(this));
    }

    function _push(int192 price) internal {
        btc.submit(_v3(BTC_V3, block.timestamp - 1, price));
    }

    /// @notice A report observed before the last poke but submitted after it is still new
    ///         information: getVol prices it at once instead of waiting for a later report.
    function test_Adapter_LateLandingReportStillMovesSigma() public {
        (PriceOracleAdapter oracle,,) = _wire();
        oracle.poke(0);
        skip(60);
        btc.submit(_v3(BTC_V3, block.timestamp - 5, 78_000e18)); // observed T+55
        oracle.poke(0); // sampled at T+60
        uint256 calm = oracle.getVol(0);
        skip(1);
        btc.submit(_v3(BTC_V3, block.timestamp - 3, 79_500e18)); // observed T+58, lands at T+61
        (,,, uint256 updatedAt,) = btc.latestRoundData();
        assertLt(updatedAt, block.timestamp - 1, "observed before the poke sample");
        assertGt(oracle.getVol(0), calm, "the jump is in sigma before any later report");
    }

    function test_EndToEnd_CreateBuySellSettleClaim() public {
        (PriceOracleAdapter oracle, PredictionMarket pm, MockUSDC usdc) = _wire();
        address lp = makeAddr("lp");
        address alice = makeAddr("alice");
        usdc.mint(lp, 100_000e6);
        usdc.mint(alice, 10_000e6);
        vm.prank(lp);
        usdc.approve(address(pm), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(pm), type(uint256).max);
        vm.prank(lp);
        pm.deposit(100_000e6, 0);

        skip(10);
        _push(78_000e18);
        uint256 id = pm.createMarket(0, 0, 300);
        assertEq(pm.getMarket(id).strike, 78_000e18);
        uint256 expiry = pm.getMarket(id).expiry;

        skip(20);
        _push(78_050e18);
        vm.prank(alice);
        pm.buy(id, true, 1_000e6, type(uint256).max);
        skip(60);
        _push(78_100e18);
        vm.prank(alice);
        pm.sell(id, true, 400e6, 0);
        assertEq(oracle.getObservationCount(0), 2, "buy and sell poked the adapter");

        // trading rounds after expiry do not settle; the exact-expiry settlement report does,
        // after the dispute period and whatever roundId is passed
        vm.warp(expiry + 5);
        btc.submit(_v3(BTC_V3, expiry + 2, 70_000e18));
        uint80 round = btc.latestRound();
        vm.expectRevert(StreamsFeed.NoDataPresent.selector);
        pm.settle(id, round);
        btc.submitSettlement(_v3(BTC_V3, expiry, 78_300e18), expiry);
        vm.expectRevert(StreamsFeed.SettlementNotFinal.selector);
        pm.settle(id, 0);
        skip(btc.DISPUTE_PERIOD());
        pm.settle(id, 0);
        assertTrue(pm.getMarket(id).upWon);
        assertEq(pm.getMarket(id).settlePrice, 78_300e18);

        uint256 b0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pm.claim(id);
        assertEq(usdc.balanceOf(alice) - b0, 600e6);
    }

    /// @notice A settlement feed ignores roundId: a trading round at expiry does not settle.
    function test_Adapter_SettlementFeedIgnoresRounds() public {
        PriceOracleAdapter oracle = new PriceOracleAdapter(address(this));
        oracle.setFeed(0, address(btc), 600, 0.30e18, 1.5e18, 0.55e18);
        btc.submit(_v3(BTC_V3, T0, 78_000e18));
        vm.expectRevert(StreamsFeed.NoDataPresent.selector);
        oracle.settlementPrice(0, 1, T0);
        btc.submitSettlement(_v3(BTC_V3, T0, 79_000e18), T0);
        skip(btc.DISPUTE_PERIOD());
        assertEq(oracle.settlementPrice(0, 1, T0), 79_000e18);
        assertEq(oracle.settlementPrice(0, 0, T0), 79_000e18);
    }

    /// @notice Attack regression: a submitter with Streams credentials races in a favorable
    ///         report observed at expiry + 8; the honest exact-expiry report overrides it.
    function test_EndToEnd_FirstSubmitterCannotPickSettlement() public {
        (, PredictionMarket pm, MockUSDC usdc) = _wire();
        address lp = makeAddr("lp");
        usdc.mint(lp, 100_000e6);
        vm.startPrank(lp);
        usdc.approve(address(pm), type(uint256).max);
        pm.deposit(100_000e6, 0);
        vm.stopPrank();
        _push(78_000e18);
        uint256 id = pm.createMarket(0, 0, 300);
        uint256 expiry = pm.getMarket(id).expiry;

        vm.warp(expiry + 9);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        assertTrue(btc.submitSettlement(_v3(BTC_V3, expiry + 8, 77_000e18), expiry));
        vm.prank(attacker);
        vm.expectRevert(StreamsFeed.SettlementNotFinal.selector);
        pm.settle(id, 0);

        skip(30); // the keeper is late
        assertTrue(btc.submitSettlement(_v3(BTC_V3, expiry, 78_300e18), expiry));
        skip(btc.DISPUTE_PERIOD() - 30); // from the attacker's first submission
        pm.settle(id, 0);
        assertEq(pm.getMarket(id).settlePrice, 78_300e18);
        assertTrue(pm.getMarket(id).upWon);
    }

    function test_EndToEnd_NoSettlementReportVoids() public {
        (, PredictionMarket pm,) = _wire();
        _push(78_000e18);
        uint256 id = pm.createMarket(0, 0, 300);
        uint256 expiry = pm.getMarket(id).expiry;
        vm.warp(expiry + 30);
        _push(78_100e18); // trading rounds alone never settle
        uint80 round = btc.latestRound();
        vm.expectRevert(StreamsFeed.NoDataPresent.selector);
        pm.settle(id, round);
        vm.warp(expiry + pm.VOID_DELAY() - 1);
        vm.expectRevert(PredictionMarket.VoidTooEarly.selector);
        pm.voidMarket(id);
        skip(1);
        pm.voidMarket(id);
        assertEq(pm.getMarket(id).status, 2);
    }

    function test_AnswerUpdatedTopicsMatchChainlink() public {
        vm.recordLogs();
        btc.submit(_v3(BTC_V3, T0, 78_000e18));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], keccak256("AnswerUpdated(int256,uint256,uint256)"));
        assertEq(uint256(logs[0].topics[2]), 1);
        assertEq(abi.decode(logs[0].data, (uint256)), T0);
    }
}
