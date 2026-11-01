// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BlackScholesLib} from "../lib/BlackScholesLib.sol";

/// @dev External wrapper so internal library functions can be called and reverts asserted.
contract BSHarness {
    function normCdf(int256 x) external pure returns (uint256) {
        return BlackScholesLib.normCdf(x);
    }

    function binaryUpPrice(uint256 s, uint256 k, uint256 sigma, uint256 t) external pure returns (uint256) {
        return BlackScholesLib.binaryUpPrice(s, k, sigma, t);
    }

    function lnWad(int256 x) external pure returns (int256) {
        return BlackScholesLib.lnWad(x);
    }

    function expWad(int256 x) external pure returns (int256) {
        return BlackScholesLib.expWad(x);
    }

    function sqrt(uint256 x) external pure returns (uint256) {
        return BlackScholesLib.sqrt(x);
    }
}

contract BlackScholesLibTest is Test {
    BSHarness internal h;

    uint256 internal constant TOL = 1e12; // 1e-6 in WAD
    uint256 internal constant S = 2000e18;
    uint256 internal constant SIGMA = 0.8e18;

    function setUp() public {
        h = new BSHarness();
    }

    // ---------------------------------------------------------------- normCdf
    function test_NormCdf_ZeroIsHalf() public view {
        assertEq(h.normCdf(0), 0.5e18);
    }

    function test_NormCdf_KnownValues() public view {
        assertApproxEqAbs(h.normCdf(1e18), 0.841344746068543e18, TOL);
        assertApproxEqAbs(h.normCdf(2e18), 0.977249868051821e18, TOL);
        assertApproxEqAbs(h.normCdf(-1e18), 0.158655253931457e18, TOL);
        assertApproxEqAbs(h.normCdf(-2e18), 0.022750131948179e18, TOL);
    }

    function test_NormCdf_SaturatesBeyondEightSigma() public view {
        assertEq(h.normCdf(8e18), 1e18);
        assertEq(h.normCdf(100e18), 1e18);
        assertEq(h.normCdf(-8e18), 0);
        assertEq(h.normCdf(-100e18), 0);
        assertEq(h.normCdf(type(int256).max), 1e18);
        assertEq(h.normCdf(type(int256).min), 0);
    }

    function testFuzz_NormCdf_SymmetryAndBounds(int256 x) public view {
        x = bound(x, -8e18, 8e18);
        uint256 a = h.normCdf(x);
        uint256 b = h.normCdf(-x);
        assertLe(a, 1e18);
        assertApproxEqAbs(a + b, 1e18, TOL);
    }

    function testFuzz_NormCdf_Monotonic(int256 x, uint256 dx) public view {
        x = bound(x, -8e18, 8e18);
        dx = bound(dx, 1, 1e18);
        // Abramowitz-Stegun approximation error ~7.5e-8: allow 1e-6 slack, never a real decrease
        assertGe(h.normCdf(x + int256(dx)) + TOL, h.normCdf(x));
    }

    // ---------------------------------------------------------- binaryUpPrice
    function test_Binary_AtTheMoneyIsHalfMinusSmallDrift() public view {
        uint256 p = h.binaryUpPrice(S, S, SIGMA, 3600);
        assertLt(p, 0.5e18, "drift lowers ATM price below 0.5");
        assertGt(p, 0.49e18);
        // d2 = -sigma*sqrt(t)/2 ~= -0.004274 -> ~0.49829
        assertApproxEqAbs(p, 0.49829e18, 1e14);
    }

    function test_Binary_AnalyticOneYear() public view {
        // sigma=0.5, t=1y, ATM: d2 = -0.25 -> 0.401294
        assertApproxEqAbs(h.binaryUpPrice(S, S, 0.5e18, 365 days), 0.401294e18, 1e12);
        // ln(S/K)=0.01 -> d2 = (0.01-0.125)/0.5 = -0.23 -> 0.409046
        uint256 spot = uint256(S) * 1010050167084168057 / 1e18; // S*exp(0.01)
        assertApproxEqAbs(h.binaryUpPrice(spot, S, 0.5e18, 365 days), 0.409046e18, 1e13);
    }

    function test_Binary_MonotonicInSpot() public view {
        uint256 prev;
        for (uint256 s = 1900e18; s <= 2100e18; s += 5e18) {
            uint256 p = h.binaryUpPrice(s, S, SIGMA, 3600);
            assertGe(p, prev, "non-decreasing in spot");
            prev = p;
        }
        assertGt(prev, 0.9e18);
    }

    function test_Binary_MonotonicDecreasingInStrike() public view {
        uint256 prev = type(uint256).max;
        for (uint256 k = 1900e18; k <= 2100e18; k += 5e18) {
            uint256 p = h.binaryUpPrice(S, k, SIGMA, 3600);
            assertLe(p, prev);
            prev = p;
        }
    }

    function test_Binary_DeepItmAndOtm() public view {
        assertEq(h.binaryUpPrice(4000e18, S, SIGMA, 3600), 1e18);
        assertEq(h.binaryUpPrice(1000e18, S, SIGMA, 3600), 0);
        assertGe(h.binaryUpPrice(2200e18, S, SIGMA, 300), 0.999e18);
        assertLe(h.binaryUpPrice(1800e18, S, SIGMA, 300), 0.001e18);
    }

    function test_Binary_ZeroTimeIsDeterministic() public view {
        assertEq(h.binaryUpPrice(S + 1, S, SIGMA, 0), 1e18);
        assertEq(h.binaryUpPrice(S - 1, S, SIGMA, 0), 0);
        assertEq(h.binaryUpPrice(S, S, SIGMA, 0), 0, "equality is not above strike");
    }

    function test_Binary_ZeroSigmaIsDeterministic() public view {
        assertEq(h.binaryUpPrice(S + 1, S, 0, 3600), 1e18);
        assertEq(h.binaryUpPrice(S, S, 0, 3600), 0);
        assertEq(h.binaryUpPrice(S - 1, S, 0, 3600), 0);
    }

    function test_Binary_InvalidInputsRevert() public {
        vm.expectRevert(BlackScholesLib.InvalidPricingInput.selector);
        h.binaryUpPrice(0, S, SIGMA, 3600);
        vm.expectRevert(BlackScholesLib.InvalidPricingInput.selector);
        h.binaryUpPrice(S, 0, SIGMA, 3600);
        vm.expectRevert(BlackScholesLib.InvalidPricingInput.selector);
        h.binaryUpPrice(uint256(type(int256).max) + 1, S, SIGMA, 3600);
        vm.expectRevert(BlackScholesLib.InvalidPricingInput.selector);
        h.binaryUpPrice(S, uint256(type(int256).max) + 1, SIGMA, 3600);
    }

    function test_Binary_ExtremeInputsDoNotRevert() public view {
        uint256 big = uint256(type(int256).max);
        h.binaryUpPrice(1, big, 10e18, 100 * 365 days);
        h.binaryUpPrice(big, 1, 10e18, 100 * 365 days);
        h.binaryUpPrice(1, 1, 10e18, type(uint32).max);
        h.binaryUpPrice(big, big, 1, 1);
        h.binaryUpPrice(1e30, 1, 1, 1);
        h.binaryUpPrice(S, S, 10e18, 1);
        h.binaryUpPrice(S, S, 1, 100 * 365 days);
        h.binaryUpPrice(1e6, 1e40, 10e18, 365 days);
    }

    function testFuzz_Binary_NeverRevertsAndBounded(uint256 s, uint256 k, uint256 sigma, uint256 t) public view {
        s = bound(s, 1, 1e40);
        k = bound(k, 1, 1e40);
        sigma = bound(sigma, 0, 10e18);
        t = bound(t, 0, 100 * 365 days);
        assertLe(h.binaryUpPrice(s, k, sigma, t), 1e18);
    }

    // ------------------------------------------------------------- ln / exp
    function test_Ln_KnownValues() public view {
        assertEq(h.lnWad(1e18), 0);
        assertApproxEqAbs(h.lnWad(2e18), 693147180559945309, 1e3);
        assertApproxEqAbs(h.lnWad(0.5e18), -693147180559945309, 1e3);
        assertApproxEqAbs(h.lnWad(2718281828459045235), 1e18, 1e3);
        assertApproxEqAbs(h.lnWad(10e18), 2302585092994045684, 1e3);
    }

    function test_Ln_RevertsOnNonPositive() public {
        vm.expectRevert(BlackScholesLib.LogUndefined.selector);
        h.lnWad(0);
        vm.expectRevert(BlackScholesLib.LogUndefined.selector);
        h.lnWad(-1);
    }

    function test_Ln_ExtremeInputsDoNotRevert() public view {
        h.lnWad(1);
        h.lnWad(type(int256).max);
    }

    function test_Exp_KnownValues() public view {
        assertEq(h.expWad(0), 1e18);
        assertApproxEqAbs(h.expWad(1e18), 2718281828459045235, 1e6);
        assertApproxEqAbs(h.expWad(-1e18), 367879441171442321, 1e6);
        assertApproxEqAbs(h.expWad(2e18), 7389056098930650227, 1e7);
    }

    function test_Exp_Limits() public {
        assertEq(h.expWad(-42139678854452767551), 0);
        assertEq(h.expWad(type(int256).min), 0);
        vm.expectRevert(BlackScholesLib.ExpOverflow.selector);
        h.expWad(135305999368893231589);
        vm.expectRevert(BlackScholesLib.ExpOverflow.selector);
        h.expWad(type(int256).max);
    }

    function testFuzz_ExpOfLnRoundTrip(uint256 x) public view {
        x = bound(x, 1e12, 1e30);
        int256 back = h.expWad(h.lnWad(int256(x)));
        assertApproxEqRel(uint256(back), x, 1e10); // 1e-8 relative
    }

    function testFuzz_LnOfExpRoundTrip(int256 y) public view {
        y = bound(y, -10e18, 40e18);
        assertApproxEqAbs(h.lnWad(h.expWad(y)), y, 1e9);
    }

    // ------------------------------------------------------------------ sqrt
    function test_Sqrt_Known() public view {
        assertEq(h.sqrt(0), 0);
        assertEq(h.sqrt(1), 1);
        assertEq(h.sqrt(2), 1);
        assertEq(h.sqrt(1e36), 1e18);
        assertEq(h.sqrt(1e18), 1e9);
    }

    function testFuzz_Sqrt_IsFloor(uint256 x) public view {
        x = bound(x, 0, 1e70);
        uint256 z = h.sqrt(x);
        assertLe(z * z, x);
        assertGt((z + 1) * (z + 1), x);
    }
}
