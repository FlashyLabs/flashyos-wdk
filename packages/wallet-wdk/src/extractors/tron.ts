// TRON call → OperationRecord.
//
// USD₮ on TRON is the volume rail, and the shapes a TRON wallet account
// takes at the WDK boundary are the ones @tetherto/wdk-wallet defines for
// every account: `sendTransaction({ to, value })` for the native coin and
// `transfer({ token, recipient, amount })` for a token — TRC-20 here.
// Addresses are base58check and case-sensitive; see address.ts.
//
// Not recognised, deliberately: raw `triggerSmartContract` payloads, energy
// or bandwidth delegation, freezing/staking, multi-sig. Each would be its
// own kind with its own tests.

import { NATIVE_ASSET, type OperationRecord } from '../types';
import { isAddress } from './address';

export type TronCall =
  | { to: string; value: string | bigint | number; token?: undefined }
  | { token: string; recipient: string; amount: string | bigint | number; to?: undefined };

function toAmount(value: string | bigint | number | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? String(value) : null;
  try {
    const n = BigInt(value);
    return n < 0n ? null : n.toString();
  } catch {
    return null;
  }
}

export function extractTronOperation(chainId: string, call: TronCall): OperationRecord | null {
  if (!call || typeof call !== 'object' || !chainId) return null;
  const chain = `tron:${chainId}`;
  if ('token' in call && call.token !== undefined) {
    if (!isAddress('tron', call.token) || !isAddress('tron', call.recipient)) return null;
    const amount = toAmount(call.amount);
    if (amount === null) return null;
    return { kind: 'transfer', chain, asset: call.token, amount, destination: call.recipient };
  }
  if ('to' in call && call.to !== undefined) {
    if (!isAddress('tron', call.to)) return null;
    const amount = toAmount(call.value);
    if (amount === null) return null;
    return { kind: 'transfer', chain, asset: NATIVE_ASSET, amount, destination: call.to };
  }
  return null;
}
