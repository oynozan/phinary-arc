import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { toast } from 'sonner'
import { BaseError, ContractFunctionRevertedError, type Hex, type TransactionReceipt } from 'viem'
import { UserFacingError } from '@/lib/bet'
import { CHAIN_ID } from '@/lib/contracts'
import { isTestnet } from '@/lib/network'

export type TxStatus = 'idle' | 'signing' | 'confirming' | 'success' | 'error'

export interface TxState {
  status: TxStatus
  hash?: Hex
  error?: string
}

const REVERT_MESSAGES: Record<string, string> = {
  SlippageExceeded: 'The price moved while you were confirming. Try again.',
  InsufficientVaultLiquidity: 'The vault cannot cover this bet right now. Try a smaller amount.',
  BuyPriceTooHigh: 'Odds are too extreme to bet right now.',
  TradingClosed: 'Trading for this market has just closed.',
  MarketNotOpen: 'This market is no longer open.',
  StalePrice: 'The oracle price is stale. Try again in a moment.',
  OracleTooOldForExpiry: 'Waiting for a fresh oracle price. Try again in a moment.',
  DepositLocked: 'Deposits are locked for 1 hour before they can be withdrawn.',
  InvalidStrike: 'That strike is too far from the current price.',
  InvalidDuration: 'That market length is not available.',
  InvalidOrder: 'Stop loss and take profit must be on the correct side of the current price.',
  OrderNotTriggered: 'That order has not been triggered.',
  InsufficientPosition: 'You do not hold enough of this position.',
  NothingToClaim: 'There is nothing to claim here.',
  InvalidSettlementRound: 'Settlement is not ready yet.',
  NotExpired: 'This market has not expired yet.',
  LastLpWhileExposed: 'While markets are open the vault keeps at least one share. Withdraw a little less.',
}

export function parseOnchainError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName
      if (name) return REVERT_MESSAGES[name] ?? `Transaction failed: ${name}`
    }
  }
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.toLowerCase()
  if (message.includes('user rejected') || message.includes('user denied')) return 'Transaction cancelled.'
  if (message.includes('insufficient funds') || message.includes('exceeds balance')) return isTestnet ? 'Insufficient balance. Get test USDC and try again.' : 'Insufficient balance. Add USDC and try again.'
  if (message.includes('insufficientvaultliquidity')) return 'The vault cannot cover this bet right now. Try a smaller amount.'
  if (message.includes('buypricetoohigh')) return 'Odds are too extreme to bet right now.'
  if (message.includes('tradingclosed')) return 'Trading for this market has closed.'
  if (message.includes('slippage') || message.includes('toomuch') || message.includes('maxcost')) return 'The price moved. Try again.'
  if (message.includes('staleprice')) return 'The oracle price is stale. Try again in a moment.'
  if (message.includes('oracletoooldforexpiry')) return 'Waiting for a fresh oracle price. Try again in a moment.'
  if (message.includes('depositlocked')) return 'Deposits are locked for 1 hour before they can be withdrawn.'
  if (message.includes('reverted')) {
    const match = /reverted with the following (?:reason|signature):\s*([^\n]+)/i.exec(raw)
    return match ? `Transaction failed: ${match[1].trim()}` : 'Transaction failed. Please try again.'
  }
  if (message.includes('network') || message.includes('timeout')) return 'Network issue. Check your connection and retry.'
  return 'Something went wrong. Please try again.'
}

/**
 * Wraps a wagmi contract write with chain switching, honest signing/confirming states and a
 * receipt wait. `runReceipt` resolves with the receipt (or undefined on failure); `run` resolves true/false.
 */
export function useTx() {
  const { chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const [state, setState] = useState<TxState>({ status: 'idle' })

  const runReceipt = useCallback(
    async (label: string | undefined, send: () => Promise<Hex>): Promise<TransactionReceipt | undefined> => {
      try {
        if (chainId !== CHAIN_ID) await switchChainAsync({ chainId: CHAIN_ID })
        setState({ status: 'signing' })
        const hash = await send()
        setState({ status: 'confirming', hash })
        const receipt = await client?.waitForTransactionReceipt({ hash })
        if (!receipt || receipt.status !== 'success') throw new Error('Transaction reverted')
        setState({ status: 'success', hash })
        if (label) toast.success(label)
        return receipt
      } catch (e) {
        const message = parseOnchainError(e)
        if (message === 'Transaction cancelled.') {
          setState({ status: 'idle' })
        } else {
          setState({ status: 'error', error: message })
          toast.error(message)
        }
        return undefined
      }
    },
    [chainId, client, switchChainAsync],
  )

  const run = useCallback(async (label: string | undefined, send: () => Promise<Hex>): Promise<boolean> => !!(await runReceipt(label, send)), [runReceipt])

  const reset = useCallback(() => setState({ status: 'idle' }), [])
  const busy = state.status === 'signing' || state.status === 'confirming'

  return { write: writeContractAsync, run, runReceipt, state, busy, reset }
}
