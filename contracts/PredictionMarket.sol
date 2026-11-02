// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PriceOracleAdapter} from "./PriceOracleAdapter.sol";
import {BlackScholesLib} from "./lib/BlackScholesLib.sol";

/// @notice USDC-collateralized binary markets and a non-transferable internal LP vault on Arc.
/// @dev USDC must be a conventional, non-rebasing, non-fee-on-transfer, six-decimal ERC20.
///      One winning position unit pays one raw USDC unit. Prices/volatility are WAD.
///      A vault share has 9 display decimals: initially 1e9 internal share units buy
///      1e6 raw USDC units (one USDC). vaultStats sharePrice is WAD USDC per displayed
///      share: the raw assets/share ratio is multiplied by 1e3 to normalize decimals.
///      Oracle configuration is a trusted dependency. No native-token entry points exist.
///      Oracle update-ordering/front-running is an inherent residual risk of oracle-priced
///      markets. The edge and the trade staleness bound reduce it but do not cover an
///      informed trader near expiry, so trading also requires an oracle price no older than
///      timeLeft / ORACLE_AGE_RATIO. Exposure is bounded only by vault solvency.
contract PredictionMarket is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;
    uint256 public constant MIN_FAIR = 0.02e18;
    uint256 public constant MAX_FAIR = 0.98e18;
    // Below 1% the MAX_FAIR/MIN_FAIR clamps would sell near-certain payouts under 0.99.
    uint256 public constant MIN_EDGE = 0.01e18;
    uint256 public constant MAX_EDGE = 0.05e18;
    uint256 public constant ORACLE_AGE_RATIO = 4;
    uint256 public constant TRADING_CLOSE_BUFFER = 15;
    uint256 public constant VOID_DELAY = 24 hours;
    uint256 public constant DEPOSIT_LOCK = 1 hours;
    uint256 private constant VIRTUAL_SHARES = 1e3;
    /// @notice Shares (one displayed share) that must stay outstanding while markets hold reserves.
    uint256 public constant MIN_RESIDUAL_SHARES = 1e9;

    struct Market {
        uint8 assetId;
        uint8 status; // 0 Open, 1 Settled, 2 Voided
        bool upWon;
        uint40 createdAt;
        uint40 expiry;
        uint256 strike;
        uint256 settlePrice;
        uint256 upUnits;
        uint256 downUnits;
        uint256 totalCost;
    }
    struct Position { uint256 upUnits; uint256 downUnits; uint256 upCost; uint256 downCost; }
    struct Order { uint256 stopPrice; uint256 takeProfitPrice; }
    struct QuoteData {
        uint256 fairUp;
        uint256 buyUp;
        uint256 sellUp;
        uint256 buyDown;
        uint256 sellDown;
        uint256 spot;
        uint256 sigma;
        uint256 timeLeft;
        bool oracleTooOld;
    }

    IERC20 public immutable usdc;
    PriceOracleAdapter public immutable oracle;
    uint256 public priceEdge = 0.02e18;
    uint256 public maxStrikeDeviation = 0.10e18;
    uint256 public maxTradeStaleness = 120;
    uint256 public marketCount;
    uint256 public totalShares;
    uint256 public totalLocked;
    uint256 public unclaimedPayouts;
    mapping(uint32 => bool) public durationAllowed;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public lastDepositAt;
    mapping(uint256 => Market) private _markets;
    mapping(uint256 => mapping(address => Position)) private _positions;
    mapping(uint256 => mapping(address => mapping(bool => Order))) private _orders;

    // Voids refund cost basis, which can exceed the sell-back reserve due to cost rounding.
    // Protect any excess over _reserve(upUnits, downUnits) on trades and withdrawals
    // so open markets also remain collateralized for cost-basis refunds.
    uint256 private _voidRefundBuffer;

    error RenounceDisabled();
    error InvalidAddress();
    error InvalidUSDC();
    error InvalidMarket(uint256 marketId);
    error MarketNotOpen();
    error TradingClosed();
    error NotExpired();
    error VoidTooEarly();
    error InvalidAmount();
    error InvalidDuration();
    error InvalidStrike();
    error InvalidParameter();
    error BuyPriceTooHigh();
    error SlippageExceeded();
    error InsufficientPosition();
    error InsufficientVaultLiquidity();
    error NothingToClaim();
    error InvalidOrder();
    error OrderNotTriggered();
    error DepositLocked(uint256 unlockAt);
    error InsufficientShares();
    error LastLpWhileExposed();
    error OracleTooOldForExpiry();
    error UnsupportedTokenBehavior();

    event MarketCreated(uint256 indexed marketId, uint8 assetId, uint256 strike, uint256 expiry, address indexed creator);
    event Bought(uint256 indexed marketId, address indexed user, bool isUp, uint256 units, uint256 cost, uint256 fairPrice, uint256 oraclePrice, uint256 timestamp);
    event Sold(uint256 indexed marketId, address indexed user, bool isUp, uint256 units, uint256 proceeds, uint256 fairPrice, uint256 oraclePrice, uint256 timestamp);
    event Settled(uint256 indexed marketId, uint256 settlePrice, bool upWon);
    event Claimed(uint256 indexed marketId, address indexed user, uint256 amount);
    event Voided(uint256 indexed marketId);
    event OrderSet(uint256 indexed marketId, address indexed user, bool isUp, uint256 stopPrice, uint256 takeProfitPrice);
    event OrderCancelled(uint256 indexed marketId, address indexed user, bool isUp);
    event OrderExecuted(uint256 indexed marketId, address indexed user, bool isUp, uint256 units, uint256 proceeds, uint256 spot, uint8 triggered);
    event Deposited(address indexed user, uint256 amount, uint256 shares);
    event Withdrawn(address indexed user, uint256 shares, uint256 amount);
    event EdgeSet(uint256 oldEdge, uint256 newEdge);
    event DurationAllowedSet(uint32 duration, bool allowed);
    event MaxStrikeDeviationSet(uint256 oldDeviation, uint256 newDeviation);
    event MaxTradeStalenessSet(uint256 oldStaleness, uint256 newStaleness);

    constructor(address usdc_, address oracle_, address initialOwner) Ownable(initialOwner) {
        if (usdc_ == address(0) || oracle_ == address(0) || usdc_.code.length == 0 || oracle_.code.length == 0) {
            revert InvalidAddress();
        }
        if (IERC20Metadata(usdc_).decimals() != 6) revert InvalidUSDC();
        usdc = IERC20(usdc_);
        oracle = PriceOracleAdapter(oracle_);
        durationAllowed[300] = true;
        durationAllowed[900] = true;
        durationAllowed[3600] = true;
        emit DurationAllowedSet(300, true);
        emit DurationAllowedSet(900, true);
        emit DurationAllowedSet(3600, true);
        emit EdgeSet(0, priceEdge);
        emit MaxStrikeDeviationSet(0, maxStrikeDeviation);
    }

    /// @notice Ownership cannot be renounced; use the two-step ownership transfer instead.
    function renounceOwnership() public override { revert RenounceDisabled(); }

    /// @notice Pause only market creation, buys, and deposits. Exits remain enabled.
    function pause() external onlyOwner { _pause(); }
    /// @notice Reenable creation, buys, and deposits.
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Set the additive bid/ask edge, from 1% through 5% of a payout.
    function setEdge(uint256 edge) external onlyOwner {
        if (edge < MIN_EDGE || edge > MAX_EDGE) revert InvalidParameter();
        emit EdgeSet(priceEdge, edge);
        priceEdge = edge;
    }

    /// @notice Enable/disable a duration; enabled durations must exceed the close buffer.
    function setDurationAllowed(uint32 duration, bool allowed) external onlyOwner {
        if (allowed && duration <= TRADING_CLOSE_BUFFER) revert InvalidDuration();
        durationAllowed[duration] = allowed;
        emit DurationAllowedSet(duration, allowed);
    }

    /// @notice Set maximum strike deviation from spot; bounded to 100%.
    function setMaxStrikeDeviation(uint256 deviation) external onlyOwner {
        if (deviation > WAD) revert InvalidParameter();
        emit MaxStrikeDeviationSet(maxStrikeDeviation, deviation);
        maxStrikeDeviation = deviation;
    }

    /// @notice Bound trading price age in seconds, from 10 seconds through one day.
    function setMaxTradeStaleness(uint256 maxAge) external onlyOwner {
        if (maxAge < 10 || maxAge > 86400) revert InvalidParameter();
        emit MaxTradeStalenessSet(maxTradeStaleness, maxAge);
        maxTradeStaleness = maxAge;
    }

    /// @notice Create a permissionless market; strike zero means current spot. IDs start at 1.
    function createMarket(uint8 assetId, uint256 strike, uint32 duration)
        external whenNotPaused returns (uint256 id)
    {
        if (!durationAllowed[duration]) revert InvalidDuration();
        (uint256 spot,) = oracle.getPriceMaxAge(assetId, maxTradeStaleness);
        if (strike == 0) strike = spot;
        uint256 difference = strike > spot ? strike - spot : spot - strike;
        if (difference > Math.mulDiv(spot, maxStrikeDeviation, WAD)
            || strike > uint256(type(int256).max)) revert InvalidStrike();
        uint256 expiry = block.timestamp + duration;
        if (expiry > type(uint40).max) revert InvalidDuration();
        id = ++marketCount;
        _markets[id] = Market(assetId, 0, false, uint40(block.timestamp), uint40(expiry), strike, 0, 0, 0, 0);
        emit MarketCreated(id, assetId, strike, expiry, msg.sender);
    }

    /// @notice Market details; reverts for an unknown ID.
    function getMarket(uint256 marketId) external view returns (Market memory) { return _market(marketId); }

    /// @notice Paginate IDs starting at 1. from=0 aliases 1; oversized count is clamped.
    function getMarketsRange(uint256 from, uint256 count) external view returns (Market[] memory result) {
        if (from == 0) from = 1;
        if (from > marketCount) return new Market[](0);
        uint256 available = marketCount - from + 1;
        if (count > available) count = available;
        result = new Market[](count);
        for (uint256 i; i < count; ++i) result[i] = _markets[from + i];
    }

    /// @notice WAD side quotes. Non-open/expired markets return all zeros. In the close
    ///         buffer, or while the oracle price is too old for the time left
    ///         ((now - updatedAt) * ORACLE_AGE_RATIO > timeLeft), fair/spot/vol/timeLeft remain
    ///         available but executable buy/sell prices are zero.
    /// @dev A buy quote >=0.99 WAD is returned as zero (that buy is not executable).
    function quote(uint256 marketId) external view returns (
        uint256 fairUp, uint256 buyUp, uint256 sellUp, uint256 buyDown, uint256 sellDown,
        uint256 spot, uint256 sigma, uint256 timeLeft
    ) {
        QuoteData memory q = _quote(_market(marketId));
        return (q.fairUp, q.buyUp, q.sellUp, q.buyDown, q.sellDown, q.spot, q.sigma, q.timeLeft);
    }

    /// @notice Buy payout units, rounding USDC cost up. maxCost is raw USDC.
    function buy(uint256 marketId, bool isUp, uint256 units, uint256 maxCost)
        external nonReentrant whenNotPaused
    {
        Market storage m = _market(marketId);
        _requireTrading(m);
        if (units == 0) revert InvalidAmount();
        oracle.poke(m.assetId);
        QuoteData memory q = _quote(m);
        if (q.oracleTooOld) revert OracleTooOldForExpiry();
        uint256 price = isUp ? q.buyUp : q.buyDown;
        if (price == 0) revert BuyPriceTooHigh();
        uint256 cost = Math.mulDiv(units, price, WAD, Math.Rounding.Ceil);
        if (cost > maxCost) revert SlippageExceeded();
        uint256 oldExposure = _exposure(m);
        uint256 oldBuffer = _refundBuffer(m);
        Position storage p = _positions[marketId][msg.sender];
        if (isUp) {
            p.upUnits += units;
            p.upCost += cost;
            m.upUnits += units;
        } else {
            p.downUnits += units;
            p.downCost += cost;
            m.downUnits += units;
        }
        m.totalCost += cost;
        _updateExposure(m, oldExposure, oldBuffer);
        _pullExact(msg.sender, cost);
        _requireSolvent();
        emit Bought(marketId, msg.sender, isUp, units, cost, isUp ? q.fairUp : WAD - q.fairUp, q.spot, block.timestamp);
    }

    /// @notice Sell held payout units, rounding proceeds down; remains enabled when paused.
    function sell(uint256 marketId, bool isUp, uint256 units, uint256 minProceeds) external nonReentrant {
        Market storage m = _market(marketId);
        _requireTrading(m);
        if (units == 0) revert InvalidAmount();
        oracle.poke(m.assetId);
        QuoteData memory q = _quote(m);
        if (q.oracleTooOld) revert OracleTooOldForExpiry();
        uint256 proceeds = Math.mulDiv(units, isUp ? q.sellUp : q.sellDown, WAD);
        if (proceeds < minProceeds) revert SlippageExceeded();
        _sellPosition(marketId, msg.sender, isUp, units, proceeds, q);
    }

    /// @notice Resolve using the first complete oracle round at or after expiry. Equality is DOWN.
    function settle(uint256 marketId, uint80 roundId) external nonReentrant {
        Market storage m = _market(marketId);
        if (m.status != 0) revert MarketNotOpen();
        if (block.timestamp < m.expiry) revert NotExpired();
        uint256 price = oracle.settlementPrice(m.assetId, roundId, m.expiry);
        totalLocked -= _exposure(m);
        _voidRefundBuffer -= _refundBuffer(m);
        m.status = 1;
        m.settlePrice = price;
        m.upWon = price > m.strike;
        unclaimedPayouts += m.upWon ? m.upUnits : m.downUnits;
        emit Settled(marketId, price, m.upWon);
    }

    /// @notice After the resolution grace period anyone can void an unresolved market.
    function voidMarket(uint256 marketId) external nonReentrant {
        Market storage m = _market(marketId);
        if (m.status != 0) revert MarketNotOpen();
        if (block.timestamp < uint256(m.expiry) + VOID_DELAY) revert VoidTooEarly();
        totalLocked -= _exposure(m);
        _voidRefundBuffer -= _refundBuffer(m);
        m.status = 2;
        unclaimedPayouts += m.totalCost;
        emit Voided(marketId);
    }

    /// @notice Claim winning units or void cost-basis refund; no claim fees or owner withdrawal.
    function claim(uint256 marketId) external nonReentrant {
        Market storage m = _market(marketId);
        Position storage p = _positions[marketId][msg.sender];
        uint256 amount;
        if (m.status == 1) amount = m.upWon ? p.upUnits : p.downUnits;
        else if (m.status == 2) amount = p.upCost + p.downCost;
        if (amount == 0) revert NothingToClaim();
        delete _positions[marketId][msg.sender];
        _cancelIfPresent(marketId, msg.sender, true);
        _cancelIfPresent(marketId, msg.sender, false);
        unclaimedPayouts -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Claimed(marketId, msg.sender, amount);
    }

    /// @notice Set underlying-price stop/take-profit for a currently held side; zero disables a leg.
    function setOrder(uint256 marketId, bool isUp, uint256 stopPrice, uint256 takeProfitPrice) external {
        Market storage m = _market(marketId);
        _requireTrading(m);
        Position storage p = _positions[marketId][msg.sender];
        if ((isUp ? p.upUnits : p.downUnits) == 0) revert InsufficientPosition();
        if (stopPrice == 0 && takeProfitPrice == 0) revert InvalidOrder();
        (uint256 spot,) = oracle.getPriceMaxAge(m.assetId, maxTradeStaleness);
        if (isUp) {
            if ((stopPrice != 0 && stopPrice >= spot) || (takeProfitPrice != 0 && takeProfitPrice <= spot)) {
                revert InvalidOrder();
            }
        } else {
            if ((stopPrice != 0 && stopPrice <= spot) || (takeProfitPrice != 0 && takeProfitPrice >= spot)) {
                revert InvalidOrder();
            }
        }
        _orders[marketId][msg.sender][isUp] = Order(stopPrice, takeProfitPrice);
        emit OrderSet(marketId, msg.sender, isUp, stopPrice, takeProfitPrice);
    }

    /// @notice Cancel an existing order, even after trading closes or when paused.
    function cancelOrder(uint256 marketId, bool isUp) external {
        _market(marketId);
        Order storage o = _orders[marketId][msg.sender][isUp];
        if (o.stopPrice == 0 && o.takeProfitPrice == 0) revert InvalidOrder();
        _cancelIfPresent(marketId, msg.sender, isUp);
    }

    /// @notice Read underlying stop/take-profit thresholds for a position side.
    function getOrder(uint256 marketId, address user, bool isUp) external view returns (Order memory) {
        _market(marketId);
        return _orders[marketId][user][isUp];
    }

    /// @notice Permissionless all-units order execution. Pays the position owner, never the keeper.
    /// @dev Stop has precedence (trigger code 1); take profit has code 2. Works while paused.
    function executeOrder(uint256 marketId, address user, bool isUp) external nonReentrant {
        Market storage m = _market(marketId);
        _requireTrading(m);
        Order memory o = _orders[marketId][user][isUp];
        if (o.stopPrice == 0 && o.takeProfitPrice == 0) revert InvalidOrder();
        oracle.poke(m.assetId);
        QuoteData memory q = _quote(m);
        if (q.oracleTooOld) revert OracleTooOldForExpiry();
        uint8 triggered;
        if (o.stopPrice != 0 && (isUp ? q.spot <= o.stopPrice : q.spot >= o.stopPrice)) triggered = 1;
        else if (o.takeProfitPrice != 0 && (isUp ? q.spot >= o.takeProfitPrice : q.spot <= o.takeProfitPrice)) triggered = 2;
        if (triggered == 0) revert OrderNotTriggered();
        Position storage p = _positions[marketId][user];
        uint256 units = isUp ? p.upUnits : p.downUnits;
        if (units == 0) revert InsufficientPosition();
        uint256 proceeds = Math.mulDiv(units, isUp ? q.sellUp : q.sellDown, WAD);
        _sellPosition(marketId, user, isUp, units, proceeds, q);
        emit OrderExecuted(marketId, user, isUp, units, proceeds, q.spot, triggered);
    }

    /// @notice Deposit raw USDC and mint floor-rounded non-transferable LP shares.
    /// @dev Virtual offset is 1000 shares and one raw USDC unit. Any deposit relocks all caller shares.
    ///      HIGH NAV counts open-market trader collateral, so a large buy just before a deposit
    ///      inflates it; minShares bounds that.
    function deposit(uint256 amount, uint256 minShares) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        uint256 minted = previewDeposit(amount);
        if (minted == 0) revert InvalidAmount();
        if (minted < minShares) revert SlippageExceeded();
        shares[msg.sender] += minted;
        totalShares += minted;
        lastDepositAt[msg.sender] = block.timestamp;
        _pullExact(msg.sender, amount);
        emit Deposited(msg.sender, amount, minted);
    }

    /// @notice Preview floor-rounded shares minted at HIGH NAV, before transferring a deposit.
    function previewDeposit(uint256 amount) public view returns (uint256 shares) {
        return Math.mulDiv(amount, totalShares + VIRTUAL_SHARES, totalAssets() + 1);
    }

    /// @notice Preview floor-rounded raw USDC at LOW NAV, excluding open-market reserves.
    /// @dev Active-market withdrawals are priced conservatively; shares still held when markets
    ///      settle are priced at full NAV again. This preview does not check balances, locks,
    ///      the last-LP rule, or nonzero output.
    function previewWithdraw(uint256 shares) public view returns (uint256 amount) {
        return Math.mulDiv(shares, freeLiquidity() + 1, totalShares + VIRTUAL_SHARES);
    }

    /// @notice Burn shares for at least minAmount floor-rounded raw USDC once the deposit lock expires.
    /// @dev Withdrawals during active markets use conservative LOW NAV, including void-refund
    ///      reserves; the haircut goes to the remaining LPs. Anyone can lower LOW NAV with buys,
    ///      so minAmount bounds the payout. While reserves are open, a withdrawal that would leave
    ///      fewer than MIN_RESIDUAL_SHARES outstanding reverts: nobody (or only dust shares, which
    ///      would capture the released reserve at a huge share price) would own the reserve
    ///      released at settlement.
    function withdraw(uint256 shareAmount, uint256 minAmount) external nonReentrant {
        if (shareAmount == 0) revert InvalidAmount();
        if (shareAmount > shares[msg.sender]) revert InsufficientShares();
        uint256 unlock = depositUnlockAt(msg.sender);
        if (block.timestamp < unlock) revert DepositLocked(unlock);
        if (totalLocked + _voidRefundBuffer > 0 && totalShares - shareAmount < MIN_RESIDUAL_SHARES) {
            revert LastLpWhileExposed();
        }
        uint256 amount = previewWithdraw(shareAmount);
        if (amount == 0) revert InvalidAmount();
        if (amount < minAmount) revert SlippageExceeded();
        uint256 available = freeLiquidity();
        if (amount > available) revert InsufficientVaultLiquidity();
        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        usdc.safeTransfer(msg.sender, amount);
        _requireSolvent();
        emit Withdrawn(msg.sender, shareAmount, amount);
    }

    /// @notice Raw vault balance net of outstanding resolved/void claim liabilities, floored at zero.
    function totalAssets() public view returns (uint256) {
        uint256 balance = usdc.balanceOf(address(this));
        return balance > unclaimedPayouts ? balance - unclaimedPayouts : 0;
    }

    /// @notice LOW NAV: raw balance net of unclaimed payouts and worst-case open-market reserves.
    /// @dev totalLocked + _voidRefundBuffer sums max(sell-back reserve, void refund) per market.
    function freeLiquidity() public view returns (uint256) {
        uint256 assets = totalAssets();
        uint256 reserve = totalLocked + _voidRefundBuffer;
        return assets > reserve ? assets - reserve : 0;
    }

    /// @notice Internal LP share units (9 UI decimals).
    function sharesOf(address user) external view returns (uint256) { return shares[user]; }

    /// @notice Zero for a never-deposited account, otherwise the latest deposit timestamp plus one hour.
    function depositUnlockAt(address user) public view returns (uint256) {
        return lastDepositAt[user] == 0 ? 0 : lastDepositAt[user] + DEPOSIT_LOCK;
    }

    /// @notice Raw USDC vault accounting and WAD USDC per 1e9-unit displayed share.
    /// @dev sharePrice1e18 = (totalAssets+1)*1e18*1e3/(totalShares+1e3), initially 1e18.
    ///      withdrawSharePrice1e18 uses LOW NAV instead; active-market withdrawals are
    ///      conservative and shares held through settlement recover to full NAV pricing.
    function vaultStats() external view returns (
        uint256 balance, uint256 assets, uint256 shareSupply, uint256 locked,
        uint256 pendingPayouts, uint256 free, uint256 sharePrice1e18, uint256 withdrawSharePrice1e18
    ) {
        balance = usdc.balanceOf(address(this));
        assets = balance > unclaimedPayouts ? balance - unclaimedPayouts : 0;
        shareSupply = totalShares;
        locked = totalLocked;
        pendingPayouts = unclaimedPayouts;
        uint256 reserve = locked + _voidRefundBuffer;
        free = assets > reserve ? assets - reserve : 0;
        sharePrice1e18 = Math.mulDiv(assets + 1, 1e21, shareSupply + VIRTUAL_SHARES);
        withdrawSharePrice1e18 = Math.mulDiv(free + 1, 1e21, shareSupply + VIRTUAL_SHARES);
    }

    /// @notice Payout units and remaining raw-USDC cost basis for both sides.
    function getPosition(uint256 marketId, address user) external view returns (
        uint256 upUnits, uint256 downUnits, uint256 upCost, uint256 downCost
    ) {
        _market(marketId);
        Position storage p = _positions[marketId][user];
        return (p.upUnits, p.downUnits, p.upCost, p.downCost);
    }

    function _market(uint256 marketId) private view returns (Market storage m) {
        if (marketId == 0 || marketId > marketCount) revert InvalidMarket(marketId);
        return _markets[marketId];
    }

    function _requireTrading(Market storage m) private view {
        if (m.status != 0) revert MarketNotOpen();
        if (block.timestamp + TRADING_CLOSE_BUFFER >= m.expiry) revert TradingClosed();
    }

    function _quote(Market storage m) private view returns (QuoteData memory q) {
        if (m.status != 0 || block.timestamp >= m.expiry) return q;
        q.timeLeft = uint256(m.expiry) - block.timestamp;
        uint256 updatedAt;
        (q.spot, updatedAt) = oracle.getPriceMaxAge(m.assetId, maxTradeStaleness);
        q.sigma = oracle.getVol(m.assetId);
        q.fairUp = BlackScholesLib.binaryUpPrice(q.spot, m.strike, q.sigma, q.timeLeft);
        if (q.fairUp < MIN_FAIR) q.fairUp = MIN_FAIR;
        if (q.fairUp > MAX_FAIR) q.fairUp = MAX_FAIR;
        // An unseen move during the oracle age is known off chain; near expiry it outweighs the edge.
        q.oracleTooOld = (block.timestamp - updatedAt) * ORACLE_AGE_RATIO > q.timeLeft;
        if (q.timeLeft <= TRADING_CLOSE_BUFFER || q.oracleTooOld) return q;
        uint256 fairDown = WAD - q.fairUp;
        q.buyUp = q.fairUp + priceEdge;
        q.buyDown = fairDown + priceEdge;
        if (q.buyUp >= 0.99e18) q.buyUp = 0;
        if (q.buyDown >= 0.99e18) q.buyDown = 0;
        q.sellUp = _sellPrice(q.fairUp);
        q.sellDown = _sellPrice(fairDown);
    }

    function _sellPrice(uint256 fair) private view returns (uint256) {
        return fair > priceEdge + 0.01e18 ? fair - priceEdge : 0.01e18;
    }

    function _sellPosition(
        uint256 marketId, address user, bool isUp, uint256 units, uint256 proceeds, QuoteData memory q
    ) private {
        _reducePosition(marketId, user, isUp, units);
        // Validate the post-transfer balance before interacting with the token as well.
        uint256 available = usdc.balanceOf(address(this));
        uint256 required = totalLocked + unclaimedPayouts + _voidRefundBuffer;
        if (available < required || proceeds > available - required) revert InsufficientVaultLiquidity();
        if (proceeds != 0) usdc.safeTransfer(user, proceeds);
        _requireSolvent();
        emit Sold(marketId, user, isUp, units, proceeds, isUp ? q.fairUp : WAD - q.fairUp, q.spot, block.timestamp);
    }

    function _reducePosition(uint256 marketId, address user, bool isUp, uint256 units) private {
        Market storage m = _markets[marketId];
        Position storage p = _positions[marketId][user];
        uint256 oldExposure = _exposure(m);
        uint256 oldBuffer = _refundBuffer(m);
        uint256 held = isUp ? p.upUnits : p.downUnits;
        if (held < units) revert InsufficientPosition();
        uint256 basis = Math.mulDiv(isUp ? p.upCost : p.downCost, units, held);
        if (isUp) {
            p.upUnits -= units;
            p.upCost -= basis;
            m.upUnits -= units;
        } else {
            p.downUnits -= units;
            p.downCost -= basis;
            m.downUnits -= units;
        }
        m.totalCost -= basis;
        if (held == units) _cancelIfPresent(marketId, user, isUp);
        _updateExposure(m, oldExposure, oldBuffer);
    }

    function _cancelIfPresent(uint256 marketId, address user, bool isUp) private {
        Order storage o = _orders[marketId][user][isUp];
        if (o.stopPrice == 0 && o.takeProfitPrice == 0) return;
        delete _orders[marketId][user][isUp];
        emit OrderCancelled(marketId, user, isUp);
    }

    /// @dev Reserve both settlement exposure and sell-back liquidity. Before integer rounding,
    ///      reducing either side by s releases at least 0.99*s, hence at least p*s for
    ///      any sell price p <= 0.99. With ceiling-rounded reserves, the release is at
    ///      least floor(0.99*s), covering the floor-rounded proceeds floor(p*s).
    ///      Thus a sell preserves balance >= unclaimedPayouts + totalLocked, with
    ///      any additional void-refund reserve accounted for separately below.
    function _reserve(uint256 up, uint256 down) internal pure returns (uint256) {
        return Math.max(up, down) + Math.mulDiv(Math.min(up, down), 99, 100, Math.Rounding.Ceil);
    }

    function _exposure(Market storage m) private view returns (uint256) {
        return _reserve(m.upUnits, m.downUnits);
    }

    function _refundBuffer(Market storage m) private view returns (uint256) {
        uint256 exposure = _exposure(m);
        return m.totalCost > exposure ? m.totalCost - exposure : 0;
    }

    function _updateExposure(Market storage m, uint256 oldExposure, uint256 oldBuffer) private {
        totalLocked = totalLocked - oldExposure + _exposure(m);
        _voidRefundBuffer = _voidRefundBuffer - oldBuffer + _refundBuffer(m);
    }

    function _requireSolvent() private view {
        if (usdc.balanceOf(address(this)) < totalLocked + unclaimedPayouts + _voidRefundBuffer) {
            revert InsufficientVaultLiquidity();
        }
    }

    function _pullExact(address from, uint256 amount) private {
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(from, address(this), amount);
        uint256 afterBalance = usdc.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert UnsupportedTokenBehavior();
    }
}
