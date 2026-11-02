// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StreamsFeed} from "../../StreamsFeed.sol";

interface IVerifierProxyAdmin {
    function typeAndVersion() external view returns (string memory);
    function s_feeManager() external view returns (address);
    function s_accessController() external view returns (address);
}

/// @notice StreamsFeed against the real Chainlink Data Streams VerifierProxy on an Arc mainnet fork.
///         No API credentials exist here, so only rejection paths are exercised: a real signed
///         report is needed for the accepting path (see test/StreamsFeed.t.sol with a mock proxy).
contract StreamsFeedMainnetForkTest is Test {
    string internal constant RPC = "https://rpc.mainnet.arc.io";
    address internal constant VERIFIER_PROXY = 0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7;
    bytes32 internal constant BTC = 0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8;

    StreamsFeed internal feed;

    function setUp() public {
        vm.createSelectFork(RPC);
        assertEq(block.chainid, 5042);
        feed = new StreamsFeed(VERIFIER_PROXY, BTC, 18, "BTC / USD", 30);
    }

    function test_ProxyIsFreeAndOpen() public view {
        IVerifierProxyAdmin p = IVerifierProxyAdmin(VERIFIER_PROXY);
        assertEq(p.typeAndVersion(), "VerifierProxy 2.0.0");
        assertEq(p.s_feeManager(), address(0), "no fee manager: submit needs no fee");
        assertEq(p.s_accessController(), address(0), "anyone may call verify");
    }

    /// @dev The proxy routes on reportContext[0] (the DON config digest); an unknown digest has no verifier.
    function test_UnsignedReportRevertsInVerify() public {
        bytes32[3] memory ctx;
        ctx[0] = keccak256("not a DON config digest");
        bytes memory reportData = abi.encode(
            BTC, uint32(block.timestamp), uint32(block.timestamp), uint192(0), uint192(0),
            uint32(block.timestamp + 1 days), int192(78_000e18), int192(77_999e18), int192(78_001e18)
        );
        bytes memory report = abi.encode(ctx, reportData, new bytes32[](0), new bytes32[](0), bytes32(0));
        vm.expectRevert(abi.encodeWithSignature("VerifierNotFound(bytes32)", ctx[0]));
        feed.submit(report);
        assertEq(feed.latestRound(), 0);
        vm.expectRevert(abi.encodeWithSignature("VerifierNotFound(bytes32)", ctx[0]));
        feed.submitSettlement(report, block.timestamp);
        (,, uint32 firstSubmittedAt,) = feed.settlements(block.timestamp);
        assertEq(firstSubmittedAt, 0);
    }

    function test_MalformedReportReverts() public {
        vm.expectRevert();
        feed.submit(hex"1234");
        vm.expectRevert(abi.encodeWithSignature("VerifierNotFound(bytes32)", bytes32(0)));
        feed.submit(new bytes(32 * 12));
        assertEq(feed.latestRound(), 0);
    }
}
