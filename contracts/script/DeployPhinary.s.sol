// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PredictionMarket} from "../PredictionMarket.sol";
import {PriceOracleAdapter} from "../PriceOracleAdapter.sol";
import {MockAggregator} from "../MockAggregator.sol";
import {StreamsFeed, IVerifierProxy} from "../StreamsFeed.sol";

/// @notice Deploys PriceOracleAdapter, PredictionMarket and one feed per asset, then registers the
///         feeds. Every transaction is sent by OWNER, who must own the adapter for setFeed.
///
/// Env:
///   NETWORK         testnet (default, chain 5042002: MockAggregator feeds, 8 decimals, OWNER pushes
///                   prices) or mainnet (chain 5042: StreamsFeed on Chainlink Data Streams)
///   OWNER           initial owner of every contract and the broadcasting account
///   ASSETS          comma-separated asset ids (0 BTC, 1 ETH, 2 SOL, 3 NVDA, 4 AAPL); default all,
///                   required with ORACLE
///   ORACLE          optional existing PriceOracleAdapter owned by OWNER: only deploy and register
///                   the ASSETS feeds on it (e.g. ASSETS=3,4 to add NVDA/AAPL to a live deployment).
///                   Assets already enabled there are refused: replacing a feed under open markets
///                   wipes its vol history and lets the new feed's first round settle them
///   REPLACE_FEEDS   1 to allow replacing already-enabled feeds in ORACLE mode
///   MAX_REPORT_AGE  mainnet only, seconds a Data Streams report stays submittable for trading (default 5)
///
/// Rehearse (simulation only):
///   NETWORK=mainnet OWNER=0x... forge script contracts/script/DeployPhinary.s.sol --fork-url https://rpc.mainnet.arc.io
/// Deploy: add --broadcast with OWNER's signer (--account/--private-key) and --sender OWNER.
contract DeployPhinary is Script {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant VERIFIER_PROXY = 0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7; // Arc mainnet
    uint32 internal constant MAX_STALENESS = 600;

    string[5] internal keys = ["BTC", "ETH", "SOL", "NVDA", "AAPL"];
    string[5] internal names = ["BTC / USD", "ETH / USD", "SOL / USD", "NVDA / USD", "AAPL / USD"];
    // v3 crypto streams; NVDA and AAPL use the 24/7 (v2) streams so markets run around the clock.
    bytes32[5] internal streams = [
        bytes32(0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8),
        0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9,
        0x0003b778d3f6b2ac4991302b89cb313f99a42467d6c9c5f96f57c29c0d2bc24f,
        0x0002d9b165cfb7309e8a13af14cbbb608d9990f9fa094d2ac6199d2567f2dae8,
        0x000231a949aa4e6a24b2c2005b16e27d03ed90e08888a2da3a68ebc9c50763df
    ];
    uint256[5] internal minVol = [uint256(0.30e18), 0.40e18, 0.50e18, 0.25e18, 0.15e18];
    uint256[5] internal maxVol = [uint256(1.5e18), 2.0e18, 2.5e18, 1.5e18, 1.0e18];
    uint256[5] internal defaultVol = [uint256(0.55e18), 0.75e18, 0.95e18, 0.50e18, 0.30e18];

    function run() external {
        string memory network = vm.envOr("NETWORK", string("testnet"));
        bool mainnet = keccak256(bytes(network)) == keccak256("mainnet");
        require(mainnet || keccak256(bytes(network)) == keccak256("testnet"), "NETWORK must be testnet or mainnet");
        require(block.chainid == (mainnet ? 5042 : 5042002), "chain id does not match NETWORK");
        address owner = vm.envAddress("OWNER");
        require(owner != address(0), "OWNER unset");
        address existing = vm.envOr("ORACLE", address(0));
        uint256[] memory all = new uint256[](5);
        for (uint256 i; i < 5; ++i) all[i] = i;
        uint256[] memory assets = vm.envOr("ASSETS", ",", all);
        require(existing == address(0) || vm.envExists("ASSETS"), "ORACLE set: ASSETS must be set explicitly");
        bool replace = vm.envOr("REPLACE_FEEDS", uint256(0)) == 1;
        for (uint256 i; i < assets.length; ++i) {
            require(assets[i] < 5, "unknown asset id");
            for (uint256 j; j < i; ++j) require(assets[j] != assets[i], "duplicate asset id");
        }
        uint256 maxReportAge = vm.envOr("MAX_REPORT_AGE", uint256(5));
        if (mainnet) {
            require(IERC20Metadata(USDC).decimals() == 6, "USDC is not 6 decimals");
            require(VERIFIER_PROXY.code.length > 0, "no VerifierProxy code");
            require(IVerifierProxy(VERIFIER_PROXY).s_feeManager() == address(0), "VerifierProxy charges fees");
        }
        uint256 deployBlock = block.number;

        vm.startBroadcast(owner);
        PriceOracleAdapter oracle;
        PredictionMarket market;
        if (existing == address(0)) {
            oracle = new PriceOracleAdapter(owner);
            market = new PredictionMarket(USDC, address(oracle), owner);
        } else {
            oracle = PriceOracleAdapter(existing);
            require(oracle.owner() == owner, "OWNER does not own ORACLE");
            for (uint256 i; i < assets.length && !replace; ++i) {
                try oracle.getObservationCount(uint8(assets[i])) returns (uint256) {
                    revert(string.concat("asset ", vm.toString(assets[i]), " already enabled on ORACLE; set REPLACE_FEEDS=1 to replace"));
                } catch {}
            }
        }
        address[] memory feeds = new address[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            uint256 a = assets[i];
            feeds[i] = mainnet
                ? address(new StreamsFeed(VERIFIER_PROXY, streams[a], 18, names[a], maxReportAge))
                : address(new MockAggregator(owner, 8, names[a]));
            oracle.setFeed(uint8(a), feeds[i], MAX_STALENESS, minVol[a], maxVol[a], defaultVol[a]);
        }
        vm.stopBroadcast();

        console2.log("# .env lines");
        console2.log(string.concat("VITE_NETWORK=", network));
        if (existing == address(0)) {
            console2.log(string.concat("VITE_MARKET_ADDRESS=", vm.toString(address(market))));
            console2.log(string.concat("VITE_ORACLE_ADDRESS=", vm.toString(address(oracle))));
            console2.log(string.concat("VITE_DEPLOY_BLOCK=", vm.toString(deployBlock)));
        }
        for (uint256 i; i < assets.length; ++i) {
            console2.log(string.concat("VITE_FEED_", keys[assets[i]], "=", vm.toString(feeds[i])));
        }
    }
}
