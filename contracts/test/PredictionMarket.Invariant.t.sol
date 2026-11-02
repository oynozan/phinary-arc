// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PMTestBase, MockUSDC} from "./PredictionMarket.Base.t.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";
import {MockAggregator} from "../MockAggregator.sol";

/// @dev Bounded action surface for the fuzzer. Every PredictionMarket call is wrapped in
///      try/catch so reverts (slippage, locks, closed windows) just skip the step.
contract PMHandler is Test {
    PredictionMarket public pm;
    MockAggregator public agg;
    PriceOracleAdapter public oracle;

    address[] public actors;
    uint256[] public markets;
    mapping(uint256 => uint80) public firstRound;

    int256 public price8 = 2000e8;
    uint256 public lastRoundTime;

    uint256 public okBuys;
    uint256 public okSells;
    uint256 public okDeposits;
    uint256 public okWithdraws;
    uint256 public okSettles;
    uint256 public okClaims;
    uint256 public okVoids;
    uint256 public okOrders;
    uint256 public okExecs;

    constructor(PredictionMarket pm_, MockAggregator agg_, PriceOracleAdapter oracle_, address[] memory actors_) {
        pm = pm_;
        agg = agg_;
        oracle = oracle_;
        actors = actors_;
        lastRoundTime = block.timestamp;
    }

    function marketsLength() external view returns (uint256) {
        return markets.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _market(uint256 seed) internal view returns (bool ok, uint256 id) {
        if (markets.length == 0) return (false, 0);
        uint256 k = markets.length < 3 ? markets.length : 3; // favour the most recent markets
        return (true, markets[markets.length - 1 - (seed % k)]);
    }

    function _publish() internal {
        uint256 prev = lastRoundTime;
        agg.setPrice(price8);
        lastRoundTime = block.timestamp;
        uint80 rid = agg.latestRoundId();
        for (uint256 i; i < markets.length; ++i) {
            uint256 id = markets[i];
            uint256 e = pm.getMarket(id).expiry;
            if (firstRound[id] == 0 && block.timestamp >= e && prev < e) firstRound[id] = rid;
        }
    }

    function advance(uint256 dt, int256 moveBps) public {
        dt = bound(dt, 0, 100);
        moveBps = bound(moveBps, -50, 50);
        vm.warp(block.timestamp + dt);
        int256 next = price8 + (price8 * moveBps) / 10_000;
        if (next < 500e8 || next > 8000e8) next = price8;
        price8 = next;
        _publish();
    }

    /// @dev Large jump, optionally without publishing a price (feed goes stale).
    function jump(uint256 dt, bool publish) public {
        dt = bound(dt, 1 hours, 3 days);
        vm.warp(block.timestamp + dt);
        if (publish) _publish();
    }

    function create(uint256 durIdx) public {
        if (markets.length >= 80) return;
        uint32[3] memory ds = [uint32(300), 900, 3600];
        try pm.createMarket(0, 0, ds[durIdx % 3]) returns (uint256 id) {
            markets.push(id);
        } catch {}
    }

    function buy(uint256 aSeed, uint256 mSeed, bool up, uint256 units) public {
        // keep a tradable market around: open a new one when the latest is (nearly) closed
        if (markets.length == 0 || pm.getMarket(markets[markets.length - 1]).expiry <= block.timestamp + 60) {
            create(mSeed >> 3);
        }
        (bool ok, uint256 id) = _market(mSeed);
        if (!ok) return;
        units = bound(units, 1, 30_000e6);
        vm.prank(_actor(aSeed));
        try pm.buy(id, up, units, type(uint256).max) {
            ++okBuys;
        } catch {}
    }

    function sell(uint256 aSeed, uint256 mSeed, bool up, uint256 frac) public {
        (bool ok, uint256 id) = _market(mSeed);
        if (!ok) return;
        address a;
        uint256 held;
        for (uint256 i; i < actors.length && held == 0; ++i) { // first actor (from seed) holding this side
            a = actors[((aSeed % actors.length) + i) % actors.length];
            (uint256 u, uint256 d,,) = pm.getPosition(id, a);
            held = up ? u : d;
        }
        if (held == 0) return;
        uint256 units = bound(frac, 1, held);
        vm.prank(a);
        try pm.sell(id, up, units, 0) {
            ++okSells;
        } catch {}
    }

    function deposit(uint256 aSeed, uint256 amt) public {
        amt = bound(amt, 1e6, 50_000e6);
        vm.prank(_actor(aSeed));
        try pm.deposit(amt, 0) {
            ++okDeposits;
        } catch {}
    }

    function withdraw(uint256 aSeed, uint256 bps) public {
        address a = _actor(aSeed);
        uint256 sh = pm.shares(a);
        if (sh == 0) return;
        uint256 amt = bound(bps, 1, 10_000) * sh / 10_000;
        if (amt == 0) return;
        vm.prank(a);
        try pm.withdraw(amt, 0) {
            ++okWithdraws;
        } catch {}
    }

    function settle(uint256 mSeed) public {
        uint256 n = markets.length;
        for (uint256 i; i < n; ++i) { // first market (from seed) with a settleable first round
            uint256 id = markets[(mSeed % n + i) % n];
            if (firstRound[id] == 0 || pm.getMarket(id).status != 0) continue;
            try pm.settle(id, firstRound[id]) {
                ++okSettles;
            } catch {}
            return;
        }
    }

    function claim(uint256 aSeed, uint256 mSeed) public {
        uint256 n = markets.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = markets[(mSeed % n + i) % n];
            if (pm.getMarket(id).status == 0) continue;
            for (uint256 j; j < actors.length; ++j) {
                address a = actors[(aSeed % actors.length + j) % actors.length];
                vm.prank(a);
                try pm.claim(id) {
                    ++okClaims;
                    return;
                } catch {}
            }
        }
    }

    function voidIt(uint256 mSeed) public {
        (bool ok, uint256 id) = _market(mSeed);
        if (!ok) return;
        try pm.voidMarket(id) {
            ++okVoids;
        } catch {}
    }

    function placeOrder(uint256 aSeed, uint256 mSeed, bool up, uint256 bps) public {
        (bool ok, uint256 id) = _market(mSeed);
        if (!ok) return;
        bps = bound(bps, 1, 100);
        uint256 spot = uint256(price8) * 1e10;
        uint256 stop = up ? spot - spot * bps / 10_000 : spot + spot * bps / 10_000;
        vm.prank(_actor(aSeed));
        try pm.setOrder(id, up, stop, 0) {
            ++okOrders;
        } catch {}
    }

    function execOrder(uint256 aSeed, uint256 mSeed, bool up) public {
        (bool ok, uint256 id) = _market(mSeed);
        if (!ok) return;
        try pm.executeOrder(id, _actor(aSeed), up) {
            ++okExecs;
        } catch {}
    }

    function runSequence(uint256 seed, uint256 n) external {
        if (markets.length == 0) create(0);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 a = r % 18;
            uint256 x = r >> 8;
            uint256 y = r >> 72;
            uint256 z = r >> 136;
            bool b = (r >> 200) & 1 == 1;
            if (a < 2) advance(x, int256(y % 101) - 50);
            else if (a == 2) create(x);
            else if (a < 6) buy(x, y, b, z);
            else if (a < 8) sell(x, y, b, z);
            else if (a == 8) deposit(x, y);
            else if (a == 9) withdraw(x, y);
            else if (a == 10) settle(x);
            else if (a == 11) claim(x, y);
            else if (a == 12) { if (x % 4 == 0) jump(y, b); }
            else if (a == 13) voidIt(x);
            else if (a == 14) placeOrder(x, y, b, z);
            else if (a == 15) execOrder(x, y, b);
            else advance(x, int256(y % 101) - 50);
            require(
                MockUSDC(address(pm.usdc())).balanceOf(address(pm)) >= pm.totalLocked() + pm.unclaimedPayouts(),
                "balance < locked + unclaimed"
            );
        }
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 150
/// forge-config: default.fuzz.runs = 64
contract PredictionMarketInvariantTest is PMTestBase {
    PMHandler internal handler;
    address[] internal actorList;

    function setUp() public override {
        super.setUp();
        actorList = [lp, alice, bob, keeper, attacker];
        handler = new PMHandler(pm, agg, oracle, actorList);
        agg.setUpdater(address(handler), true);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](12);
        sels[0] = PMHandler.advance.selector;
        sels[1] = PMHandler.create.selector;
        sels[2] = PMHandler.buy.selector;
        sels[3] = PMHandler.sell.selector;
        sels[4] = PMHandler.deposit.selector;
        sels[5] = PMHandler.withdraw.selector;
        sels[6] = PMHandler.settle.selector;
        sels[7] = PMHandler.claim.selector;
        sels[8] = PMHandler.jump.selector;
        sels[9] = PMHandler.voidIt.selector;
        sels[10] = PMHandler.placeOrder.selector;
        sels[11] = PMHandler.execOrder.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev Core solvency: the vault always holds enough to pay sell-backs and resolved claims.
    function invariant_BalanceCoversLockedPlusUnclaimed() public view {
        assertGe(usdc.balanceOf(address(pm)), pm.totalLocked() + pm.unclaimedPayouts());
    }

    /// @dev totalLocked equals the sum of max + ceil(0.99*min) reserves over open markets.
    function invariant_TotalLockedMatchesOpenMarketReserves() public view {
        uint256 sum;
        for (uint256 id = 1; id <= pm.marketCount(); ++id) {
            PredictionMarket.Market memory m = pm.getMarket(id);
            if (m.status != 0) continue;
            uint256 mx = m.upUnits > m.downUnits ? m.upUnits : m.downUnits;
            uint256 mn = m.upUnits > m.downUnits ? m.downUnits : m.upUnits;
            sum += mx + (mn * 99 + 99) / 100;
        }
        assertEq(pm.totalLocked(), sum);
    }

    /// @dev Share supply is exactly the sum of the known holders' balances.
    function invariant_ShareSupplyIsSumOfHolders() public view {
        uint256 sum;
        for (uint256 i; i < actorList.length; ++i) {
            sum += pm.shares(actorList[i]);
        }
        assertEq(pm.totalShares(), sum);
    }

    /// @dev Position units across holders equal the market's aggregate units.
    function invariant_MarketUnitsMatchPositions() public view {
        for (uint256 id = 1; id <= pm.marketCount(); ++id) {
            PredictionMarket.Market memory m = pm.getMarket(id);
            if (m.status != 0) continue;
            uint256 up;
            uint256 down;
            for (uint256 i; i < actorList.length; ++i) {
                (uint256 u, uint256 d,,) = pm.getPosition(id, actorList[i]);
                up += u;
                down += d;
            }
            assertEq(up, m.upUnits);
            assertEq(down, m.downUnits);
        }
    }

    function testFuzz_RandomSequenceKeepsVaultSolvent(uint256 seed) public {
        handler.runSequence(seed, 60);
        _assertSolvent();
    }

    /// @dev Guards against a vacuous invariant run: the handler really trades, settles, voids, etc.
    function test_Handler_ExercisesTheProtocol() public {
        for (uint256 s; s < 10; ++s) {
            handler.runSequence(s, 60);
        }
        assertGt(handler.okBuys(), 10, "buys");
        assertGt(handler.okSells(), 3, "sells");
        assertGt(handler.okWithdraws(), 0, "withdraws");
        assertGt(handler.okSettles(), 0, "settles");
        assertGt(handler.okClaims(), 0, "claims");
        assertGt(handler.okSettles(), 0, "settles");
        _assertSolvent();
    }
}
