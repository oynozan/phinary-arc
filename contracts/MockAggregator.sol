// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @notice TESTNET ONLY: centrally writable feed; never use for production settlement.
contract MockAggregator is AggregatorV3Interface, Ownable2Step {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        uint80 answeredInRound;
    }

    error RenounceDisabled();
    error UnauthorizedUpdater(address caller);
    error ZeroAddress();

    uint8 public immutable override decimals;
    string public override description;
    uint256 public constant override version = 1;
    uint80 public latestRoundId;
    mapping(address => bool) public updaters;
    mapping(uint80 => Round) private _rounds;

    event UpdaterSet(address indexed updater, bool allowed);
    event PriceSet(uint80 indexed roundId, int256 answer, uint256 timestamp);
    /// @dev Chainlink aggregator event, also emitted by StreamsFeed, so one listener fits both networks.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    constructor(address initialOwner, uint8 decimals_, string memory description_) Ownable(initialOwner) {
        decimals = decimals_;
        description = description_;
    }

    /// @notice Ownership cannot be renounced; use the two-step ownership transfer instead.
    function renounceOwnership() public override { revert RenounceDisabled(); }

    /// @notice Authorize or revoke a testnet price updater.
    function setUpdater(address updater, bool allowed) external onlyOwner {
        if (updater == address(0)) revert ZeroAddress();
        updaters[updater] = allowed;
        emit UpdaterSet(updater, allowed);
    }

    /// @notice Append a round, including deliberately invalid answers for testing.
    function setPrice(int256 answer) external {
        if (msg.sender != owner() && !updaters[msg.sender]) revert UnauthorizedUpdater(msg.sender);
        uint80 id = ++latestRoundId;
        _rounds[id] = Round(answer, block.timestamp, block.timestamp, id);
        emit PriceSet(id, answer, block.timestamp);
        emit AnswerUpdated(answer, id, block.timestamp);
    }

    function getRoundData(uint80 roundId) public view override returns (
        uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        require(roundId != 0 && roundId <= latestRoundId, "No data present");
        Round storage r = _rounds[roundId];
        return (roundId, r.answer, r.startedAt, r.updatedAt, r.answeredInRound);
    }

    function latestRoundData() external view override returns (
        uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return getRoundData(latestRoundId);
    }
}
