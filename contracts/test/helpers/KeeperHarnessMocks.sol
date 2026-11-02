// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AggregatorV3Interface} from "../../interfaces/AggregatorV3Interface.sol";

/// @dev Test-only 6-decimal ERC20 whose runtime code is etched at the Arc USDC address on anvil.
contract HarnessUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// @dev Test-only Chainlink-proxy-style feed: round ids are (phaseId << 64) | aggregatorRoundId,
///      like EACAggregatorProxy. Anyone can push (test only). getRoundData reverts for unknown ids.
contract PhasedAggregator is AggregatorV3Interface {
    struct Round { int256 answer; uint256 updatedAt; }
    uint8 public constant override decimals = 8;
    string public override description = "PHASED / USD";
    uint256 public constant override version = 4;
    uint16 public phaseId = 1;
    uint64 public aggRound; // round inside the current phase
    uint80 public latestRoundId;
    mapping(uint80 => Round) private _rounds;

    function setPrice(int256 answer) external {
        aggRound += 1;
        uint80 id = uint80((uint256(phaseId) << 64) | aggRound);
        _rounds[id] = Round(answer, block.timestamp);
        latestRoundId = id;
    }

    function newPhase() external { phaseId += 1; aggRound = 0; }

    function getRoundData(uint80 roundId) public view override returns (uint80, int256, uint256, uint256, uint80) {
        Round storage r = _rounds[roundId];
        require(r.updatedAt != 0, "No data present");
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestRoundId);
    }
}
