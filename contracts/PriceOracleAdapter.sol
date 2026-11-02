// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {ISettlementFeed} from "./interfaces/ISettlementFeed.sol";
import {BlackScholesLib} from "./lib/BlackScholesLib.sol";

/// @notice Normalizes Chainlink-compatible feeds and estimates annualized realized volatility.
/// @dev Feed configuration and replacements are trusted owner decisions. Reconfiguration resets
///      observations. Keep each asset's feed immutable in practice while its markets remain open.
///      Volatility is a time-consistent EWMA of annualized squared log returns between
///      observations: with lambdaEff = LAMBDA^(dt / MIN_OBS_INTERVAL),
///      var = lambdaEff * var + (1 - lambdaEff) * r^2 * YEAR / dt, seeded with defaultVol^2.
///      A return therefore adds about -ln(LAMBDA) * r^2 * YEAR / MIN_OBS_INTERVAL whatever the
///      gap before it is observed, so delaying an observation cannot shrink a jump's weight.
contract PriceOracleAdapter is Ownable2Step {
    uint256 public constant MIN_OBS_INTERVAL = 60;
    /// @notice EWMA decay per MIN_OBS_INTERVAL seconds (WAD).
    uint256 public constant LAMBDA = 0.94e18;
    /// @dev ln(LAMBDA) in WAD.
    int256 private constant LN_LAMBDA = -61_875_403_718_087_472;
    uint256 private constant WAD = 1e18;
    uint256 private constant YEAR = 31_536_000;

    struct FeedConfig {
        AggregatorV3Interface feed;
        uint8 decimals;
        uint32 maxStaleness;
        uint256 minVol;
        uint256 maxVol;
        uint256 defaultVol;
        bool enabled;
        bool settlementFeed; // settles on ISettlementFeed.settlementAnswer, not on rounds
    }
    struct History {
        uint256 variance; // annualized WAD variance, capped at maxVol^2
        uint256 lastPrice;
        uint256 lastObservationTime;
        uint256 count;
        uint256 lastFeedTime; // feed updatedAt of the last observed round
    }

    mapping(uint8 => FeedConfig) private _feeds;
    mapping(uint8 => History) private _history;

    error RenounceDisabled();
    error InvalidConfiguration();
    error AssetNotEnabled(uint8 assetId);
    error InvalidRound();
    error StalePrice();
    error InvalidSettlementRound();
    error PhaseBoundaryRound();
    error InvalidNormalizedPrice();

    event FeedSet(
        uint8 indexed assetId, address indexed feed, uint8 decimals, uint32 maxStaleness,
        uint256 minVol, uint256 maxVol, uint256 defaultVol
    );
    event ObservationRecorded(uint8 indexed assetId, uint256 price, uint256 timestamp, uint8 count);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Ownership cannot be renounced; use the two-step ownership transfer instead.
    function renounceOwnership() public override { revert RenounceDisabled(); }

    /// @notice Register or replace a feed; annualized vols are WAD. Resets its price history
    ///         and seeds the variance with defaultVol^2.
    /// @dev Decimals are bounded to 36 and max volatility to 1000% for safe fixed-point arithmetic.
    ///      A feed answering SETTLE_WINDOW() is a settlement feed (see settlementPrice).
    function setFeed(
        uint8 assetId, address feed, uint32 maxStaleness,
        uint256 minVol, uint256 maxVol, uint256 defaultVol
    ) external onlyOwner {
        if (feed == address(0) || feed.code.length == 0 || maxStaleness == 0
            || minVol == 0 || minVol > defaultVol || defaultVol > maxVol || maxVol > 10e18) {
            revert InvalidConfiguration();
        }
        uint8 d = AggregatorV3Interface(feed).decimals();
        if (d > 36) revert InvalidConfiguration();
        bool settles = false;
        try ISettlementFeed(feed).SETTLE_WINDOW() returns (uint256) { settles = true; } catch {}
        _feeds[assetId] = FeedConfig(
            AggregatorV3Interface(feed), d, maxStaleness, minVol, maxVol, defaultVol, true, settles
        );
        delete _history[assetId];
        _history[assetId].variance = defaultVol * defaultVol / WAD;
        emit FeedSet(assetId, feed, d, maxStaleness, minVol, maxVol, defaultVol);
    }

    /// @notice Read a fresh, complete, positive feed answer in WAD.
    function getPrice(uint8 assetId) public view returns (uint256 price1e18, uint256 updatedAt) {
        FeedConfig storage c = _config(assetId);
        (uint80 id, int256 answer,, uint256 timestamp, uint80 answeredInRound) = c.feed.latestRoundData();
        if (id == 0 || answer <= 0 || timestamp == 0 || timestamp > block.timestamp || answeredInRound < id) {
            revert InvalidRound();
        }
        if (block.timestamp - timestamp > c.maxStaleness) revert StalePrice();
        return (_normalize(answer, c.decimals), timestamp);
    }

    /// @notice Read a complete, positive WAD price with age bounded by both feed policy and maxAge.
    function getPriceMaxAge(uint8 assetId, uint256 maxAge)
        external view returns (uint256 price1e18, uint256 updatedAt)
    {
        (price1e18, updatedAt) = getPrice(assetId);
        if (block.timestamp - updatedAt > maxAge) revert StalePrice();
    }

    /// @notice Best-effort fresh observation. Stale/unavailable feeds, rate limits and feed rounds
    ///         not newer than the last observed round are no-ops.
    /// @dev Observations use sampling timestamps, not feed timestamps, to measure elapsed returns.
    ///      Skipping a round already seen keeps a poke from moving sigma without new information,
    ///      matching getVol, which applies no provisional step in that case. Rounds are compared
    ///      by feed updatedAt, not sampling time: a pull feed (StreamsFeed) stamps a round with the
    ///      report's observation time, which can precede a poke made before the report landed.
    ///      The event count saturates at 255; getObservationCount is exact.
    function poke(uint8 assetId) external {
        History storage h = _history[assetId];
        if (h.count != 0 && block.timestamp - h.lastObservationTime < MIN_OBS_INTERVAL) return;
        try this.getPrice(assetId) returns (uint256 price, uint256 updatedAt) {
            if (h.count != 0) {
                if (updatedAt <= h.lastFeedTime) return;
                h.variance = _nextVariance(_feeds[assetId], h, price, block.timestamp - h.lastObservationTime);
            }
            h.lastPrice = price;
            h.lastObservationTime = block.timestamp;
            h.lastFeedTime = updatedAt;
            uint256 count = ++h.count;
            emit ObservationRecorded(assetId, price, block.timestamp, count > type(uint8).max ? type(uint8).max : uint8(count));
        } catch { return; }
    }

    /// @notice Annualized EWMA volatility, clamped to [minVol, maxVol].
    /// @dev Includes a provisional observation of the current fresh feed price, exactly what the
    ///      next poke would record (dt floored at MIN_OBS_INTERVAL), so sigma matches the spot
    ///      being traded instead of lagging it by up to one poke interval. A stale or unavailable
    ///      feed, a feed round not newer than the last observed one, or no previous observation
    ///      uses the stored variance.
    function getVol(uint8 assetId) external view returns (uint256 sigma) {
        FeedConfig storage c = _config(assetId);
        History storage h = _history[assetId];
        uint256 variance = h.variance;
        if (h.count != 0) {
            try this.getPrice(assetId) returns (uint256 price, uint256 updatedAt) {
                if (updatedAt > h.lastFeedTime) {
                    uint256 dt = block.timestamp - h.lastObservationTime;
                    variance = _nextVariance(c, h, price, dt < MIN_OBS_INTERVAL ? MIN_OBS_INTERVAL : dt);
                }
            } catch {}
        }
        sigma = BlackScholesLib.sqrt(variance * WAD);
        if (sigma < c.minVol) return c.minVol;
        if (sigma > c.maxVol) return c.maxVol;
    }

    /// @notice The first complete feed round at/after expiry; no current-price staleness check.
    ///         A settlement feed ignores roundId and returns its final answer for expiry (it
    ///         reverts while there is none).
    /// @dev Only roundId == 1 needs no predecessor. The predecessor only has to exist and be
    ///      strictly before expiry; its answer is not used. Phase-boundary first rounds cannot
    ///      prove earliest-round status and revert, and an invalid first round at/after expiry
    ///      blocks every later round; affected markets can void after the void delay.
    function settlementPrice(uint8 assetId, uint80 roundId, uint256 expiry)
        external view returns (uint256 price1e18)
    {
        FeedConfig storage c = _config(assetId);
        if (c.settlementFeed) {
            (int256 settled,) = ISettlementFeed(address(c.feed)).settlementAnswer(expiry);
            if (settled <= 0) revert InvalidSettlementRound();
            return _normalize(settled, c.decimals);
        }
        (uint80 id, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = c.feed.getRoundData(roundId);
        uint64 localRound = uint64(roundId);
        if (id != roundId || localRound == 0 || answer <= 0 || updatedAt == 0
            || updatedAt < expiry || updatedAt > block.timestamp || answeredInRound < roundId) {
            revert InvalidSettlementRound();
        }
        if (localRound == 1 && roundId != 1) revert PhaseBoundaryRound();
        if (roundId != 1) {
            try c.feed.getRoundData(roundId - 1) returns (uint80 previousId, int256, uint256, uint256 previousTime, uint80) {
                if (previousId != roundId - 1 || previousTime == 0 || previousTime >= expiry) {
                    revert InvalidSettlementRound();
                }
            } catch { revert InvalidSettlementRound(); }
        }
        return _normalize(answer, c.decimals);
    }

    /// @notice Number of observations recorded since the feed was last configured.
    function getObservationCount(uint8 assetId) external view returns (uint256) {
        _config(assetId);
        return _history[assetId].count;
    }

    /// @dev One EWMA step from the last observation to `price` after `dt` (>= MIN_OBS_INTERVAL) seconds.
    ///      Prices fit int256, so |r| < 180e18 and r^2 * YEAR stays far below 2^256. The result is
    ///      capped at maxVol^2 so one extreme observation cannot pin sigma at maxVol for hours.
    ///      Gaps of a day or more skip exp (lambdaEff is below 1e-37 there): the sample takes all
    ///      the weight.
    function _nextVariance(FeedConfig storage c, History storage h, uint256 price, uint256 dt)
        private view returns (uint256 variance)
    {
        // Difference of logs avoids a lossy or overflowing p / p_previous.
        int256 r = BlackScholesLib.ln(int256(price)) - BlackScholesLib.ln(int256(h.lastPrice));
        uint256 magnitude = uint256(r < 0 ? -r : r);
        uint256 sample = magnitude * magnitude * YEAR / dt / WAD;
        uint256 decay = dt >= 1 days
            ? 0
            : uint256(BlackScholesLib.expWad(LN_LAMBDA * int256(dt) / int256(MIN_OBS_INTERVAL)));
        variance = (decay * h.variance + (WAD - decay) * sample) / WAD;
        uint256 cap = c.maxVol * c.maxVol / WAD;
        if (variance > cap) variance = cap;
    }

    function _config(uint8 assetId) private view returns (FeedConfig storage c) {
        c = _feeds[assetId];
        if (!c.enabled) revert AssetNotEnabled(assetId);
    }

    function _normalize(int256 answer, uint8 d) private pure returns (uint256 price) {
        uint256 value = uint256(answer);
        if (d <= 18) {
            uint256 scale = 10 ** (18 - d);
            if (value > uint256(type(int256).max) / scale) revert InvalidNormalizedPrice();
            price = value * scale;
        } else {
            price = value / (10 ** (d - 18));
        }
        if (price == 0 || price > uint256(type(int256).max)) revert InvalidNormalizedPrice();
    }
}
