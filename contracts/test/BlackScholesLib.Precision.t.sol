// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {BSBatchHarness} from "./helpers/BSBatchHarness.sol";

/// @dev Precision / monotonicity / domain checks for BlackScholesLib on the reachable domain:
///      spot = 8-decimal feed price scaled to WAD, strike within the 10% band, sigma in
///      [minVol, maxVol <= 10e18], T from 1 s through days.
contract BlackScholesPrecisionTest is Test {
    BSBatchHarness internal h;
    uint256 internal constant YEAR = 31_536_000;

    function setUp() public {
        h = new BSBatchHarness();
    }

    function _reachable(uint256 s, uint256 bandBps, bool up, uint256 sigma, uint256 t)
        internal pure returns (uint256, uint256, uint256, uint256)
    {
        s = bound(s, 1e6, 1e13) * 1e10; // $0.01 .. $100k at 8 decimals, scaled to WAD
        bandBps = bound(bandBps, 0, 1000);
        uint256 k = up ? s + s * bandBps / 10_000 : s - s * bandBps / 10_000;
        sigma = bound(sigma, 0.05e18, 10e18);
        t = bound(t, 1, 7 days);
        return (s, k, sigma, t);
    }

    // ---------------------------------------------------------------- domain
    function testFuzz_Binary_NoRevertOnReachableDomain(uint256 s, uint256 b, bool up, uint256 sigma, uint256 t)
        public view
    {
        uint256 k;
        (s, k, sigma, t) = _reachable(s, b, up, sigma, t);
        assertLe(h.binaryUpPrice(s, k, sigma, t), 1e18);
    }

    function testFuzz_Binary_NoRevertFullUint40Expiry(uint256 s, uint256 k, uint256 sigma, uint40 t) public view {
        // timeLeft comes from a uint40 expiry: any value up to 2^40-1 must be safe.
        s = bound(s, 1, uint256(type(int256).max));
        k = bound(k, 1, uint256(type(int256).max));
        sigma = bound(sigma, 1, 10e18);
        assertLe(h.binaryUpPrice(s, k, sigma, t), 1e18);
    }

    // ---------------------------------------------------------- monotonicity
    function testFuzz_Binary_MonotonicInSpot(uint256 s, uint256 b, bool up, uint256 sigma, uint256 t, uint256 ds)
        public view
    {
        uint256 k;
        (s, k, sigma, t) = _reachable(s, b, up, sigma, t);
        ds = bound(ds, 1, s / 100);
        assertGe(h.binaryUpPrice(s + ds, k, sigma, t), h.binaryUpPrice(s, k, sigma, t), "UP price fell when spot rose");
    }

    function testFuzz_Binary_MonotonicInStrike(uint256 s, uint256 b, bool up, uint256 sigma, uint256 t, uint256 dk)
        public view
    {
        uint256 k;
        (s, k, sigma, t) = _reachable(s, b, up, sigma, t);
        dk = bound(dk, 1, k / 100);
        assertLe(h.binaryUpPrice(s, k + dk, sigma, t), h.binaryUpPrice(s, k, sigma, t), "UP price rose when strike rose");
    }

    /// @dev ATM (S == K): d2 = -sigma*sqrt(T)/2, so UP must fall as T or sigma grows.
    function testFuzz_Binary_AtmDecreasesInTimeAndVol(uint256 s, uint256 sigma, uint256 t, uint256 dt) public view {
        s = bound(s, 1e6, 1e13) * 1e10;
        sigma = bound(sigma, 0.05e18, 10e18);
        t = bound(t, 1, 7 days);
        dt = bound(dt, 1, 1 days);
        uint256 p = h.binaryUpPrice(s, s, sigma, t);
        assertLe(h.binaryUpPrice(s, s, sigma, t + dt), p, "ATM UP rose with T");
        assertLe(h.binaryUpPrice(s, s, sigma + sigma / 100 + 1, t), p, "ATM UP rose with sigma");
        assertLe(p, 0.5e18, "ATM UP above 0.5");
    }

    /// @dev Spot above strike by more than the drift: UP is ITM and must fall toward 0.5 as T grows (for
    ///      T small enough that the ITM region persists). Checked for |d2| > 0.1 to stay out of the turning point.
    function testFuzz_Binary_ItmDecreasesInTime(uint256 s, uint256 b, uint256 t) public view {
        s = bound(s, 1e6, 1e13) * 1e10;
        b = bound(b, 10, 1000); // 0.1% .. 10% ITM
        uint256 k = s - s * b / 10_000;
        t = bound(t, 16, 3600);
        uint256 sigma = 0.5e18;
        assertLe(h.binaryUpPrice(s, k, sigma, t + 60), h.binaryUpPrice(s, k, sigma, t), "ITM UP rose with T");
    }

    // ------------------------------------------------------------- normCdf
    /// @dev normCdf(0) is special-cased to exactly 0.5; A&S at 0+ gives 0.5000000005 (observed), so the
    ///      special case keeps monotonicity (jump of +5.2e-10, below the 7.5e-8 A&S error).
    function test_NormCdf_ContinuityAtZero() public view {
        uint256 atZero = h.normCdf(0);
        uint256 rightOfZero = h.normCdf(1); // 1e-18
        uint256 leftOfZero = h.normCdf(-1);
        console.log("normCdf(-1 wei)", leftOfZero);
        console.log("normCdf(0)     ", atZero);
        console.log("normCdf(+1 wei)", rightOfZero);
        console.log("normCdf(1e10)  ", h.normCdf(1e10));
        assertGe(rightOfZero, atZero, "CDF decreases just right of 0");
        assertLe(leftOfZero, atZero, "CDF above N(0) just left of 0");
    }

    /// @dev Same effect seen through binaryUpPrice: when ln(S/K) equals the drift exactly (numerator == 0)
    ///      the price is 0.5, and nudging spot up lowers the price.
    function test_Binary_MonotoneThroughZeroNumerator() public view {
        // sigma*sqrt(T) chosen so that drift is an exact integer and S/K = exp(drift) is hit exactly
        // is hard to construct; instead show that spot = strike with sigma*sqrt(T) tiny but nonzero
        // brackets the 0.5 point: compare the libraries' value straddling the numerator sign change.
        uint256 k = 100_000e18;
        uint256 sigma = 0.3e18;
        uint256 t = 16;
        // drift ~ 0.5 * 0.09 * 16/31536000 = 2.283e-8; S* = K * exp(drift) = K + 2.283e-3
        uint256 prev;
        uint256 worstDrop;
        for (uint256 s = k + 2.0e15; s < k + 2.6e15; s += 1e12) {
            uint256 p = h.binaryUpPrice(s, k, sigma, t);
            if (prev > p && prev - p > worstDrop) worstDrop = prev - p;
            prev = p;
        }
        console.log("worst drop across the ATM drift point (wei):", worstDrop);
        assertEq(worstDrop, 0, "binaryUpPrice not monotone in spot near the drift point");
    }
}
