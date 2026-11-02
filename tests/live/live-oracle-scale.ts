// Live: useRealtimeSync writes PriceSet(answer, timestamp) into the oracle cache as answer * 1e10.
// Run: bun run tests/live/live-oracle-scale.ts
// Compare with what useOracleSpot reads from the adapter (oracle.getPrice) for each asset.
import { createPublicClient, http } from 'viem'
import { arcTestnet } from 'viem/chains'
import { aggregatorAbi, oracleAbi } from '../../src/lib/abis'

const ORACLE = '0x465ec9f24ad95cdb73c72b2de1ccb0ac827723e3' as const
const FEEDS = ['0x83eec3cbda541e441ff5f919fa47faefb20678ae', '0xc7e7bcd1e9a28cecb58dad6a4459b9f81db4c970', '0x4395f10c126fbfb0b3b229648ceeba4bd7fca004'] as const
const c = createPublicClient({ chain: arcTestnet, transport: http('https://rpc.testnet.arc.io') })
for (const [assetId, feed] of FEEDS.entries()) {
  const [price, updatedAt] = await c.readContract({ address: ORACLE, abi: oracleAbi, functionName: 'getPrice', args: [assetId] })
  const decimals = await c.readContract({ address: feed, abi: aggregatorAbi, functionName: 'decimals' })
  const r = await c.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' })
  const pushed = r[1] * 10n ** 10n
  console.log({ assetId, feedDecimals: decimals, adapterPrice: price, cacheFromPriceSet: pushed, equal: pushed === price, adapterUpdatedAt: updatedAt, feedUpdatedAt: r[3] })
}
