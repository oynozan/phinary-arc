// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";
import {MockAggregator} from "../MockAggregator.sol";

/// @dev Mock ERC20 with configurable decimals (6 for USDC).
contract MockUSDC is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 d) ERC20("Mock USDC", "mUSDC") {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

abstract contract PMTestBase is Test {
    uint256 internal constant T0 = 1_700_000_000;
    int256 internal constant SPOT8 = 2000e8; // 8-decimal feed answer
    uint256 internal constant SPOT = 2000e18; // WAD
    uint256 internal constant WAD = 1e18;
    uint256 internal constant DEFAULT_VOL = 0.8e18;
    uint256 internal constant LP_DEPOSIT = 100_000e6;
    uint8 internal constant ASSET = 0;

    MockUSDC internal usdc;
    MockAggregator internal agg;
    PriceOracleAdapter internal oracle;
    PredictionMarket internal pm;

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal attacker = makeAddr("attacker");

    int256 internal curPrice8 = SPOT8;

    struct Q {
        uint256 fairUp;
        uint256 buyUp;
        uint256 sellUp;
        uint256 buyDown;
        uint256 sellDown;
        uint256 spot;
        uint256 sigma;
        uint256 timeLeft;
    }

    function setUp() public virtual {
        vm.warp(T0);
        usdc = new MockUSDC(6);
        agg = new MockAggregator(address(this), 8, "ETH/USD");
        _setPrice(SPOT8);
        oracle = new PriceOracleAdapter(address(this));
        oracle.setFeed(ASSET, address(agg), 3600, 0.2e18, 3e18, DEFAULT_VOL);
        address[5] memory us = [lp, alice, bob, keeper, attacker];
        for (uint256 i; i < us.length; ++i) {
            usdc.mint(us[i], 10_000_000e6);
        }
        _deployPM();
        vm.prank(lp);
        pm.deposit(LP_DEPOSIT);
        skip(1 hours + 1);
        _setPrice(SPOT8);
    }

    /// @dev Fresh PredictionMarket (empty vault) with approvals for every actor.
    function _deployPM() internal {
        pm = new PredictionMarket(address(usdc), address(oracle), owner);
        address[5] memory us = [lp, alice, bob, keeper, attacker];
        for (uint256 i; i < us.length; ++i) {
            vm.prank(us[i]);
            usdc.approve(address(pm), type(uint256).max);
        }
    }

    function _setPrice(int256 p8) internal {
        curPrice8 = p8;
        agg.setPrice(p8);
    }

    /// @dev Re-publish the current price at the current timestamp (keeps feed fresh).
    function _refresh() internal {
        agg.setPrice(curPrice8);
    }

    function _create(uint32 dur) internal returns (uint256 id) {
        _refresh();
        vm.prank(alice);
        id = pm.createMarket(ASSET, 0, dur);
    }

    function _buy(address u, uint256 id, bool up, uint256 units) internal {
        _refresh();
        vm.prank(u);
        pm.buy(id, up, units, type(uint256).max);
    }

    function _q(uint256 id) internal view returns (Q memory q) {
        (q.fairUp, q.buyUp, q.sellUp, q.buyDown, q.sellDown, q.spot, q.sigma, q.timeLeft) = pm.quote(id);
    }

    function _ceilMul(uint256 units, uint256 price) internal pure returns (uint256) {
        return (units * price + WAD - 1) / WAD;
    }

    function _expiry(uint256 id) internal view returns (uint256) {
        return pm.getMarket(id).expiry;
    }

    function _assertSolvent() internal view {
        assertGe(usdc.balanceOf(address(pm)), pm.totalLocked() + pm.unclaimedPayouts(), "insolvent");
    }

    /// @dev Warp to expiry+delta, publish `p8` as the first round at/after expiry, settle.
    function _settleWith(uint256 id, int256 p8, uint256 delta) internal {
        vm.warp(_expiry(id) + delta);
        _setPrice(p8);
        pm.settle(id, agg.latestRoundId());
    }
}
