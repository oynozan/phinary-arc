import { sha256, toBytes } from 'viem'

/**
 * Address-based Gravatar identicon. Gravatar hashes an identifier with SHA-256;
 * we hash the lowercase wallet address (public onchain data) and force the identicon
 * style, so no email is ever involved.
 */
export function gravatarUrl(address: string, size = 64): string {
  const hash = sha256(toBytes(address.toLowerCase()), 'hex').slice(2)
  return `https://gravatar.com/avatar/${hash}?d=identicon&f=y&s=${size}`
}
