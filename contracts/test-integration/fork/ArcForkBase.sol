// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PredictionMarket} from "../../PredictionMarket.sol";
import {PriceOracleAdapter} from "../../PriceOracleAdapter.sol";
import {MockAggregator} from "../../MockAggregator.sol";

/// @dev Test-only stand-in for Arc's native-coin precompile at 0x1800...0000, which revm
///      does not implement. The real USDC proxy at 0x3600... delegates to an implementation
///      that calls `transfer(from, to, amount18)` on this precompile to move native balance.
///      This stand-in moves the native balances with cheatcodes so the real token code runs.
contract NativeCoinPrecompileStub {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    fallback(bytes calldata data) external payable returns (bytes memory) {
        bytes4 sel = bytes4(data[:4]);
        if (sel == bytes4(keccak256("transfer(address,address,uint256)"))) {
            (address from, address to, uint256 amount) = abi.decode(data[4:], (address, address, uint256));
            require(from.balance >= amount, "stub: insufficient native");
            VM.deal(from, from.balance - amount);
            VM.deal(to, to.balance + amount);
            return abi.encode(true);
        }
        revert("stub: unknown selector");
    }
}

/// @dev Test-only stand-in for Arc's blocklist precompile at 0x1800...0001: nobody is blocklisted.
contract BlocklistPrecompileStub {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(false);
    }
}

/// @dev Vault entry points of the bytecode deployed before the slippage-bounded signatures.
interface ILegacyVault {
    function deposit(uint256 amount) external;
    function withdraw(uint256 shareAmount) external;
}

/// @dev Shared helpers for fork tests against Arc Testnet. `pm`/`oracle` start as the live
///      deployment; `_deployFresh` swaps in contracts built from the current sources that use
///      the real USDC and the live mock feeds.
abstract contract ArcForkBase is Test {
    string internal constant RPC = "https://rpc.testnet.arc.io";
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant NATIVE_PRECOMPILE = 0x1800000000000000000000000000000000000000;
    address internal constant BLOCKLIST_PRECOMPILE = 0x1800000000000000000000000000000000000001;
    address internal constant PM_ADDR = 0xaD96602776250f18A4d46Ab7b2F0c56a5fda2df5;
    address internal constant ORACLE_ADDR = 0x465ec9f24AD95CDB73C72B2De1CcB0Ac827723E3;
    address internal constant FEED_BTC = 0x83eeC3CbDA541E441Ff5f919fa47faefb20678ae;
    address internal constant FEED_ETH = 0xC7E7bCD1e9A28CeCB58daD6a4459B9F81Db4c970;
    address internal constant FEED_SOL = 0x4395f10C126fbfb0B3B229648cEEBA4bd7Fca004;
    address internal constant KEEPER = 0x3F04776B2b253abdC3DF386d82Bc182BE674BF7f;

    IERC20 internal usdc = IERC20(USDC);
    PredictionMarket internal pm = PredictionMarket(PM_ADDR);
    PriceOracleAdapter internal oracle = PriceOracleAdapter(ORACLE_ADDR);

    function _fork() internal {
        string memory blockEnv = vm.envOr("ARC_FORK_BLOCK", string(""));
        if (bytes(blockEnv).length == 0) vm.createSelectFork(RPC);
        else vm.createSelectFork(RPC, vm.parseUint(blockEnv));
        NativeCoinPrecompileStub stub = new NativeCoinPrecompileStub();
        vm.etch(NATIVE_PRECOMPILE, address(stub).code);
        vm.allowCheatcodes(NATIVE_PRECOMPILE);
        vm.etch(BLOCKLIST_PRECOMPILE, address(new BlocklistPrecompileStub()).code);
        vm.label(USDC, "USDC");
        vm.label(PM_ADDR, "PredictionMarket");
        vm.label(ORACLE_ADDR, "Oracle");
    }

    /// @dev Deploy the current PriceOracleAdapter and PredictionMarket on the fork, owned by the
    ///      keeper like the live ones, with the setup.ts vol bounds, and seed the vault.
    function _deployFresh(uint256 seedUsdc) internal {
        oracle = new PriceOracleAdapter(KEEPER);
        uint256[3] memory minVol = [uint256(0.30e18), 0.40e18, 0.50e18];
        uint256[3] memory maxVol = [uint256(1.5e18), 2.0e18, 2.5e18];
        uint256[3] memory defVol = [uint256(0.55e18), 0.75e18, 0.95e18];
        for (uint8 a; a < 3; ++a) {
            vm.prank(KEEPER);
            oracle.setFeed(a, address(_feed(a)), 600, minVol[a], maxVol[a], defVol[a]);
        }
        pm = new PredictionMarket(USDC, address(oracle), KEEPER);
        vm.label(address(pm), "FreshPredictionMarket");
        vm.label(address(oracle), "FreshOracle");
        if (seedUsdc > 0) {
            address seeder = makeAddr("fork-seeder");
            _fund(seeder, seedUsdc);
            uint256 minShares = pm.previewDeposit(seedUsdc);
            vm.prank(seeder);
            pm.deposit(seedUsdc, minShares);
        }
    }

    function _feed(uint8 assetId) internal pure returns (MockAggregator) {
        if (assetId == 0) return MockAggregator(FEED_BTC);
        if (assetId == 1) return MockAggregator(FEED_ETH);
        return MockAggregator(FEED_SOL);
    }

    /// @dev Fund a user with USDC by moving native balance (18 decimals) and approve the market.
    function _fund(address user, uint256 usdcAmount) internal {
        vm.deal(user, user.balance + usdcAmount * 1e12);
        vm.prank(user);
        usdc.approve(address(pm), type(uint256).max);
    }

    /// @dev Push a new mock feed round as the feed owner (keeper), at the current timestamp.
    function _push(uint8 assetId, int256 answer) internal returns (uint80 roundId) {
        MockAggregator f = _feed(assetId);
        vm.prank(f.owner());
        f.setPrice(answer);
        return f.latestRoundId();
    }

    /// @dev Re-publish the latest answer at the current timestamp.
    function _refresh(uint8 assetId) internal returns (uint80) {
        (, int256 answer,,,) = _feed(assetId).latestRoundData();
        return _push(assetId, answer);
    }

    function _latest(uint8 assetId) internal view returns (int256 answer) {
        (, answer,,,) = _feed(assetId).latestRoundData();
    }

    function _voidBuffer() internal view returns (uint256) {
        // _voidRefundBuffer is the slot after _orders. Read it via the solvency identity instead:
        // freeLiquidity = totalAssets - totalLocked - buffer (when positive).
        uint256 assets = pm.totalAssets();
        uint256 free = pm.freeLiquidity();
        uint256 locked = pm.totalLocked();
        if (free == 0) return type(uint256).max; // unknown
        return assets - free - locked;
    }

    function _assertSolvent(string memory tag) internal view {
        uint256 bal = usdc.balanceOf(address(pm));
        assertGe(bal, pm.totalLocked() + pm.unclaimedPayouts(), tag);
    }
}
