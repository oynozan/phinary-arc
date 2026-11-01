// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Signed WAD transcendental arithmetic and cash-or-nothing binary pricing.
/// @dev Dependency-free range reduction (powers of two), atanh log series,
///      Taylor exponential and Babylonian square root. CDF coefficients are
///      Abramowitz-Stegun 26.2.17 (absolute approximation error about 7.5e-8).
///      All signed rounding truncates toward zero; these are approximations, not an oracle.
library BlackScholesLib {
    int256 internal constant WAD = 1e18;
    int256 internal constant LN2 = 693147180559945309;
    uint256 internal constant YEAR = 31_536_000;

    error LogUndefined();
    error ExpOverflow();
    error InvalidPricingInput();

    /// @notice Natural logarithm of a strictly positive signed WAD.
    function lnWad(int256 x) internal pure returns (int256 result) {
        if (x <= 0) revert LogUndefined();
        int256 k;
        // Normalize to [1,2). At most 196 shifts for a positive int256.
        while (x < WAD) { x *= 2; --k; }
        while (x >= 2 * WAD) { x /= 2; ++k; }
        int256 z = (x - WAD) * WAD / (x + WAD);
        int256 z2 = z * z / WAD;
        int256 term = z;
        int256 sum = z;
        for (int256 n = 3; n <= 79; n += 2) {
            term = term * z2 / WAD;
            sum += term / n;
        }
        return 2 * sum + k * LN2;
    }

    /// @notice Alias allowing reuse by oracle volatility calculations.
    function ln(int256 x) internal pure returns (int256) { return lnWad(x); }

    /// @notice exp(x) in WAD. Very negative inputs underflow to zero.
    function expWad(int256 x) internal pure returns (int256) {
        if (x <= -42139678854452767551) return 0;
        if (x >= 135305999368893231589) revert ExpOverflow();
        int256 k = x / LN2;
        int256 r = x - k * LN2;
        if (r > LN2 / 2) { ++k; r -= LN2; }
        if (r < -LN2 / 2) { --k; r += LN2; }
        int256 term = WAD;
        int256 sum = WAD;
        for (int256 n = 1; n <= 24; ++n) {
            term = (term * r / WAD) / n;
            sum += term;
        }
        uint256 value = uint256(sum);
        if (k < 0) return int256(value >> uint256(-k));
        uint256 shift = uint256(k);
        if (value > uint256(type(int256).max) >> shift) revert ExpOverflow();
        return int256(value << shift);
    }

    /// @notice Floor square root of an unscaled integer (sqrt(WAD squared) is WAD).
    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        uint256 y = x;
        z = 1;
        if (y >> 128 != 0) { y >>= 128; z <<= 64; }
        if (y >> 64 != 0) { y >>= 64; z <<= 32; }
        if (y >> 32 != 0) { y >>= 32; z <<= 16; }
        if (y >> 16 != 0) { y >>= 16; z <<= 8; }
        if (y >> 8 != 0) { y >>= 8; z <<= 4; }
        if (y >> 4 != 0) { y >>= 4; z <<= 2; }
        if (y >> 2 != 0) z <<= 1;
        // Starting below the root by at most a factor of two; eight Newton steps suffice.
        for (uint256 i; i < 8; ++i) z = (z + x / z) / 2;
        uint256 other = x / z;
        return z < other ? z : other;
    }

    /// @notice Standard normal CDF; saturates outside +/-8 standard deviations.
    function normCdf(int256 x) internal pure returns (uint256) {
        if (x <= -8e18) return 0;
        if (x >= 8e18) return 1e18;
        if (x == 0) return 5e17;
        bool negative = x < 0;
        int256 a = negative ? -x : x;
        int256 t = WAD * WAD / (WAD + 231641900000000000 * a / WAD);
        int256 p = 1330274429000000000;
        p = -1821255978000000000 + p * t / WAD;
        p = 1781477937000000000 + p * t / WAD;
        p = -356563782000000000 + p * t / WAD;
        p = 319381530000000000 + p * t / WAD;
        p = p * t / WAD;
        int256 density = 398942280401432677 * expWad(-(a * a / WAD) / 2) / WAD;
        int256 tail = density * p / WAD;
        if (tail < 0) tail = 0;
        if (tail > WAD) tail = WAD;
        return uint256(negative ? tail : WAD - tail);
    }

    /// @notice Risk-neutral probability of strictly ABOVE strike at zero interest.
    /// @param spot Positive WAD price (must fit int256).
    /// @param strike Positive WAD strike (must fit int256).
    /// @param sigma Annualized WAD volatility; zero uses the deterministic limit.
    /// @param timeSeconds Seconds to expiry, using a 365-day year.
    function binaryUpPrice(uint256 spot, uint256 strike, uint256 sigma, uint256 timeSeconds)
        internal pure returns (uint256)
    {
        if (spot == 0 || strike == 0 || spot > uint256(type(int256).max)
            || strike > uint256(type(int256).max)) revert InvalidPricingInput();
        if (timeSeconds == 0 || sigma == 0) return spot > strike ? 1e18 : 0;
        uint256 t = timeSeconds * 1e18 / YEAR;
        uint256 sigmaSqrtT = sigma * sqrt(t * 1e18) / 1e18;
        if (sigmaSqrtT == 0) return spot > strike ? 1e18 : 0;
        uint256 drift = (sigma * sigma / 1e18) * t / 1e18 / 2;
        if (drift > uint256(type(int256).max) || sigmaSqrtT > uint256(type(int256).max)) {
            revert InvalidPricingInput();
        }
        int256 logRatio = lnWad(int256(spot)) - lnWad(int256(strike));
        int256 numerator = logRatio - int256(drift);
        // Compare before division to avoid overflow and needless tail calculations.
        if (sigmaSqrtT <= uint256(type(int256).max) / 8) {
            int256 cutoff = int256(sigmaSqrtT * 8);
            if (numerator >= cutoff) return 1e18;
            if (numerator <= -cutoff) return 0;
        }
        return normCdf(numerator * WAD / int256(sigmaSqrtT));
    }
}
