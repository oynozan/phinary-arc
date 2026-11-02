/**
 * Helpers for the moment a transaction is built. Previews are computed in the browser, but a user
 * takes 10-30 seconds to confirm in their wallet, and a short market's price moves noticeably in that
 * time. So right before sending we read the contract's own quote and bound the price against what it
 * could become while the transaction is confirming.
 */
import { maxUint256, type Address } from 'viem'
import type { usePublicClient } from 'wagmi'
import { MARKET_ADDRESS, WAD, type Quote } from '@/lib/contracts'
import { costOf, unitsForStake, wadToNumber } from '@/lib/format'
import { marketAbi } from '@/lib/abis'
import { rpc } from '@/lib/realtime'
import { TRADING_CLOSE_S, localQuote } from '@/lib/pricing'

export interface ChainQuote {
  buyUp: bigint
  buyDown: bigint
  sellUp: bigint
  sellDown: bigint
  spot: bigint
  sigma: bigint
  edge: bigint
  timeLeft: number
}

const market = { address: MARKET_ADDRESS, abi: marketAbi } as const

/** Seconds of price drift to allow for (wallet confirmation plus block inclusion). */
const DRIFT_STEPS = [10, 20, 30, 45]
const CONFIRM_S = 45
const SECONDS_PER_YEAR = 31_536_000
/**
 * Oracle move to allow for while the transaction confirms: 2 sigma over the confirmation time. The keeper
 * pushes every 2 bps move (every change near expiry), so the oracle follows the market closely and this is
 * what it can travel; at the default vols that is 7-23 bps. The floor only binds for the calmest asset
 * (AAPL near its 0.15 vol floor, where 2 sigma is ~4 bps): 2.5x the push threshold, so one push that
 * overshoots it still fits.
 */
export const MIN_SPOT_MOVE = 0.0005
export const spotMove = (sigma: number) => Math.max(MIN_SPOT_MOVE, 2 * sigma * Math.sqrt(CONFIRM_S / SECONDS_PER_YEAR))
/** Rounding room only: the browser port matches the contract to about 1e-9. */
const BUY_PAD = 101n
const SELL_PAD = 99n
/** The contract never sells a side at 0.99 or more (BuyPriceTooHigh). */
const MAX_BUY = (WAD * 99n) / 100n

export async function fetchChainQuote(marketId: bigint): Promise<ChainQuote> {
  const [q, edge] = await Promise.all([
    rpc.readContract({ ...market, functionName: 'quote', args: [marketId] }),
    rpc.readContract({ ...market, functionName: 'priceEdge' }),
  ])
  return { buyUp: q[1], buyDown: q[3], sellUp: q[2], sellDown: q[4], spot: q[5], sigma: q[6], edge, timeLeft: Number(q[7]) }
}

/** A browser quote in the shape of the contract's, for previewing the bounds before anything is sent. */
export function chainFromQuote(q: Quote, edge: number): ChainQuote {
  return { buyUp: q.buyUp, buyDown: q.buyDown, sellUp: q.sellUp, sellDown: q.sellDown, spot: q.spot, sigma: q.sigma, edge: BigInt(Math.round(edge * 1e18)), timeLeft: Number(q.timeLeft) }
}

/** Quotes the market could show by the time the transaction lands: each drift step at spot unchanged and moved either way. */
function scenarios(c: ChainQuote, strike: number) {
  const spot = wadToNumber(c.spot)
  const sigma = wadToNumber(c.sigma)
  const move = spotMove(sigma)
  const out: Quote[] = []
  for (const s of [0, ...DRIFT_STEPS]) {
    // Landing inside the closing window reverts anyway, so there is nothing to bound there.
    if (c.timeLeft - s <= TRADING_CLOSE_S) continue
    for (const k of [1 - move, 1, 1 + move]) out.push(localQuote({ spot: spot * k, strike, sigma, timeLeft: c.timeLeft - s, edge: wadToNumber(c.edge) }))
  }
  return out
}

/** Highest buy price the position could cost by the time the transaction lands. */
export function worstBuyPrice(c: ChainQuote, strike: number, isUp: boolean): bigint {
  let worst = isUp ? c.buyUp : c.buyDown
  if (worst === 0n) return 0n
  for (const q of scenarios(c, strike)) {
    // A zero buy price outside the closing window means the side would cost 0.99 or more.
    const p = (isUp ? q.buyUp : q.buyDown) || MAX_BUY
    if (p > worst) worst = p
  }
  const padded = (worst * BUY_PAD) / 100n
  return padded > MAX_BUY ? MAX_BUY : padded
}

/** Lowest sell price to accept, covering the same drift and oracle moves. */
export function worstSellPrice(c: ChainQuote, strike: number, isUp: boolean): bigint {
  let worst = isUp ? c.sellUp : c.sellDown
  if (worst === 0n) return 0n
  for (const q of scenarios(c, strike)) {
    const p = isUp ? q.sellUp : q.sellDown
    if (p > 0n && p < worst) worst = p
  }
  return (worst * SELL_PAD) / 100n
}

/** Arc pays gas from the same USDC balance, so bets and deposits leave this much (0.05 USDC) in the wallet. */
export const GAS_RESERVE = 50_000n
/** What a wallet can put into a bet or deposit after the gas reserve. */
export const spendable = (balance: bigint) => (balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n)

/**
 * Units for a stake at the current price, and the most to pay for them: the cost at the worst price, capped
 * at the spendable balance. Capping the bound (instead of buying fewer units) keeps the bet the size the user
 * typed; if the price moves past what the wallet covers, the bet fails on slippage and costs only gas.
 * maxCost below the cost at the current price means the wallet can't afford the stake at all.
 */
export function sizeBuy(stake: bigint, current: bigint, worst: bigint, balance: bigint | undefined): { units: bigint; maxCost: bigint } {
  const units = unitsForStake(stake, current)
  const worstCost = costOf(units, worst)
  const cap = balance === undefined ? undefined : spendable(balance)
  return { units, maxCost: cap !== undefined && worstCost > cap ? cap : worstCost }
}

/** An error whose message is already written for the user. */
export class UserFacingError extends Error {}

/** A bet needs enough time left to survive wallet confirmation (and the 15s closing window). */
export const MIN_TIME_TO_BET_S = 60

export const ORACLE_WAIT_MESSAGE = 'Waiting for a fresh oracle price. Try again in a moment.'

/** Anything above this allowance counts as the one-time unlimited approval. */
export const UNLIMITED_ALLOWANCE = maxUint256
export const needsApproval = (allowance: bigint | undefined) => (allowance ?? 0n) < maxUint256 / 2n

type Client = NonNullable<ReturnType<typeof usePublicClient>>

/**
 * Works out the lowest proceeds to accept for a sell and checks it would succeed right now.
 * Throws a UserFacingError (or a contract revert) that the caller shows as a toast.
 */
export async function prepareSell(client: Client | undefined, account: Address, marketId: bigint, isUp: boolean, units: bigint): Promise<bigint> {
  const [chain, info] = await Promise.all([fetchChainQuote(marketId), rpc.readContract({ ...market, functionName: 'getMarket', args: [marketId] })])
  if (chain.timeLeft <= TRADING_CLOSE_S) throw new UserFacingError('Trading for this market has just closed.')
  const floor = worstSellPrice(chain, wadToNumber(info.strike), isUp)
  // Sell prices only read zero outside the closing window while the oracle price is too old for the time left.
  if (floor === 0n) throw new UserFacingError(ORACLE_WAIT_MESSAGE)
  const minProceeds = (units * floor) / WAD
  await client?.simulateContract({ ...market, functionName: 'sell', args: [marketId, isUp, units, minProceeds], account })
  return minProceeds
}
