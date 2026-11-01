// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {BlackScholesLib} from "./lib/BlackScholesLib.sol";

/// @notice Normalizes Chainlink-compatible feeds and estimates annualized realized volatility.
/// @dev Feed configuration and replacements are trusted owner decisions. Reconfiguration resets
///      observations. Keep each asset's feed immutable in practice while its markets remain open.
contract PriceOracleAdapter is Ownable2Step {
    uint256 public constant MIN_OBS_INTERVAL = 60;
    uint256 public constant OBSERVATION_CAPACITY = 32;
    uint256 public constant MIN_VOL_OBSERVATIONS = 8;
    uint256 private constant YEAR = 31_536_000;

    struct FeedConfig {
        AggregatorV3Interface feed;
        uint8 decimals;
        uint32 maxStaleness;
        uint256 minVol;
        uint256 maxVol;
        uint256 defaultVol;
        bool enabled;
    }
    struct Observation { uint256 price; uint256 timestamp; }
    struct History {
        Observation[32] observations;
        uint8 next;
        uint8 count;
        uint256 lastObservationTime;
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

    /// @notice Register or replace a feed; annualized vols are WAD. Resets its price history.
    /// @dev Decimals are bounded to 36 and max volatility to 1000% for safe fixed-point arithmetic.
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
        _feeds[assetId] = FeedConfig(AggregatorV3Interface(feed), d, maxStaleness, minVol, maxVol, defaultVol, true);
        delete _history[assetId];
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

    /// @notice Best-effort fresh observation. Stale/unavailable feeds and rate limits are no-ops.
    /// @dev Observations use sampling timestamps, not feed timestamps, to measure elapsed returns.
    function poke(uint8 assetId) external {
        History storage h = _history[assetId];
        if (h.count != 0 && block.timestamp - h.lastObservationTime < MIN_OBS_INTERVAL) return;
        try this.getPrice(assetId) returns (uint256 price, uint256) {
            h.observations[h.next] = Observation(price, block.timestamp);
            h.next = uint8((uint256(h.next) + 1) % OBSERVATION_CAPACITY);
            if (h.count < OBSERVATION_CAPACITY) ++h.count;
            h.lastObservationTime = block.timestamp;
            emit ObservationRecorded(assetId, price, block.timestamp, h.count);
        } catch { return; }
    }

    /// @notice Realized zero-drift annualized volatility from chronologically adjacent returns.
    function getVol(uint8 assetId) external view returns (uint256 sigma) {
        FeedConfig storage c = _config(assetId);
        History storage h = _history[assetId];
        uint256 count = h.count;
        if (count < MIN_VOL_OBSERVATIONS) return c.defaultVol;
        uint256 first = count == OBSERVATION_CAPACITY ? h.next : 0;
        uint256 sumSquares;
        uint256 sumDt;
        Observation memory previous = h.observations[first];
        for (uint256 i = 1; i < count; ++i) {
            Observation memory current = h.observations[(first + i) % OBSERVATION_CAPACITY];
            // Difference of logs avoids a lossy or overflowing p_i / p_(i-1).
            int256 r = BlackScholesLib.ln(int256(current.price)) - BlackScholesLib.ln(int256(previous.price));
            uint256 magnitude = uint256(r < 0 ? -r : r);
            sumSquares += magnitude * magnitude; // WAD squared
            sumDt += current.timestamp - previous.timestamp;
            previous = current;
        }
        if (sumDt == 0) return c.defaultVol;
        sigma = BlackScholesLib.sqrt(sumSquares * YEAR / sumDt);
        if (sigma < c.minVol) return c.minVol;
        if (sigma > c.maxVol) return c.maxVol;
    }

    /// @notice The first complete feed round at/after expiry; no current-price staleness check.
    /// @dev Only roundId == 1 needs no predecessor. Phase-boundary first rounds cannot
    ///      prove earliest-round status and revert; affected markets can void after the void delay.
    function settlementPrice(uint8 assetId, uint80 roundId, uint256 expiry)
        external view returns (uint256 price1e18)
    {
        FeedConfig storage c = _config(assetId);
        (uint80 id, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = c.feed.getRoundData(roundId);
        uint64 localRound = uint64(roundId);
        if (id != roundId || localRound == 0 || answer <= 0 || updatedAt == 0
            || updatedAt < expiry || updatedAt > block.timestamp || answeredInRound < roundId) {
            revert InvalidSettlementRound();
        }
        if (localRound == 1 && roundId != 1) revert PhaseBoundaryRound();
        if (roundId != 1) {
            try c.feed.getRoundData(roundId - 1) returns (
                uint80 previousId, int256 previousAnswer, uint256, uint256 previousTime, uint80 previousAnswered
            ) {
                if (previousId != roundId - 1 || previousAnswer <= 0 || previousTime == 0
                    || previousTime >= expiry || previousAnswered < previousId) revert InvalidSettlementRound();
            } catch { revert InvalidSettlementRound(); }
        }
        return _normalize(answer, c.decimals);
    }

    /// @notice Number of observations currently retained, capped at 32.
    function getObservationCount(uint8 assetId) external view returns (uint256) {
        _config(assetId);
        return _history[assetId].count;
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
