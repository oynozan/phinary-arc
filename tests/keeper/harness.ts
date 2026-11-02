/**
 * Local-chain harness for the keeper: anvil + real contracts + scripts/keeper.ts as a subprocess.
 * Requires `forge build` (artifacts in contracts/out) and anvil on PATH or in ~/.foundry/bin.
 * Each Chain also runs one local HTTP server that proxies JSON-RPC to anvil (`rpcHook` injects faults)
 * and mocks the Kraken ticker and the Chainlink Data Streams API (checking its HMAC headers).
 * new Chain({ stocks: true }) adds the NVDA/AAPL feeds; new Chain({ network: 'mainnet' }) runs chain 5042 with
 * StreamsFeed contracts on a MockVerifierProxy, wired like contracts/script/DeployPhinary.s.sol.
 */
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc, arcTestnet } from 'viem/chains'
import { aggregatorAbi, marketAbi, oracleAbi, streamsFeedAbi } from '../../src/lib/abis'

export const ROOT = resolve(import.meta.dir, '../..')
export const USDC: Address = '0x3600000000000000000000000000000000000000'
export const KEYS = {
  keeper: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  alice: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  bob: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  pusher: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const satisfies Record<string, Hex>
export const PRODUCTS = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const
export const DEFAULT_PRICES: Record<string, string> = { 'BTC-USD': '67000', 'ETH-USD': '3500', 'SOL-USD': '150' }
export const ASSET_KEYS = ['BTC', 'ETH', 'SOL', 'NVDA', 'AAPL'] as const
/** Chainlink stream ids (the scripts/lib.ts defaults): v3 for crypto, v2 for the 24/7 equity streams. */
export const STREAM_IDS: Hex[] = [
  '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8',
  '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9',
  '0x0003b778d3f6b2ac4991302b89cb313f99a42467d6c9c5f96f57c29c0d2bc24f',
  '0x0002d9b165cfb7309e8a13af14cbbb608d9990f9fa094d2ac6199d2567f2dae8',
  '0x000231a949aa4e6a24b2c2005b16e27d03ed90e08888a2da3a68ebc9c50763df',
]
export const VOL = [
  ['0.30', '1.5', '0.55'],
  ['0.40', '2.0', '0.75'],
  ['0.50', '2.5', '0.95'],
  ['0.25', '1.5', '0.50'],
  ['0.15', '1.0', '0.30'],
] as const
export const STREAMS_KEY = 'test-api-key'
export const STREAMS_SECRET = 'test-api-secret-never-logged'
export type RpcMsg = { method: string; params?: unknown[] }

const FOUNDRY_BIN = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.foundry', 'bin')
const exe = (n: string) => {
  const p = join(FOUNDRY_BIN, process.platform === 'win32' ? `${n}.exe` : n)
  return existsSync(p) ? p : n
}

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(ROOT, 'contracts', 'out', file, `${name}.json`), 'utf8'))
  return { abi: j.abi, bytecode: j.bytecode.object }
}

export const erc20MintAbi = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const zero = `0x${'00'.repeat(32)}` as Hex
const head = [{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint192' }, { type: 'uint192' }, { type: 'uint32' }] as const

/** A real-layout unsigned full report (v3 for crypto, v2 for stocks) that MockVerifierProxy accepts. */
export function streamsFullReport(feedId: Hex, obs: number, price: bigint): Hex {
  const reportData = feedId.startsWith('0x0003')
    ? encodeAbiParameters([...head, { type: 'int192' }, { type: 'int192' }, { type: 'int192' }], [feedId, obs, obs, 0n, 0n, obs + 86_400, price, price - 1n, price + 1n])
    : encodeAbiParameters([...head, { type: 'int192' }], [feedId, obs, obs, 0n, 0n, obs + 86_400, price])
  return encodeAbiParameters(
    [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }],
    [[zero, zero, zero], reportData, [zero], [zero], zero],
  )
}

/**
 * Gas limit for an estimate. buy and sell poke the oracle, which writes an observation only once 60s passed since the
 * last one; when that moment falls between the estimate and the block, the exact estimate runs out of gas. Wallets add
 * headroom too.
 */
export const withHeadroom = (gas: bigint) => (gas * 5n) / 4n

export const phasedAbi = [
  ...aggregatorAbi,
  { type: 'function', name: 'newPhase', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

export class Chain {
  port = 8600 + Math.floor(Math.random() * 100)
  url = ''
  network: 'testnet' | 'mainnet'
  stocks: boolean
  proc?: ReturnType<typeof Bun.spawn>
  server?: ReturnType<typeof Bun.serve>
  /** Return a Response (or a promise of one) to answer or fail a JSON-RPC call instead of anvil. */
  rpcHook?: (msg: RpcMsg) => Response | undefined | Promise<Response | undefined>
  /** Kraken ticker per pair: best bid/ask strings, or an HTTP status to fail with. */
  kraken: Record<string, { bid: string; ask: string } | { status: number }> = {
    NVDAxUSD: { bid: '204.41', ask: '204.42' },
    AAPLxUSD: { bid: '343.29', ask: '343.31' },
  }
  /** Data Streams price per asset key (decimal string, encoded with 18 decimals). */
  streamPrices: Record<string, string> = { BTC: '67000', ETH: '3500', SOL: '150', NVDA: '204.415', AAPL: '343.30' }
  /** Price of the report observed at a given second, keyed `${key}@${timestamp}` (default: streamPrices). */
  streamPricesAt: Record<string, string> = {}
  /** Seconds the latest report lags chain time (a lagging API). */
  streamsLag = 0
  streamsRequests = { ok: 0, unauthorized: 0 }
  ctlPath: string
  ctl: { offsetMs: number; prices: Record<string, string>; status: Record<string, number>; speed: number }
  pub!: ReturnType<typeof createPublicClient>
  addrs!: { market: Address; oracle: Address; feeds: Address[]; deployBlock: bigint }
  keepers: KeeperProc[] = []

  constructor(opts: { network?: 'testnet' | 'mainnet'; stocks?: boolean } = {}) {
    this.network = opts.network ?? 'testnet'
    this.stocks = opts.stocks ?? this.network === 'mainnet'
    const dir = mkdtempSync(join(tmpdir(), 'keeper-harness-'))
    this.ctlPath = join(dir, 'ctl.json')
    this.ctl = { offsetMs: 0, prices: { ...DEFAULT_PRICES }, status: {}, speed: 10 }
    this.writeCtl()
  }

  get chain() {
    return this.network === 'mainnet' ? arc : arcTestnet
  }

  get serverUrl() {
    return `http://127.0.0.1:${this.server!.port}`
  }

  writeCtl() {
    const tmp = `${this.ctlPath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.ctl))
    renameSync(tmp, this.ctlPath)
  }

  setPrice(product: string, price: string) {
    this.ctl.prices[product] = price
    this.writeCtl()
  }

  async start() {
    this.server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (req) => this.serve(req) })
    for (let attempt = 0; attempt < 5; attempt++) {
      this.url = `http://127.0.0.1:${this.port}`
      this.proc = Bun.spawn([exe('anvil'), '--chain-id', String(this.chain.id), '--port', String(this.port), '--silent'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      this.pub = createPublicClient({ chain: this.chain, transport: http(this.url) })
      for (let i = 0; i < 60; i++) {
        try {
          await this.pub.getChainId()
          return
        } catch {
          await Bun.sleep(100)
        }
      }
      this.proc.kill()
      this.port = 8600 + Math.floor(Math.random() * 100)
    }
    throw new Error('anvil did not start')
  }

  wallet(key: Hex) {
    return createWalletClient({ account: privateKeyToAccount(key), chain: this.chain, transport: http(this.url) })
  }

  private async serve(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/rpc') {
      const body = await req.text()
      const hooked = this.rpcHook && (await this.rpcHook(JSON.parse(body) as RpcMsg))
      if (hooked) return hooked
      try {
        const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
        return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
      } catch {
        return new Response('anvil unreachable', { status: 502 }) // anvil stopped while a keeper was still calling
      }
    }
    if (url.pathname === '/0/public/Ticker') {
      const pair = url.searchParams.get('pair') ?? ''
      const t = this.kraken[pair]
      if (!t || url.searchParams.get('asset_class') !== 'tokenized_asset') return Response.json({ error: ['EQuery:Unknown asset pair'], result: {} })
      if ('status' in t) return new Response('stub error', { status: t.status })
      return Response.json({ error: [], result: { [pair]: { a: [t.ask, '2', '2.000'], b: [t.bid, '2', '2.000'], c: [t.bid, '0.5'] } } })
    }
    if (url.pathname === '/api/v1/reports/latest' || url.pathname === '/api/v1/reports') return this.streamsApi(req, url)
    return new Response('not found', { status: 404 })
  }

  /**
   * Mock Data Streams REST API: checks the HMAC headers as Chainlink documents them and returns a real-layout fullReport,
   * the latest one or (/api/v1/reports?timestamp=) the one observed at that second, 404 while it lies in the future.
   */
  private async streamsApi(req: Request, url: URL): Promise<Response> {
    const ts = Number(req.headers.get('X-Authorization-Timestamp'))
    const bodyHash = createHash('sha256').update('').digest('hex')
    const expected = createHmac('sha256', STREAMS_SECRET).update(`GET ${url.pathname}${url.search} ${bodyHash} ${STREAMS_KEY} ${ts}`).digest('hex')
    // the keeper's clock follows anvil time (preload offset), so skew is measured against that clock
    const skew = Math.abs(ts - (Date.now() + this.ctl.offsetMs))
    if (req.headers.get('Authorization') !== STREAMS_KEY || req.headers.get('X-Authorization-Signature-SHA256') !== expected || !(skew < 60_000)) {
      this.streamsRequests.unauthorized++
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    const feedId = (url.searchParams.get('feedID') ?? '').toLowerCase() as Hex
    const i = STREAM_IDS.indexOf(feedId)
    if (i < 0) return Response.json({ error: 'unknown feed' }, { status: 400 })
    this.streamsRequests.ok++
    // anvil time: the latest block, or the keeper clock when no block was mined for a while (it trails anvil by < 1s)
    const now = Math.max(Number((await this.pub.getBlock()).timestamp), Math.floor((Date.now() + this.ctl.offsetMs) / 1000))
    const at = url.searchParams.get('timestamp')
    const obs = at === null ? now - this.streamsLag : Number(at)
    if (obs > now) return Response.json({ error: 'not found' }, { status: 404 })
    const price = parseUnits(this.streamPricesAt[`${ASSET_KEYS[i]}@${obs}`] ?? this.streamPrices[ASSET_KEYS[i]], 18)
    const fullReport = streamsFullReport(feedId, obs, price)
    return Response.json({ report: { feedID: feedId, validFromTimestamp: obs, observationsTimestamp: obs, fullReport } })
  }

  async rpc(method: string, params: unknown[] = []) {
    // oxlint-disable-next-line typescript/no-explicit-any
    return (this.pub as any).request({ method, params })
  }

  async tx(key: Hex, req: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }) {
    const w = this.wallet(key)
    // oxlint-disable-next-line typescript/no-explicit-any
    const gas = await this.pub.estimateContractGas({ ...(req as any), account: w.account })
    // oxlint-disable-next-line typescript/no-explicit-any
    const hash = await w.writeContract({ ...(req as any), gas: withHeadroom(gas) })
    const r = await this.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })
    if (r.status !== 'success') {
      // replay at the parent block's state to name the revert
      // oxlint-disable-next-line typescript/no-explicit-any
      const why = await this.pub.simulateContract({ ...(req as any), account: w.account, blockNumber: r.blockNumber - 1n }).then(
        async () => ((await this.pub.getTransaction({ hash })).gas === r.gasUsed ? 'out of gas' : 'replay passed'),
        (e: Error) => e.message.split('\n').slice(0, 3).join(' '),
      )
      throw new Error(`reverted ${req.functionName}: ${why}`)
    }
    return r
  }

  async deploy(key: Hex, file: string, name: string, args: unknown[]): Promise<Address> {
    const { abi, bytecode } = artifact(file, name)
    const w = this.wallet(key)
    // oxlint-disable-next-line typescript/no-explicit-any
    const hash = await w.deployContract({ abi, bytecode, args } as any)
    const r = await this.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })
    if (!r.contractAddress) throw new Error(`deploy ${name} failed`)
    return r.contractAddress
  }

  /**
   * Testnet: 3 MockAggregators (5 with stocks), oracle, market (owner = keeper), etch 6-dec USDC at 0x3600.., mint.
   * Mainnet: 5 StreamsFeeds (18 decimals, 5s max report age like the deploy script) on a MockVerifierProxy, registered on the oracle
   * with the deploy script's settings, since mainnet setup.ts only verifies.
   */
  async deployAll() {
    const keeper = privateKeyToAccount(KEYS.keeper).address
    const tmpUsdc = await this.deploy(KEYS.keeper, 'KeeperHarnessMocks.sol', 'HarnessUSDC', [])
    const code = await this.pub.getCode({ address: tmpUsdc })
    await this.rpc('anvil_setCode', [USDC, code])
    const verifier = this.network === 'mainnet' ? await this.deploy(KEYS.keeper, 'MockVerifierProxy.sol', 'MockVerifierProxy', []) : undefined
    const feeds: Address[] = []
    for (const [i, k] of ASSET_KEYS.slice(0, this.stocks ? 5 : 3).entries()) {
      feeds.push(
        verifier
          ? await this.deploy(KEYS.keeper, 'StreamsFeed.sol', 'StreamsFeed', [verifier, STREAM_IDS[i], 18, `${k} / USD`, 5n])
          : await this.deploy(KEYS.keeper, 'MockAggregator.sol', 'MockAggregator', [keeper, 8, `${k} / USD`]),
      )
    }
    const oracle = await this.deploy(KEYS.keeper, 'PriceOracleAdapter.sol', 'PriceOracleAdapter', [keeper])
    const market = await this.deploy(KEYS.keeper, 'PredictionMarket.sol', 'PredictionMarket', [USDC, oracle, keeper])
    if (verifier) {
      for (const [i, f] of feeds.entries()) {
        const [min, max, def] = VOL[i].map((v) => parseUnits(v, 18))
        await this.tx(KEYS.keeper, { address: oracle, abi: oracleAbi, functionName: 'setFeed', args: [i, f, 600, min, max, def] })
      }
    }
    const deployBlock = await this.pub.getBlockNumber()
    this.addrs = { market, oracle, feeds, deployBlock }
    for (const k of Object.values(KEYS)) {
      const a = privateKeyToAccount(k).address
      await this.tx(KEYS.keeper, { address: USDC, abi: erc20MintAbi, functionName: 'mint', args: [a, parseUnits('100000', 6)] })
      if (k !== KEYS.keeper) {
        await this.tx(k, { address: USDC, abi: erc20MintAbi, functionName: 'approve', args: [market, 2n ** 255n] })
      }
    }
    // a second updater so the test can push rounds without racing the keeper's nonce (StreamsFeed is permissionless)
    const pusher = privateKeyToAccount(KEYS.pusher).address
    for (const f of verifier ? [] : feeds) {
      await this.tx(KEYS.keeper, { address: f, abi: [{ type: 'function', name: 'setUpdater', stateMutability: 'nonpayable', inputs: [{ name: 'u', type: 'address' }, { name: 'a', type: 'bool' }], outputs: [] }], functionName: 'setUpdater', args: [pusher, true] })
    }
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    const rpc: Record<string, string> =
      this.network === 'mainnet'
        ? { RPC_URL: `${this.serverUrl}/rpc` }
        : // lib.ts builds `${BASE}/api/rpc/Arc_Testnet?_rpc_token=..`; the '#' turns that suffix into a fragment.
          { RPC_URL: '', RPC_PROXY_BASE_URL: `${this.serverUrl}/rpc#`, RPC_PROXY_CHAINS: 'Arc_Testnet', RPC_PROXY_TOKEN: 'x' }
    return {
      ...(process.env as Record<string, string>),
      KH_CTL: this.ctlPath,
      NETWORK: this.network,
      ...rpc,
      KRAKEN_API_URL: this.serverUrl,
      STREAMS_API_URL: this.serverUrl,
      STREAMS_API_KEY: STREAMS_KEY,
      STREAMS_API_SECRET: STREAMS_SECRET,
      KEEPER_PRIVATE_KEY: KEYS.keeper,
      VITE_MARKET_ADDRESS: this.addrs.market,
      VITE_ORACLE_ADDRESS: this.addrs.oracle,
      ...Object.fromEntries(ASSET_KEYS.map((k, i) => [`VITE_FEED_${k}`, this.addrs.feeds[i] ?? ''])),
      VITE_DEPLOY_BLOCK: String(this.addrs.deployBlock),
      ...extra,
    }
  }

  /** Run a bun script (setup.ts) to completion with the preload. */
  async runScript(script: string, extra: Record<string, string> = {}) {
    const p = Bun.spawn([process.execPath, '--preload', join(ROOT, 'tests/keeper/preload.ts'), script], {
      cwd: ROOT,
      env: this.env(extra),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { out, err, code }
  }

  startKeeper(extra: Record<string, string> = {}) {
    const k = new KeeperProc(this, extra)
    this.keepers.push(k)
    return k
  }

  async chainTime(): Promise<number> {
    const b = await this.pub.getBlock()
    return Number(b.timestamp)
  }

  /** Advance anvil time and keep the keeper's clock aligned with it. */
  async advance(seconds: number) {
    await this.rpc('evm_increaseTime', [seconds])
    await this.rpc('evm_mine', [])
    await this.syncClock()
  }

  async syncClock() {
    const ts = await this.chainTime()
    this.ctl.offsetMs = ts * 1000 - Date.now()
    this.writeCtl()
  }

  async markets() {
    const count = (await this.pub.readContract({ address: this.addrs.market, abi: marketAbi, functionName: 'marketCount' })) as bigint
    if (count === 0n) return []
    const list = await this.pub.readContract({ address: this.addrs.market, abi: marketAbi, functionName: 'getMarketsRange', args: [1n, count] })
    return list.map((m, i) => ({ ...m, id: BigInt(i + 1) }))
  }

  async spot8(assetId: number) {
    const [p] = await this.pub.readContract({ address: this.addrs.oracle, abi: oracleAbi, functionName: 'getPrice', args: [assetId] })
    return p
  }

  async stop() {
    for (const k of this.keepers) k.stop()
    this.proc?.kill()
    await this.proc?.exited
    this.server?.stop(true)
  }
}

export class KeeperProc {
  lines: string[] = []
  proc: ReturnType<typeof Bun.spawn>
  constructor(chain: Chain, extra: Record<string, string>) {
    this.proc = Bun.spawn([process.execPath, '--preload', join(ROOT, 'tests/keeper/preload.ts'), 'scripts/keeper.ts'], {
      cwd: ROOT,
      env: chain.env(extra),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>)
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>)
  }
  private async pump(s: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of s) {
      buf += dec.decode(chunk)
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        this.lines.push(line)
        if (process.env.KH_VERBOSE) console.log(`  [keeper] ${line}`)
      }
    }
  }
  count(re: RegExp) {
    return this.lines.filter((l) => re.test(l)).length
  }
  async waitFor(re: RegExp, timeoutMs = 20_000, n = 1) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (this.count(re) >= n) return true
      await Bun.sleep(50)
    }
    return false
  }
  get exited() {
    return this.proc.exitCode !== null
  }
  stop() {
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
  }
}

export async function until(fn: () => Promise<boolean>, timeoutMs = 20_000, stepMs = 100) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn()) return true
    await Bun.sleep(stepMs)
  }
  return false
}

export { aggregatorAbi, marketAbi, oracleAbi, streamsFeedAbi }
