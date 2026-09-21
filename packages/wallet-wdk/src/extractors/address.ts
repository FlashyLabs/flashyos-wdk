// Address rules per chain family. The plane, the adapter and the signer all
// compare addresses; they must agree on when two spellings are the same
// address, or an allowlist entry could fail to match — or worse, match what
// it should not.
//
//   evm   0x + 40 hex, case-insensitive (EIP-55 is a checksum, not identity)
//   tron  base58check, T + 33 chars, case-SENSITIVE — never lowercase these
//
// A family not listed here is not one this package vouches for: isAddress
// returns false, and false means refuse.

export type Family = 'evm' | 'tron';

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const CHAIN_RE = /^(evm|tron|ton|solana|btc):[A-Za-z0-9_-]+$/;

export function familyOf(chain: string): string | null {
  const m = CHAIN_RE.exec(chain);
  return m ? m[1] : null;
}

export function isChain(chain: string): boolean {
  return CHAIN_RE.test(chain);
}

export function isAddress(family: string, address: unknown): address is string {
  if (typeof address !== 'string') return false;
  if (family === 'evm') return EVM_RE.test(address);
  if (family === 'tron') return TRON_RE.test(address);
  return false;
}

/** The canonical spelling for comparison and storage. Only EVM addresses are case-folded. */
export function normalizeAddress(family: string, address: string): string {
  return family === 'evm' ? address.toLowerCase() : address;
}

/**
 * A bridge's destination binds the target chain and the recipient together
 * as `<targetChain>:<recipient>` — e.g. `evm:42161:0xabc…` or
 * `tron:mainnet:T…` — so the signed authorization covers both, and an
 * allowlist entry names a place, not just an address.
 */
export function bridgeDestination(targetChain: string, recipient: string): string | null {
  const family = familyOf(targetChain);
  if (!family || !isAddress(family, recipient)) return null;
  return `${targetChain}:${normalizeAddress(family, recipient)}`;
}

export function parseBridgeDestination(destination: string): { targetChain: string; recipient: string } | null {
  const at = destination.lastIndexOf(':');
  if (at <= 0) return null;
  const targetChain = destination.slice(0, at);
  const recipient = destination.slice(at + 1);
  const family = familyOf(targetChain);
  if (!family || !isAddress(family, recipient)) return null;
  return { targetChain, recipient };
}

/**
 * True when two destinations name the same place on `chain`. Plain addresses
 * compare by the chain's family rule; bridge destinations compare target
 * chain exactly and recipient by the *target's* family rule.
 */
export function sameDestination(chain: string, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const pa = parseBridgeDestination(a);
  const pb = parseBridgeDestination(b);
  if (pa || pb) {
    if (!pa || !pb || pa.targetChain !== pb.targetChain) return false;
    const family = familyOf(pa.targetChain) ?? '';
    return normalizeAddress(family, pa.recipient) === normalizeAddress(family, pb.recipient);
  }
  const family = familyOf(chain) ?? '';
  return normalizeAddress(family, a) === normalizeAddress(family, b);
}

/** Assets: `native`, or an address by the chain's family rule. */
export function sameAsset(chain: string, a: string, b: string): boolean {
  const family = familyOf(chain) ?? '';
  return normalizeAddress(family, a) === normalizeAddress(family, b);
}
