import { useState } from 'react'
import { useModal } from 'connectkit'
import { useAccount } from 'wagmi'
import { erc20Abi, formatUnits } from 'viem'
import { Loader2 } from 'lucide-react'
import { HelpTip } from '@/components/ui/help-tip'
import { Skeleton } from '@/components/ui/skeleton'
import { useNow } from '@/hooks/useMarkets'
import { usePreviewWithdraw, useUsdc, useVault } from '@/hooks/data'
import { useTx } from '@/hooks/useTx'
import { needsApproval, UNLIMITED_ALLOWANCE } from '@/lib/bet'
import { CHAIN_ID, MARKET, MARKET_ADDRESS, USDC_ADDRESS } from '@/lib/contracts'
import { fmtCountdown, fmtUsdc, wadToNumber } from '@/lib/format'
import { parseUsdc } from '@/onchain-money'

const SHARE_DECIMALS = 9
const PCTS = [25, 50, 75, 100]
const AMOUNTS = ['10', '50', '100']

function safeParse(v: string): bigint {
  try {
    return v.trim() === '' ? 0n : parseUsdc(v)
  } catch {
    return 0n
  }
}

function Stat({ label, value, tip }: { label: string; value?: string; tip?: string }) {
  return (
    <div className="card space-y-1">
      <div className="flex items-center gap-1 text-sm text-dim">
        {label}
        {tip && <HelpTip>{tip}</HelpTip>}
      </div>
      {value === undefined ? <Skeleton className="h-8 w-24" /> : <div className="num text-2xl font-semibold">{value}</div>}
    </div>
  )
}

export function VaultPanel() {
  const { address } = useAccount()
  const { setOpen } = useModal()
  const now = useNow()
  const { balance, allowance } = useUsdc(address)
  const { write, run, busy, state } = useTx()
  const [amount, setAmount] = useState('10')
  const [pct, setPct] = useState(100)

  const vault = useVault(address)
  const stats = vault.data?.stats
  const shares = vault.data?.shares ?? 0n
  const unlockAt = vault.data?.unlockAt ?? 0
  const withdrawShares = pct === 100 ? shares : (shares * BigInt(pct)) / 100n
  const withdrawValue = usePreviewWithdraw(withdrawShares)
  const fullValue = usePreviewWithdraw(shares)

  const amountRaw = safeParse(amount)
  const lockLeft = Math.max(0, unlockAt - Math.floor(now / 1000))
  const notEnough = !!address && (balance ?? 0n) < amountRaw

  const deposit = async () => {
    if (!address) {
      setOpen(true)
      return
    }
    if (needsApproval(allowance)) {
      const ok = await run('USDC approved', () => write({ address: USDC_ADDRESS, abi: erc20Abi, chainId: CHAIN_ID, functionName: 'approve', args: [MARKET_ADDRESS, UNLIMITED_ALLOWANCE] }))
      if (!ok) return
    }
    await run('Deposited', () => write({ ...MARKET, functionName: 'deposit', args: [amountRaw] }))
  }
  const withdraw = async () => {
    await run('Withdrawn', () => write({ ...MARKET, functionName: 'withdraw', args: [withdrawShares] }))
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold">Vault</h1>
        <HelpTip>The vault backs every payout. The house edge on each trade accrues to everyone who deposits.</HelpTip>
      </div>

      <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Stat label="Balance" value={stats ? `$${fmtUsdc(stats[0])}` : undefined} />
        <Stat label="Reserved" value={stats ? `$${fmtUsdc(stats[3])}` : undefined} tip="Held back to cover payouts on open markets." />
        <Stat label="Free" value={stats ? `$${fmtUsdc(stats[5])}` : undefined} tip="Liquidity available for new bets." />
        <Stat label="Share price" value={stats ? wadToNumber(stats[6]).toFixed(4) : undefined} />
      </div>

      <div className="grid items-stretch gap-6 md:grid-cols-2">
        <section className="card flex flex-col gap-6">
          <h2 className="flex items-center gap-1.5 text-base font-medium">
            Deposit
            <HelpTip>Deposits are locked for 1 hour before they can be withdrawn.</HelpTip>
          </h2>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-dim">Amount</span>
              {address && balance !== undefined && (
                <button className="num text-dim transition hover:text-white" onClick={() => setAmount(formatUnits(balance, 6))}>
                  Balance ${fmtUsdc(balance)}
                </button>
              )}
            </div>
            <div className="relative">
              <span className="num pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dim">$</span>
              <input className="field pl-8 pr-16" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-dim">USDC</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {AMOUNTS.map((a) => (
                <button key={a} className="chip" data-active={amount === a} onClick={() => setAmount(a)}>
                  ${a}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-auto">
            <button className="btn btn-primary w-full" disabled={busy || (!!address && (amountRaw === 0n || notEnough))} onClick={() => void deposit()}>
              {busy && <Loader2 className="animate-spin" size={18} />}
              {notEnough ? 'Not enough USDC' : 'Deposit'}
            </button>
          </div>
        </section>

        <section className="card flex flex-col gap-6">
          <h2 className="flex items-center gap-1.5 text-base font-medium">
            Your share
            <HelpTip>While markets are open, withdrawals are priced against the vault's worst case. The full value returns once they settle.</HelpTip>
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="panel space-y-1 p-4">
              <div className="text-sm text-dim">Shares</div>
              <div className="num text-base font-semibold">{address ? Number(formatUnits(shares, SHARE_DECIMALS)).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '0'}</div>
            </div>
            <div className="panel space-y-1 p-4">
              <div className="text-sm text-dim">Value</div>
              <div className="num text-base font-semibold">${fullValue !== undefined && shares > 0n ? fmtUsdc(fullValue) : '0.00'}</div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {PCTS.map((p) => (
              <button key={p} className="chip" data-active={pct === p} onClick={() => setPct(p)}>
                {p}%
              </button>
            ))}
          </div>
          <div className="mt-auto space-y-3">
            <button className="btn btn-secondary w-full" disabled={busy || !address || withdrawShares === 0n || lockLeft > 0} onClick={() => void withdraw()}>
              {busy && <Loader2 className="animate-spin" size={18} />}
              {lockLeft > 0 ? `Locked for ${fmtCountdown(lockLeft)}` : withdrawValue !== undefined ? `Withdraw $${fmtUsdc(withdrawValue)}` : 'Withdraw'}
            </button>
            {state.status === 'error' && <p className="text-sm text-down">{state.error}</p>}
          </div>
        </section>
      </div>
    </div>
  )
}
