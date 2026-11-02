// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {ISettlementFeed} from "./interfaces/ISettlementFeed.sol";

/// @notice The Chainlink Data Streams VerifierProxy calls used here ("VerifierProxy 2.0.0", llo-feeds v0.3.0).
interface IVerifierProxy {
    /// @dev payload = abi.encode(bytes32[3] reportContext, bytes reportData, bytes32[] rs, bytes32[] ss,
    ///      bytes32 rawVs). Returns reportData once the DON signatures check out.
    function verify(bytes calldata payload, bytes calldata parameterPayload)
        external payable returns (bytes memory verifierResponse);
    function s_feeManager() external view returns (address);
}

/// @notice AggregatorV3 feed made of verified Chainlink Data Streams reports for one stream, so
///         PriceOracleAdapter and PredictionMarket read it like any Chainlink feed.
/// @dev Anyone may submit a signed report; the VerifierProxy checks the signatures. Each report
///      newer than the latest round appends round latestRound + 1 (ids 1, 2, 3, ...) with
///      updatedAt = startedAt = the report's observationsTimestamp, which strictly increases.
///      Supported report schemas, chosen by the first two bytes of the stream id: v2 (price; the
///      24/7 equity streams), v3 (crypto: price, bid, ask) and v8 (RWA: midPrice, marketStatus,
///      accepted only while the market is open).
///      Settlement fairness: markets settle on submitSettlement records, not on trading rounds.
///      Each expiry takes the earliest report observed in [expiry, expiry + SETTLE_WINDOW]: any
///      earlier one replaces a later one for DISPUTE_PERIOD after the first submission. Several
///      reports can share one observationsTimestamp (whole seconds) with different prices, so a
///      tie goes to the smaller keccak256 of the verified report data, and every record, even an
///      exact-expiry one, waits out DISPUTE_PERIOD. The first submitter therefore cannot pick the
///      price; anyone holding an earlier (or same-second, smaller-hash) report overrides them.
///      Historical reports are accepted there, so no one has to win a race at expiry. If no
///      report lands in the window, the market voids after PredictionMarket.VOID_DELAY.
///      Trading rounds (submit) accept a report only within maxReportAge (deployed at 5 s) of its
///      observation, which bounds how far back a trader can pick the round they trade on.
///      Residual risk: latency arbitrage of instantly priced trades remains (a trader who sees a
///      move before it lands on chain can submit it and trade in one transaction); the full fix
///      is two-step, delayed execution.
///      Fees: verification on Arc runs on subscription billing and the proxy's fee manager is
///      zero. If Chainlink ever sets a fee manager, submit reverts with FeesNotSupported (this
///      contract holds no fee tokens) and a new feed is needed.
contract StreamsFeed is AggregatorV3Interface, ISettlementFeed {
    struct Round {
        int192 answer;
        uint32 timestamp;
    }
    struct Settlement {
        int192 answer;
        uint32 observedAt;
        uint32 firstSubmittedAt; // 0 = no report yet
        bytes32 reportHash; // keccak256 of the verified report data; breaks same-second ties
    }
    struct ReportV2 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 price;
    }
    struct ReportV3 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 price;
        int192 bid;
        int192 ask;
    }
    struct ReportV8 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        uint64 lastUpdateTimestamp;
        int192 midPrice;
        uint32 marketStatus;
    }

    uint32 private constant MARKET_OPEN = 2; // v8 marketStatus: 0 unknown, 1 closed, 2 open
    /// @notice Seconds after expiry a settlement report may be observed.
    uint256 public constant override SETTLE_WINDOW = 10;
    /// @notice Seconds after the first settlement report during which an earlier one replaces it
    ///         (or a same-second one with a smaller report hash).
    uint256 public constant DISPUTE_PERIOD = 300;

    IVerifierProxy public immutable verifierProxy;
    bytes32 public immutable feedId;
    uint8 public immutable override decimals;
    uint256 public immutable maxReportAge;
    uint16 private immutable _schema;
    string public override description;
    uint256 public constant override version = 1;
    uint80 public latestRound;
    mapping(uint80 => Round) private _rounds;
    /// @notice Settlement record per expiry; see settlementAnswer for the final value.
    mapping(uint256 => Settlement) public settlements;

    error InvalidConfiguration();
    error UnsupportedSchema(uint16 schema);
    error FeesNotSupported();
    error FeedIdMismatch(bytes32 reported);
    error InvalidPrice();
    error MarketNotOpen(uint32 marketStatus);
    error ReportFromFuture();
    error StaleReport();
    error NoDataPresent();
    error OutsideSettlementWindow();
    error SettlementNotFinal();

    /// @dev Same event as Chainlink aggregators (and MockAggregator), so one listener fits both networks.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event SettlementSubmitted(uint256 indexed expiry, int256 answer, uint256 observedAt);

    /// @param decimals_ Price decimals of the stream (Data Streams prices are 18 decimals).
    constructor(
        address verifierProxy_, bytes32 feedId_, uint8 decimals_, string memory description_, uint256 maxReportAge_
    ) {
        uint16 schema = uint16(uint256(feedId_) >> 240);
        if (schema != 2 && schema != 3 && schema != 8) revert UnsupportedSchema(schema);
        if (verifierProxy_.code.length == 0 || maxReportAge_ == 0 || decimals_ > 36) revert InvalidConfiguration();
        verifierProxy = IVerifierProxy(verifierProxy_);
        feedId = feedId_;
        decimals = decimals_;
        description = description_;
        maxReportAge = maxReportAge_;
        _schema = schema;
    }

    /// @notice Verify a full Data Streams report and append it as the next round.
    /// @return added False when the report is not newer than the latest round (a racing
    ///         submitter got there first); nothing changes then.
    function submit(bytes calldata fullReport) external returns (bool added) {
        (uint32 observedAt, int192 price,) = _verify(fullReport);
        if (observedAt > block.timestamp) revert ReportFromFuture();
        if (block.timestamp - observedAt > maxReportAge) revert StaleReport();
        uint80 id = latestRound;
        if (id != 0 && observedAt <= _rounds[id].timestamp) return false;
        _rounds[++id] = Round(price, observedAt);
        latestRound = id;
        emit AnswerUpdated(price, id, observedAt);
        return true;
    }

    /// @notice Verify a full report observed in [expiry, expiry + SETTLE_WINDOW] and record it as
    ///         the settlement price of `expiry`. Reports of any age are accepted.
    /// @return stored False when a record exists and this report is not strictly earlier (or, observed
    ///         in the same second, has no smaller report hash), or the record is final; nothing changes then.
    function submitSettlement(bytes calldata fullReport, uint256 expiry) external returns (bool stored) {
        (uint32 observedAt, int192 price, bytes32 hash) = _verify(fullReport);
        if (observedAt > block.timestamp) revert ReportFromFuture();
        if (observedAt < expiry || observedAt - expiry > SETTLE_WINDOW) revert OutsideSettlementWindow();
        Settlement storage s = settlements[expiry];
        if (s.firstSubmittedAt == 0) {
            s.firstSubmittedAt = uint32(block.timestamp);
        } else if (_final(s) || observedAt > s.observedAt || (observedAt == s.observedAt && hash >= s.reportHash)) {
            return false;
        }
        (s.answer, s.observedAt, s.reportHash) = (price, observedAt, hash);
        emit SettlementSubmitted(expiry, price, observedAt);
        return true;
    }

    /// @notice The final settlement price of `expiry`. Reverts NoDataPresent without a report and
    ///         SettlementNotFinal while an earlier report could still replace it.
    function settlementAnswer(uint256 expiry) external view override returns (int256 answer, uint256 observedAt) {
        Settlement storage s = settlements[expiry];
        if (s.firstSubmittedAt == 0) revert NoDataPresent();
        if (!_final(s)) revert SettlementNotFinal();
        return (s.answer, s.observedAt);
    }

    /// @dev Time-based only: a same-second report can still replace even an exact-expiry record.
    function _final(Settlement storage s) private view returns (bool) {
        return block.timestamp >= uint256(s.firstSubmittedAt) + DISPUTE_PERIOD;
    }

    /// @dev Verifies a full report for this stream and returns its observation time, a positive price
    ///      and the hash of the verified report data (signature-independent).
    function _verify(bytes calldata fullReport) private returns (uint32 observedAt, int192 price, bytes32 hash) {
        if (verifierProxy.s_feeManager() != address(0)) revert FeesNotSupported();
        bytes memory data = verifierProxy.verify(fullReport, "");
        // feedId is the first field of every schema; checking it first also pins the schema.
        bytes32 reported = bytes32(data);
        if (reported != feedId) revert FeedIdMismatch(reported);
        if (_schema == 2) {
            ReportV2 memory r = abi.decode(data, (ReportV2));
            (observedAt, price) = (r.observationsTimestamp, r.price);
        } else if (_schema == 3) {
            ReportV3 memory r = abi.decode(data, (ReportV3));
            (observedAt, price) = (r.observationsTimestamp, r.price);
        } else {
            ReportV8 memory r = abi.decode(data, (ReportV8));
            if (r.marketStatus != MARKET_OPEN) revert MarketNotOpen(r.marketStatus);
            (observedAt, price) = (r.observationsTimestamp, r.midPrice);
        }
        if (price <= 0) revert InvalidPrice();
        hash = keccak256(data);
    }

    /// @notice Reverts with NoDataPresent for round 0 or a round not yet submitted.
    function getRoundData(uint80 roundId) public view override returns (
        uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        if (roundId == 0 || roundId > latestRound) revert NoDataPresent();
        Round storage r = _rounds[roundId];
        return (roundId, r.answer, r.timestamp, r.timestamp, roundId);
    }

    /// @notice Reverts with NoDataPresent before the first report.
    function latestRoundData() external view override returns (
        uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return getRoundData(latestRound);
    }
}
