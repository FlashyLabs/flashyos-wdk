// EVM call → OperationRecord.
//
// The one piece of chain-specific knowledge in this package, and the piece
// most likely to hide an authorization bug: "what is the amount, and who is
// the payee" has to be re-derived from the *actual* call, not from what the
// agent said it was going to do. Anything this extractor does not recognise
// returns null, and null means refuse — an unrecognised call is not a
// permitted one.
//
// Recognised today:
//   - native transfer:   { to, value }                  with empty data
//   - ERC-20 transfer:   { to: <token>, data: a9059cbb… }  transfer(address,uint256)
//
// Deliberately not recognised: approve(), transferFrom(), arbitrary calldata,
// multicalls. Each of those is a separate authorization kind with its own
// threat surface and should be added with its own tests, not folded in here.

import { NATIVE_ASSET, type OperationRecord } from '../types';
import { sameAsset, sameDestination } from './address';

export interface EvmCall {
  to: string;
  /** Wei, as a decimal or hex string. Missing means 0. */
  value?: string | bigint;
  /** Calldata, hex. Missing or "0x" means a plain value transfer. */
  data?: string;
}

const ERC20_TRANSFER_SELECTOR = 'a9059cbb';
/**
 * Safe Allowance Module `executeAllowanceTransfer(address safe, address token,
 * address to, uint96 amount, address paymentToken, uint96 payment, address
 * delegate, bytes signature)`. A transfer *through* an on-chain limit: the
 * Safe pays `to` `amount` of `token`, and the module reverts if the
 * delegate's allowance does not cover it. Recognised so the signer can vouch
 * for the call as the transfer it is; refused when it also carries a
 * payment, since that is a second transfer the record could not express.
 */
export const ALLOWANCE_TRANSFER_SELECTOR = '4515641a';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function toBigInt(value: string | bigint | undefined): bigint | null {
  if (value === undefined) return 0n;
  if (typeof value === 'bigint') return value < 0n ? null : value;
  try {
    const n = BigInt(value);
    return n < 0n ? null : n;
  } catch {
    return null;
  }
}

function word(hex: string, index: number): string | null {
  const start = index * 64;
  const w = hex.slice(start, start + 64);
  return w.length === 64 ? w : null;
}

/**
 * Returns the OperationRecord an EVM call actually performs, or null when the
 * call is not one this extractor can vouch for.
 */
export function extractEvmOperation(chainId: string | number, call: EvmCall): OperationRecord | null {
  if (!ADDRESS_RE.test(call.to)) return null;
  const chain = `evm:${chainId}`;
  const data = (call.data ?? '0x').toLowerCase();
  const value = toBigInt(call.value);
  if (value === null) return null;

  if (data === '0x' || data === '') {
    return {
      kind: 'transfer',
      chain,
      asset: NATIVE_ASSET,
      amount: value.toString(),
      destination: call.to.toLowerCase(),
    };
  }

  if (!data.startsWith('0x')) return null;
  const body = data.slice(2);
  const selector = body.slice(0, 8);

  if (selector === ERC20_TRANSFER_SELECTOR) {
    // A token transfer that also sends native value is not a shape we
    // understand; refuse rather than guess which of the two is "the amount".
    if (value !== 0n) return null;
    const args = body.slice(8);
    if (args.length !== 128) return null;
    const toWord = word(args, 0);
    const amountWord = word(args, 1);
    if (!toWord || !amountWord) return null;
    // An address is 20 bytes right-aligned in a 32-byte word; the 12 leading
    // bytes must be zero or the word is not an address.
    if (!/^0{24}[0-9a-f]{40}$/.test(toWord)) return null;
    return {
      kind: 'transfer',
      chain,
      asset: call.to.toLowerCase(),
      amount: BigInt(`0x${amountWord}`).toString(),
      destination: `0x${toWord.slice(24)}`,
    };
  }

  if (selector === ALLOWANCE_TRANSFER_SELECTOR) {
    if (value !== 0n) return null;
    const args = body.slice(8);
    // 7 static words, then the dynamic `bytes signature` (offset word + length + data).
    if (args.length < 8 * 64) return null;
    const addr = (i: number) => {
      const w = word(args, i);
      return w && /^0{24}[0-9a-f]{40}$/.test(w) ? `0x${w.slice(24)}` : null;
    };
    const token = addr(1);
    const to = addr(2);
    const amountWord = word(args, 3);
    const paymentToken = addr(4);
    const paymentWord = word(args, 5);
    if (!addr(0) || !token || !to || !amountWord || !paymentToken || !paymentWord || !addr(6)) return null;
    // A payment to the executor is a second transfer; one record cannot vouch for two.
    if (paymentToken !== ZERO_ADDRESS || BigInt(`0x${paymentWord}`) !== 0n) return null;
    return {
      kind: 'transfer',
      chain,
      asset: token,
      amount: BigInt(`0x${amountWord}`).toString(),
      destination: to,
      raw: { via: 'safe-allowance-module', module: call.to.toLowerCase(), safe: addr(0)!, delegate: addr(6)! },
    };
  }

  return null;
}

/**
 * True when two records describe the same operation within an authorized
 * ceiling. Addresses compare by the chain family's rule (address.ts): EVM
 * case-insensitively, TRON exactly; a bridge destination compares its target
 * chain exactly and its recipient by the target's rule.
 */
export function recordWithinAuthorization(
  record: OperationRecord,
  authorization: { chain: string; kind: string; asset: string; destination: string | null; maxAmount: string },
): boolean {
  return (
    record.chain === authorization.chain &&
    record.kind === authorization.kind &&
    sameAsset(record.chain, record.asset, authorization.asset) &&
    sameDestination(record.chain, record.destination, authorization.destination) &&
    BigInt(record.amount) <= BigInt(authorization.maxAmount)
  );
}
