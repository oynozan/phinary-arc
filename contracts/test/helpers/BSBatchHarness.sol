// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BlackScholesLib} from "../../lib/BlackScholesLib.sol";

/// @dev Test-only batch wrapper around BlackScholesLib so an off-chain reference (bun) can compare
///      thousands of vectors per eth_call. Reverting inputs report `type(uint256).max` / sentinel.
contract BSBatchHarness {
    uint256 internal constant REVERTED = type(uint256).max;

    function binaryUpPrice(uint256 s, uint256 k, uint256 sigma, uint256 t) external pure returns (uint256) {
        return BlackScholesLib.binaryUpPrice(s, k, sigma, t);
    }

    function normCdf(int256 x) external pure returns (uint256) {
        return BlackScholesLib.normCdf(x);
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

    function batchBinary(uint256[] calldata s, uint256[] calldata k, uint256[] calldata sigma, uint256[] calldata t)
        external view returns (uint256[] memory out)
    {
        out = new uint256[](s.length);
        for (uint256 i; i < s.length; ++i) {
            try this.binaryUpPrice(s[i], k[i], sigma[i], t[i]) returns (uint256 p) {
                out[i] = p;
            } catch {
                out[i] = REVERTED;
            }
        }
    }

    function batchNormCdf(int256[] calldata x) external pure returns (uint256[] memory out) {
        out = new uint256[](x.length);
        for (uint256 i; i < x.length; ++i) out[i] = BlackScholesLib.normCdf(x[i]);
    }

    function batchLn(int256[] calldata x) external pure returns (int256[] memory out) {
        out = new int256[](x.length);
        for (uint256 i; i < x.length; ++i) out[i] = BlackScholesLib.lnWad(x[i]);
    }

    function batchExp(int256[] calldata x) external pure returns (int256[] memory out) {
        out = new int256[](x.length);
        for (uint256 i; i < x.length; ++i) out[i] = BlackScholesLib.expWad(x[i]);
    }

    function batchSqrt(uint256[] calldata x) external pure returns (uint256[] memory out) {
        out = new uint256[](x.length);
        for (uint256 i; i < x.length; ++i) out[i] = BlackScholesLib.sqrt(x[i]);
    }
}
