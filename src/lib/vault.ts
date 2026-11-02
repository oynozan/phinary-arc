/** While markets are open the contract only allows a withdrawal that leaves one display share (1e9 units) in supply. */
export const MIN_SUPPLY_WHILE_OPEN = 10n ** 9n

/** Shares a withdrawal can burn: the wallet's own, and while markets are open never the vault's last share. */
export function maxWithdrawShares(shares: bigint, totalShares: bigint, exposed: boolean): bigint {
  if (!exposed) return shares
  const room = totalShares > MIN_SUPPLY_WHILE_OPEN ? totalShares - MIN_SUPPLY_WHILE_OPEN : 0n
  return shares < room ? shares : room
}
