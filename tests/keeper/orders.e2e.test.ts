/**
 * Keeper end-to-end on anvil: stop-loss / take-profit tracking from OrderSet/OrderCancelled/OrderExecuted logs.
 * Run: bun test tests/keeper/orders.e2e.test.ts   (needs `forge build` first)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { encodeFunctionData, parseUnits, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain, KEYS, aggregatorAbi, marketAbi, oracleAbi, until, withHeadroom } from './harness'

const alice = privateKeyToAccount(KEYS.alice).address
const UNITS = parseUnits('10', 6)

async function marketFor(chain: Chain, assetId: number, dur: bigint) {
  const ms = await chain.markets()
  return ms.filter((m) => m.status === 0 && m.assetId === assetId && BigInt(m.expiry) - BigInt(m.createdAt) === dur).at(-1)!
}

/** Send several of alice's market calls so they all land in ONE block (automine paused). */
async function inOneBlock(chain: Chain, calls: { functionName: string; args: readonly unknown[] }[]) {
  await chain.rpc('evm_setAutomine', [false])
  try {
    const w = chain.wallet(KEYS.alice)
    let nonce = await chain.pub.getTransactionCount({ address: alice, blockTag: 'pending' })
    const hashes: Hex[] = []
    for (const c of calls) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const data = encodeFunctionData({ abi: marketAbi, functionName: c.functionName as any, args: c.args as any })
      hashes.push(await w.sendTransaction({ to: chain.addrs.market, data, gas: 600_000n, nonce: nonce++ }))
    }
    await chain.rpc('evm_mine', [])
    const blocks = new Set<bigint>()
    for (const h of hashes) {
      const r = await chain.pub.waitForTransactionReceipt({ hash: h, pollingInterval: 50 })
      expect(r.status).toBe('success')
      blocks.add(r.blockNumber)
    }
    expect(blocks.size).toBe(1)
  } finally {
    await chain.rpc('evm_setAutomine', [true])
  }
}

async function position(chain: Chain, id: bigint) {
  return chain.pub.readContract({ address: chain.addrs.market, abi: marketAbi, functionName: 'getPosition', args: [id, alice] })
}
async function order(chain: Chain, id: bigint, isUp: boolean) {
  return chain.pub.readContract({ address: chain.addrs.market, abi: marketAbi, functionName: 'getOrder', args: [id, alice, isUp] })
}
const pct = (x: bigint, bps: bigint) => (x * bps) / 10_000n

describe('keeper SL/TP order tracking', () => {
  const chain = new Chain()
  beforeAll(async () => {
    await chain.start()
    await chain.deployAll()
    const s = await chain.runScript('scripts/setup.ts')
    if (s.code !== 0) throw new Error(`setup failed: ${s.err}`)
    chain.startKeeper()
    if (!(await until(async () => (await chain.markets()).length >= 9, 30_000))) throw new Error('no markets')
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  test('control: a plain OrderSet stop-loss is executed when the oracle crosses it', async () => {
    const m = await marketFor(chain, 2, 900n) // SOL
    const spot = await chain.spot8(2)
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'buy', args: [m.id, true, UNITS, UNITS] })
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'setOrder', args: [m.id, true, spot - pct(spot, 50n), 0n] })
    chain.setPrice('SOL-USD', '148') // -1.33%
    expect(await until(async () => (await position(chain, m.id))[0] === 0n, 20_000)).toBe(true)
  }, 60_000)

  test('regression: order re-set after cancel in the same block is executed (Set->Cancel->Set)', async () => {
    const m = await marketFor(chain, 0, 900n) // BTC
    const spot = await chain.spot8(0)
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'buy', args: [m.id, true, UNITS, UNITS] })
    // user edits their stop: cancel the old order and place a new one (PositionPanel offers both actions)
    await inOneBlock(chain, [
      { functionName: 'setOrder', args: [m.id, true, spot - pct(spot, 100n), 0n] },
      { functionName: 'cancelOrder', args: [m.id, true] },
      { functionName: 'setOrder', args: [m.id, true, spot - pct(spot, 50n), 0n] },
    ])
    const o = await order(chain, m.id, true)
    expect(o.stopPrice).toBe(spot - pct(spot, 50n)) // the order is live onchain
    await Bun.sleep(1500) // let the keeper scan that block
    chain.setPrice('BTC-USD', '66000') // -1.49%, crosses the live stop
    expect(await until(async () => (await position(chain, m.id))[0] === 0n, 15_000)).toBe(true)
  }, 60_000)

  test('regression: order set again after sell-all + re-buy in the same block is executed', async () => {
    const m = await marketFor(chain, 1, 900n) // ETH
    const spot = await chain.spot8(1)
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'buy', args: [m.id, true, UNITS, UNITS] })
    await inOneBlock(chain, [
      { functionName: 'setOrder', args: [m.id, true, spot - pct(spot, 100n), 0n] },
      { functionName: 'sell', args: [m.id, true, UNITS, 0n] }, // full sell auto-cancels -> OrderCancelled
      { functionName: 'buy', args: [m.id, true, UNITS, UNITS] },
      { functionName: 'setOrder', args: [m.id, true, spot - pct(spot, 50n), 0n] },
    ])
    expect((await order(chain, m.id, true)).stopPrice).toBe(spot - pct(spot, 50n))
    await Bun.sleep(1500)
    chain.setPrice('ETH-USD', '3450') // -1.43%
    expect(await until(async () => (await position(chain, m.id))[0] === 0n, 15_000)).toBe(true)
  }, 60_000)

  test('control: orders placed while the keeper was down are found by the startup lookback', async () => {
    chain.keepers[0].stop()
    await Bun.sleep(300)
    const m = await marketFor(chain, 0, 3600n) // BTC 1h
    const spot = await chain.spot8(0)
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'buy', args: [m.id, true, UNITS, UNITS] })
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'setOrder', args: [m.id, true, spot - pct(spot, 50n), 0n] })
    const k = chain.startKeeper()
    expect(await k.waitFor(/order scan starts/, 20_000)).toBe(true)
    chain.setPrice('BTC-USD', '65000')
    expect(await until(async () => (await position(chain, m.id))[0] === 0n, 20_000)).toBe(true)
  }, 60_000)

  test('regression: after a keeper restart, an order edited via cancel + set in separate blocks is executed', async () => {
    chain.keepers.at(-1)!.stop()
    await Bun.sleep(300)
    const m = await marketFor(chain, 2, 3600n) // SOL 1h
    const spot = await chain.spot8(2)
    const tx = (functionName: string, args: readonly unknown[]) =>
      chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName, args })
    await tx('buy', [m.id, true, UNITS, UNITS])
    await tx('setOrder', [m.id, true, spot - pct(spot, 100n), 0n]) // block N
    await tx('cancelOrder', [m.id, true]) //                           block N+1
    await tx('setOrder', [m.id, true, spot - pct(spot, 50n), 0n]) //  block N+2 (live order)
    const k = chain.startKeeper()
    expect(await k.waitFor(/order scan starts/, 20_000)).toBe(true)
    chain.setPrice('SOL-USD', '145')
    expect(await until(async () => (await position(chain, m.id))[0] === 0n, 15_000)).toBe(true)
  }, 60_000)

  test('regression: after a restart, orders older than 20k blocks are executed (long durations, scan from the deploy block)', async () => {
    chain.keepers.at(-1)!.stop()
    await Bun.sleep(300)
    // owner enables a 1-day duration (setDurationAllowed is a supported admin knob)
    await chain.tx(KEYS.keeper, { address: chain.addrs.market, abi: marketAbi, functionName: 'setDurationAllowed', args: [86_400, true] })
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'createMarket', args: [0, 0n, 86_400] })
    const m = await marketFor(chain, 0, 86_400n)
    const spot = await chain.spot8(0)
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'buy', args: [m.id, true, UNITS, UNITS] })
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'setOrder', args: [m.id, true, spot - pct(spot, 50n), 0n] })
    // 20,001 blocks at 0.5s (Arc's measured block time) = ~2.8h; the 1-day market is still open
    await chain.rpc('anvil_mine', ['0x4e21', '0x0'])
    await chain.advance(10_000)
    const k = chain.startKeeper()
    expect(await k.waitFor(/order scan starts/, 20_000)).toBe(true)
    chain.setPrice('BTC-USD', '64000')
    await until(async () => (await chain.spot8(0).catch(() => 0n)) === 64000n * 10n ** 18n, 15_000) // stale until the keeper pushes
    const live = await order(chain, m.id, true)
    expect(live.stopPrice).toBeGreaterThan(0n) // still live onchain and triggered
    expect(await until(async () => (await position(chain, m.id))[0] === 0n, 20_000)).toBe(true)
  }, 120_000)
})

describe('harness', () => {
  const chain = new Chain()
  beforeAll(async () => {
    await chain.start()
    await chain.deployAll()
    const s = await chain.runScript('scripts/setup.ts')
    if (s.code !== 0) throw new Error(`setup failed: ${s.err}`)
  }, 120_000)
  afterAll(async () => {
    await chain.stop()
  })

  // Suspected cause of the flaky 20k-blocks test ("reverted buy: replay passed"): buy's embedded poke writes an observation
  // only once 60s passed since the last one. If that moment falls between the gas estimate and the block, the exact
  // estimate runs out of gas, while the replay at the parent block skips the write and passes. Chain.tx adds headroom.
  test('regression: a buy estimated before the oracle observation interval and mined after it lands with headroom', async () => {
    await chain.tx(KEYS.keeper, { address: chain.addrs.market, abi: marketAbi, functionName: 'setDurationAllowed', args: [86_400, true] })
    await chain.tx(KEYS.alice, { address: chain.addrs.market, abi: marketAbi, functionName: 'createMarket', args: [0, 0n, 86_400] })
    const m = (await chain.markets()).at(-1)!
    await chain.tx(KEYS.pusher, { address: chain.addrs.feeds[0], abi: aggregatorAbi, functionName: 'setPrice', args: [67_000n * 10n ** 8n] })
    await chain.tx(KEYS.pusher, { address: chain.addrs.oracle, abi: oracleAbi, functionName: 'poke', args: [0] })
    const t0 = await chain.chainTime()
    await chain.rpc('evm_setNextBlockTimestamp', [t0 + 30])
    await chain.tx(KEYS.pusher, { address: chain.addrs.feeds[0], abi: aggregatorAbi, functionName: 'setPrice', args: [67_010n * 10n ** 8n] })
    await chain.rpc('evm_setNextBlockTimestamp', [t0 + 59])
    await chain.rpc('evm_mine', [])
    const data = encodeFunctionData({ abi: marketAbi, functionName: 'buy', args: [m.id, true, UNITS, UNITS] })
    const gas = await chain.pub.estimateGas({ account: alice, to: chain.addrs.market, data }) // at t0 + 59: no observation yet
    const w = chain.wallet(KEYS.alice)
    const send = async (limit: bigint, at: number) => {
      await chain.rpc('evm_setNextBlockTimestamp', [at])
      return chain.pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: chain.addrs.market, data, gas: limit }), pollingInterval: 50 })
    }
    const exact = await send(gas, t0 + 60)
    expect([exact.status, exact.gasUsed]).toEqual(['reverted', gas]) // out of gas
    const r = await send(withHeadroom(gas), t0 + 61)
    expect(r.status).toBe('success')
    const obs = await chain.pub.getContractEvents({ address: chain.addrs.oracle, abi: oracleAbi, eventName: 'ObservationRecorded', blockHash: r.blockHash })
    expect(obs.length).toBe(1) // the poke inside the buy did record
    expect((await position(chain, m.id))[0]).toBe(UNITS)
  }, 60_000)
})
