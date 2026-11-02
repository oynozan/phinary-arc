import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { erc20Abi, getAbiItem, parseAbiItem, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { marketAbi, oracleAbi } from '@/lib/abis'
import { ASSETS, assetKey, MARKET_ADDRESS, ORACLE_ADDRESS, USDC_ADDRESS } from '@/lib/contracts'
import { fmtDurationLong, fmtUsdc } from '@/lib/format'
import { rpc, watchReconnects, wsClient } from '@/lib/realtime'
import { trackMarket } from '@/lib/session'
import { qk, fetchPosition, sigmaQuery, type OracleSpot, type SeriesPoint } from './data'
import { holdBetForScan, type Bet } from './useMarketBets'

/** Chainlink's aggregator event (StreamsFeed on mainnet, newer testnet mocks) and the older testnet MockAggregator's own event. */
const answerUpdatedEvent = parseAbiItem('event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)')
const priceSetEvent = parseAbiItem('event PriceSet(uint80 indexed roundId, int256 answer, uint256 timestamp)')
const decimalsFn = parseAbiItem('function decimals() view returns (uint8)')
const transferEvent = getAbiItem({ abi: erc20Abi, name: 'Transfer' })
const approvalEvent = getAbiItem({ abi: erc20Abi, name: 'Approval' })
const notified = new Set<string>()

/** Queries refreshed only by pushed events. The oracle series is left alone: it is built from events and has nothing to refetch. */
const LIVE_KEYS = new Set(['markets', 'oracle', 'sigma', 'params', 'strikeDeviation', 'position', 'positions', 'myMarkets', 'usdc', 'vault', 'previewWithdraw', 'bets', 'history'])

/** Refetch everything that events keep fresh, after a gap in which events may have been missed. */
export function resyncLive(qc: QueryClient): void {
  void qc.invalidateQueries({ predicate: (q) => LIVE_KEYS.has(String(q.queryKey[0])) })
}

/** Market contract events: markets, bets, positions, vault, history, result toasts. */
export function watchMarketEvents(qc: QueryClient, me: () => Address | undefined): () => void {
  const announce = async (marketId: bigint) => {
    const who = me()
    const key = `${who}:${marketId}`
    if (!who || notified.has(key)) return
    try {
      const [m, pos] = await Promise.all([
        rpc.readContract({ address: MARKET_ADDRESS, abi: marketAbi, functionName: 'getMarket', args: [marketId] }),
        fetchPosition(marketId, who),
      ])
      if (pos.upUnits === 0n && pos.downUnits === 0n) return
      notified.add(key)
      const label = `${assetKey(m.assetId)} ${fmtDurationLong(Number(m.expiry) - Number(m.createdAt))} market`
      const cost = pos.upCost + pos.downCost
      if (m.status === 2) {
        toast(`${label} was voided`, { description: `Your $${fmtUsdc(cost)} is refunded. Claim it in Positions.` })
        return
      }
      const win = m.upWon ? pos.upUnits : pos.downUnits
      if (win > 0n) toast(`You won on ${label}`, { description: `$${fmtUsdc(win)} is ready to claim.` })
      else toast(`You lost on ${label}`, { description: `${m.upWon ? 'Up' : 'Down'} won. You lost $${fmtUsdc(cost)}.` })
    } catch {
      /* the table still shows the result */
    }
  }

  return wsClient.watchContractEvent({
    address: MARKET_ADDRESS,
    abi: marketAbi,
    poll: false,
    onLogs: (logs) => {
      const who = me()?.toLowerCase()
      let vault = false
      let markets = false
      let mine = false
      for (const l of logs) {
        const a = l.args as Record<string, unknown>
        const isMine = !!who && typeof a.user === 'string' && a.user.toLowerCase() === who
        switch (l.eventName) {
          case 'Bought': {
            markets = vault = true
            const bet: Bet = {
              key: `${l.transactionHash}-${l.logIndex}`,
              user: a.user as Address,
              isUp: a.isUp as boolean,
              units: a.units as bigint,
              cost: a.cost as bigint,
              timestamp: Number(a.timestamp),
              oraclePrice: a.oraclePrice as bigint,
            }
            const betsKey = qk.bets(a.marketId as bigint)
            // A scan in flight stops at the head it read first, so it would drop this bet.
            if (qc.getQueryState(betsKey)?.fetchStatus === 'fetching') holdBetForScan(a.marketId as bigint, bet)
            qc.setQueryData<Bet[]>(betsKey, (prev) => (prev && !prev.some((b) => b.key === bet.key) ? [...prev, bet] : prev))
            if (isMine) trackMarket(a.marketId as bigint)
            break
          }
          case 'Sold':
          case 'Claimed':
            markets = vault = true
            break
          case 'OrderExecuted':
            markets = vault = true
            if (isMine) {
              const hit = Number(a.triggered) === 1 ? 'Stop loss' : 'Take profit'
              toast(`${hit} hit`, { description: `Your position was sold for $${fmtUsdc(a.proceeds as bigint)}.` })
            }
            break
          case 'MarketCreated':
            markets = true
            break
          case 'Settled':
          case 'Voided':
            markets = vault = mine = true
            void announce(a.marketId as bigint)
            break
          case 'Deposited':
          case 'Withdrawn':
            vault = true
            break
          case 'EdgeSet':
          case 'MaxTradeStalenessSet':
            void qc.invalidateQueries({ queryKey: qk.params })
            break
          case 'MaxStrikeDeviationSet':
            void qc.invalidateQueries({ queryKey: qk.strikeDeviation })
            break
          default:
            break
        }
        if (isMine) mine = true
      }
      if (markets) void qc.invalidateQueries({ queryKey: qk.markets })
      if (vault) {
        void qc.invalidateQueries({ queryKey: ['vault'] })
        void qc.invalidateQueries({ queryKey: ['previewWithdraw'] })
      }
      const current = me()
      if (mine && current) {
        void qc.invalidateQueries({ queryKey: ['position'] })
        void qc.invalidateQueries({ queryKey: ['positions', current] })
        void qc.invalidateQueries({ queryKey: qk.myMarkets(current) })
        void qc.invalidateQueries({ queryKey: ['usdc', current] })
        void qc.invalidateQueries({ queryKey: ['history', current] })
      }
    },
  })
}

/** A feed answer with `decimals` decimals -> 1e18 fixed point, as the oracle adapter normalizes it. */
export const toWad = (answer: bigint, decimals: number) => (decimals <= 18 ? answer * 10n ** BigInt(18 - decimals) : answer / 10n ** BigInt(decimals - 18))

/**
 * Oracle prices pushed from the feed contracts. A testnet mock that emits both events reports each round
 * twice, so a round is applied only when it is newer than the last one applied for that feed. The contract's
 * volatility takes a provisional step on every feed update, so sigma is read with each price and both land
 * in the cache together: a preview never pairs a fresh spot with the previous sigma.
 */
export function watchOraclePrices(qc: QueryClient): () => void {
  const lastRound = new Map<string, bigint>()
  // Feed decimals, read once per feed (8 for the testnet mocks; a mainnet feed may differ). A failed read is retried.
  const feedDecimals = new Map<string, Promise<number>>()
  const decimalsOf = (feed: Address): Promise<number> => {
    const k = feed.toLowerCase()
    let d = feedDecimals.get(k)
    if (!d) {
      d = rpc.readContract({ address: feed, abi: [decimalsFn], functionName: 'decimals' }).then(Number)
      void d.catch(() => feedDecimals.delete(k))
      feedDecimals.set(k, d)
    }
    return d
  }
  const apply = async (feed: Address, roundId: bigint, answer: bigint, updatedAt: bigint) => {
    const asset = ASSETS.find((a) => a.feed.toLowerCase() === feed.toLowerCase())
    // The adapter rejects a non-positive answer, so it never becomes the trading price.
    if (!asset || answer <= 0n) return
    const k = feed.toLowerCase()
    const last = lastRound.get(k)
    if (last !== undefined && roundId <= last) return
    lastRound.set(k, roundId)
    let price: bigint
    let sigma: number
    try {
      const [decimals, vol] = await Promise.all([decimalsOf(feed), sigmaQuery(asset.id).queryFn()])
      price = toWad(answer, decimals)
      sigma = vol
    } catch {
      void qc.invalidateQueries({ queryKey: qk.oracle(asset.id) })
      void qc.invalidateQueries({ queryKey: qk.sigma(asset.id) })
      return
    }
    // A newer round arrived while these reads ran; it applies its own price and sigma.
    if (lastRound.get(k) !== roundId) return
    const spot: OracleSpot = { price, updatedAt: Number(updatedAt) }
    qc.setQueryData(qk.sigma(asset.id), sigma)
    qc.setQueryData(qk.oracle(asset.id), spot)
    qc.setQueryData<SeriesPoint[]>(qk.oracleSeries(asset.id), (prev) => [...(prev ?? []), { t: spot.updatedAt * 1000, p: Number(price / 10n ** 9n) / 1e9 }].slice(-600))
  }
  return wsClient.watchEvent({
    address: ASSETS.map((a) => a.feed),
    events: [answerUpdatedEvent, priceSetEvent],
    poll: false,
    onLogs: (logs) => {
      for (const l of logs) {
        if (l.eventName === 'AnswerUpdated') {
          const { current, roundId, updatedAt } = l.args
          if (current !== undefined && roundId !== undefined && updatedAt !== undefined) void apply(l.address, roundId, current, updatedAt)
        } else if (l.eventName === 'PriceSet') {
          const { answer, roundId, timestamp } = l.args
          if (answer !== undefined && roundId !== undefined && timestamp !== undefined) void apply(l.address, roundId, answer, timestamp)
        }
      }
    },
  })
}

/** Volatility changes when the oracle records a new observation. */
export function watchVolatility(qc: QueryClient): () => void {
  return wsClient.watchContractEvent({
    address: ORACLE_ADDRESS,
    abi: oracleAbi,
    eventName: 'ObservationRecorded',
    poll: false,
    onLogs: (logs) => {
      for (const l of logs) {
        if (l.args.assetId !== undefined) void qc.invalidateQueries({ queryKey: qk.sigma(l.args.assetId) })
      }
    },
  })
}

/** Wallet USDC balance and allowance: any USDC transfer to or from the wallet (faucet drips included) and its approvals. */
export function watchWallet(qc: QueryClient, address: Address): () => void {
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.usdc(address) })
  const stops = [
    wsClient.watchEvent({ address: USDC_ADDRESS, event: transferEvent, args: { from: address }, poll: false, onLogs: refresh }),
    wsClient.watchEvent({ address: USDC_ADDRESS, event: transferEvent, args: { to: address }, poll: false, onLogs: refresh }),
    wsClient.watchEvent({ address: USDC_ADDRESS, event: approvalEvent, args: { owner: address }, poll: false, onLogs: refresh }),
  ]
  return () => stops.forEach((stop) => stop())
}

/** How long the tab must be hidden before coming back resyncs (a sleeping laptop can leave a socket half-open). */
const HIDDEN_RESYNC_MS = 60_000

/**
 * Subscribes once to everything the UI shows live and writes pushed data straight into the query
 * cache. Replaces all polling: prices, markets, positions, balances, vault and history update
 * the moment the chain (or Coinbase or Kraken, for the chart) pushes them. After a reconnect, or a long time
 * hidden, everything is refetched once, since events sent in the gap are lost.
 */
export function useRealtimeSync() {
  const qc = useQueryClient()
  const { address } = useAccount()
  const meRef = useRef<Address | undefined>(address)

  useEffect(() => {
    meRef.current = address
  }, [address])

  useEffect(() => watchMarketEvents(qc, () => meRef.current), [qc])
  useEffect(() => watchOraclePrices(qc), [qc])
  useEffect(() => watchVolatility(qc), [qc])

  useEffect(() => {
    if (!address) return
    return watchWallet(qc, address)
  }, [qc, address])

  useEffect(() => {
    const stop = watchReconnects(() => resyncLive(qc))
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > HIDDEN_RESYNC_MS) resyncLive(qc)
    }
    const onOnline = () => resyncLive(qc)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [qc])
}
