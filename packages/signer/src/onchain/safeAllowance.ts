// The third line: an on-chain limit the account contract enforces.
//
// WDK's ERC-4337 module has no session keys or spending limits (Phase 6),
// so the limit that holds when the plane *and* the signer are wrong has to
// come from a Safe module. The Safe Allowance Module
// (safe-fndn/safe-modules, modules/allowances) is the smallest one that
// does exactly this: a Safe's owners set, per delegate and per token, an
// amount and an optional reset window; the delegate spends through
// `executeAllowanceTransfer`, and the module reverts anything over.
//
// This file does three things and no more:
//   1. reads the allowance the chain currently holds (eth_call, no library);
//   2. checks a re-derived transfer record against it, as a pre-flight the
//      signer can refuse on — a *read* of the chain's rule, not a copy of it;
//   3. builds the calldata for `executeAllowanceTransfer`, which the EVM
//      extractor recognises as the transfer it is.
// The enforcement is the module's revert. Nothing here pretends otherwise.
//
// Verified against the contract source (AllowanceModule.sol, main,
// 2026-09-20): getTokenAllowance returns [amount, spent, resetTimeMin,
// lastResetMin, nonce]; resetTimeMin 0 means no automatic reset.

import type { OperationRecord } from '@flashyos/wallet-wdk';

export const SELECTORS = {
  getTokenAllowance: '0x94b31fbd', // getTokenAllowance(address,address,address)
  executeAllowanceTransfer: '0x4515641a', // executeAllowanceTransfer(address,address,address,uint96,address,uint96,address,bytes)
  generateTransferHash: '0xd626e043', // generateTransferHash(address,address,address,uint96,address,uint96,uint16)
} as const;

export interface Allowance {
  amount: bigint;
  spent: bigint;
  resetTimeMin: number;
  lastResetMin: number;
  nonce: number;
}

export interface SafeAllowanceOptions {
  rpcUrl: string;
  /** The deployed AllowanceModule on this chain. Look it up in safe-modules' deployments; never guess. */
  moduleAddress: string;
  /** The Safe that holds the funds. */
  safeAddress: string;
  /** The delegate the Safe's owners added — the address the signer's WDK account derives. */
  delegateAddress: string;
  fetch?: typeof fetch;
  /** Minutes since the epoch, for the reset window. Injectable for tests. */
  nowMinutes?: () => number;
}

export type OnChainCheck = { ok: true; remaining: bigint; allowance: Allowance } | { ok: false; code: 'ONCHAIN_LIMIT' | 'ONCHAIN_UNKNOWN_ASSET'; reason: string; allowance: Allowance | null };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');

export class SafeAllowanceLimit {
  private readonly fetchImpl: typeof fetch;
  private readonly nowMinutes: () => number;
  private nextId = 1;

  constructor(private readonly options: SafeAllowanceOptions) {
    for (const [k, v] of Object.entries({ moduleAddress: options.moduleAddress, safeAddress: options.safeAddress, delegateAddress: options.delegateAddress })) {
      if (!ADDRESS_RE.test(v)) throw new Error(`SafeAllowanceLimit: ${k} is not an address`);
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.nowMinutes = options.nowMinutes ?? (() => Math.floor(Date.now() / 60_000));
  }

  private async ethCall(to: string, data: string): Promise<string> {
    const res = await this.fetchImpl(this.options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    if (!res.ok) throw new Error(`eth_call: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (body.error || typeof body.result !== 'string') throw new Error(`eth_call: ${body.error?.message ?? 'no result'}`);
    return body.result;
  }

  /** What the chain currently holds for this delegate and token. */
  async allowance(token: string): Promise<Allowance> {
    const data = SELECTORS.getTokenAllowance + pad(this.options.safeAddress) + pad(this.options.delegateAddress) + pad(token);
    const result = (await this.ethCall(this.options.moduleAddress, data)).replace(/^0x/, '');
    if (result.length < 5 * 64) throw new Error('getTokenAllowance: short response');
    const w = (i: number) => BigInt(`0x${result.slice(i * 64, (i + 1) * 64)}`);
    return { amount: w(0), spent: w(1), resetTimeMin: Number(w(2)), lastResetMin: Number(w(3)), nonce: Number(w(4)) };
  }

  /** The module's own arithmetic: spent resets to 0 once a reset window has elapsed. */
  static remaining(a: Allowance, nowMinutes: number): bigint {
    const spent = a.resetTimeMin > 0 && nowMinutes - a.lastResetMin >= a.resetTimeMin ? 0n : a.spent;
    const left = a.amount - spent;
    return left < 0n ? 0n : left;
  }

  /**
   * Pre-flight for a transfer record. A refusal here is what the module
   * would do on chain, read in advance; a pass here is not a guarantee —
   * the module decides at execution, and the signer treats a revert as a
   * revert.
   */
  async check(record: OperationRecord): Promise<OnChainCheck> {
    if (record.kind !== 'transfer' || record.asset === 'native') {
      return { ok: false, code: 'ONCHAIN_UNKNOWN_ASSET', reason: 'the allowance module governs ERC-20 transfers only', allowance: null };
    }
    const allowance = await this.allowance(record.asset);
    const remaining = SafeAllowanceLimit.remaining(allowance, this.nowMinutes());
    if (allowance.amount === 0n) {
      return { ok: false, code: 'ONCHAIN_LIMIT', reason: `no on-chain allowance for ${this.options.delegateAddress} on ${record.asset}`, allowance };
    }
    if (BigInt(record.amount) > remaining) {
      return { ok: false, code: 'ONCHAIN_LIMIT', reason: `${record.amount} exceeds the on-chain allowance remaining (${remaining} of ${allowance.amount})`, allowance };
    }
    return { ok: true, remaining, allowance };
  }

  /**
   * The call that performs the transfer through the module. The `signature`
   * is the delegate's over `generateTransferHash(...)` (the module's own
   * EIP-712 hash); `to` is the module. The EVM extractor re-derives this
   * calldata as the transfer it is, so the signer vouches for it like any
   * ERC-20 transfer, and the chain enforces the limit underneath.
   */
  transferCall(record: OperationRecord, signature: string): { to: string; value: string; data: string } {
    if (record.kind !== 'transfer' || record.asset === 'native' || !record.destination) throw new Error('transferCall: an ERC-20 transfer record is required');
    const sig = signature.replace(/^0x/, '').toLowerCase();
    if (sig.length === 0 || sig.length % 2 !== 0) throw new Error('transferCall: signature must be hex bytes');
    const sigWords = Math.ceil(sig.length / 64);
    const data =
      SELECTORS.executeAllowanceTransfer +
      pad(this.options.safeAddress) +
      pad(record.asset) +
      pad(record.destination) +
      uint(BigInt(record.amount)) +
      pad('0x0000000000000000000000000000000000000000') +
      uint(0) +
      pad(this.options.delegateAddress) +
      uint(8 * 32) + // offset of the bytes argument
      uint(sig.length / 2) +
      sig.padEnd(sigWords * 64, '0');
    return { to: this.options.moduleAddress, value: '0', data };
  }

  /** The hash the delegate signs, as the module computes it — read from the chain so the nonce is the module's. */
  async transferHash(record: OperationRecord): Promise<{ hash: string; nonce: number }> {
    if (record.kind !== 'transfer' || record.asset === 'native' || !record.destination) throw new Error('transferHash: an ERC-20 transfer record is required');
    const { nonce } = await this.allowance(record.asset);
    const data =
      SELECTORS.generateTransferHash + pad(this.options.safeAddress) + pad(record.asset) + pad(record.destination) + uint(BigInt(record.amount)) +
      pad('0x0000000000000000000000000000000000000000') + uint(0) + uint(nonce);
    return { hash: await this.ethCall(this.options.moduleAddress, data), nonce };
  }
}
