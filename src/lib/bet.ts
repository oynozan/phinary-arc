/**
 * Helpers for the moment a transaction is built. Previews are computed in the browser, but a user
 * takes 10-30 seconds to confirm in their wallet, and a short market's price moves noticeably in that
 * time. So right before sending we read the contract's own quote and bound the price against what it
 * could become while the transaction is confirming.
 */
import { maxUint256, type Address } from 'viem'
import type { usePublicClient } from 'wagmi'
import { MARKET_ADDRESS, WAD } from '@/lib/contracts'
import { wadToNumber } from '@/lib/format'
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
/** Extra room for the oracle price ticking while the transaction confirms. */
const BUY_PAD = 103n
const SELL_PAD = 97n

export async function fetchChainQuote(marketId: bigint): Promise<ChainQuote> {
  const [q, edge] = await Promise.all([
    rpc.readContract({ ...market, functionName: 'quote', args: [marketId] }),
    rpc.readContract({ ...market, functionName: 'priceEdge' }),
  ])
  return { buyUp: q[1], buyDown: q[3], sellUp: q[2], sellDown: q[4], spot: q[5], sigma: q[6], edge, timeLeft: Number(q[7]) }
}

function drifted(c: ChainQuote, strike: number, secondsLater: number) {
  return localQuote({
    spot: wadToNumber(c.spot),
    strike,
    sigma: wadToNumber(c.sigma),
    timeLeft: Math.max(c.timeLeft - secondsLater, 1),
    edge: wadToNumber(c.edge),
  })
}

/** Highest buy price the position could cost by the time the transaction lands. */
export function worstBuyPrice(c: ChainQuote, strike: number, isUp: boolean): bigint {
  let worst = isUp ? c.buyUp : c.buyDown
  for (const s of DRIFT_STEPS) {
    const q = drifted(c, strike, s)
    const p = isUp ? q.buyUp : q.buyDown
    if (p > worst) worst = p
  }
  const padded = (worst * BUY_PAD) / 100n
  return padded > WAD ? WAD : padded
}

/** Lowest sell price to accept, covering the same drift. */
export function worstSellPrice(c: ChainQuote, strike: number, isUp: boolean): bigint {
  let worst = isUp ? c.sellUp : c.sellDown
  for (const s of DRIFT_STEPS) {
    const q = drifted(c, strike, s)
    const p = isUp ? q.sellUp : q.sellDown
    if (p > 0n && p < worst) worst = p
  }
  return (worst * SELL_PAD) / 100n
}

/** An error whose message is already written for the user. */
export class UserFacingError extends Error {}

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
  const minProceeds = (units * floor) / WAD
  await client?.simulateContract({ ...market, functionName: 'sell', args: [marketId, isUp, units, minProceeds], account })
  return minProceeds
}
