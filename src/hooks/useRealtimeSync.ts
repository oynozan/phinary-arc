import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { erc20Abi, getAbiItem, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { aggregatorAbi, marketAbi, oracleAbi } from '@/lib/abis'
import { ASSETS, FEED_ADDRESSES, MARKET_ADDRESS, ORACLE_ADDRESS } from '@/lib/contracts'
import { fmtDurationLong, fmtUsdc } from '@/lib/format'
import { rpc, wsClient } from '@/lib/realtime'
import { trackMarket } from '@/lib/session'
import { qk, fetchPosition, type OracleSpot, type SeriesPoint } from './data'
import type { Bet } from './useMarketBets'

const priceSetEvent = getAbiItem({ abi: aggregatorAbi, name: 'PriceSet' })
const transferEvent = getAbiItem({ abi: erc20Abi, name: 'Transfer' })
const notified = new Set<string>()

/**
 * Subscribes once to everything the UI shows live and writes pushed data straight into the query
 * cache. Replaces all polling: prices, markets, positions, balances, vault and history update
 * the moment the chain (or Coinbase, for the chart) pushes them.
 */
export function useRealtimeSync() {
  const qc = useQueryClient()
  const { address } = useAccount()
  const meRef = useRef<Address | undefined>(address)

  useEffect(() => {
    meRef.current = address
  }, [address])

  // Market contract events: markets, bets, positions, vault, history, result toasts.
  useEffect(() => {
    const announce = async (marketId: bigint) => {
      const who = meRef.current
      const key = String(marketId)
      if (!who || notified.has(key)) return
      try {
        const [m, pos] = await Promise.all([
          rpc.readContract({ address: MARKET_ADDRESS, abi: marketAbi, functionName: 'getMarket', args: [marketId] }),
          fetchPosition(marketId, who),
        ])
        if (pos.upUnits === 0n && pos.downUnits === 0n) return
        notified.add(key)
        const asset = ASSETS[m.assetId]
        const label = `${asset.key} ${fmtDurationLong(Number(m.expiry) - Number(m.createdAt))} market`
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
        const who = meRef.current?.toLowerCase()
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
              qc.setQueryData<Bet[]>(qk.bets(a.marketId as bigint), (prev) => (prev && !prev.some((b) => b.key === bet.key) ? [...prev, bet] : prev))
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
        if (mine && who) {
          void qc.invalidateQueries({ queryKey: ['position'] })
          void qc.invalidateQueries({ queryKey: ['positions', meRef.current] })
          void qc.invalidateQueries({ queryKey: ['usdc', meRef.current] })
          void qc.invalidateQueries({ queryKey: ['history', meRef.current] })
        }
      },
    })
  }, [qc])

  // Oracle prices pushed from the feed contracts.
  useEffect(() => {
    return wsClient.watchEvent({
      address: FEED_ADDRESSES,
      event: priceSetEvent,
      poll: false,
      onLogs: (logs) => {
        for (const l of logs) {
          const assetId = FEED_ADDRESSES.findIndex((f) => f.toLowerCase() === l.address.toLowerCase())
          const answer = l.args.answer
          const timestamp = l.args.timestamp
          if (assetId < 0 || answer === undefined || timestamp === undefined) continue
          const spot: OracleSpot = { price: answer * 10n ** 10n, updatedAt: Number(timestamp) }
          qc.setQueryData(qk.oracle(assetId), spot)
          qc.setQueryData<SeriesPoint[]>(qk.oracleSeries(assetId), (prev) => [...(prev ?? []), { t: spot.updatedAt * 1000, p: Number(answer) / 1e8 }].slice(-600))
        }
      },
    })
  }, [qc])

  // Volatility changes when the oracle records a new observation.
  useEffect(() => {
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
  }, [qc])

  // Wallet USDC balance: any transfer to or from the connected wallet (including faucet drips).
  useEffect(() => {
    if (!address) return
    const refresh = () => void qc.invalidateQueries({ queryKey: qk.usdc(address) })
    const a = wsClient.watchEvent({ event: transferEvent, args: { from: address }, poll: false, onLogs: refresh })
    const b = wsClient.watchEvent({ event: transferEvent, args: { to: address }, poll: false, onLogs: refresh })
    return () => {
      a()
      b()
    }
  }, [qc, address])
}
