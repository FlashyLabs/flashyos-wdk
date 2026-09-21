// Swap and bridge calls → OperationRecord.
//
// WDK executes swaps and bridges through protocol objects, not raw
// transactions: `account.getSwapProtocol(label).swap(options)` and
// `account.getBridgeProtocol(label).bridge(options)`. The options are what
// the signer can see, so the options are what it re-derives from. Shapes
// follow @tetherto/wdk-wallet's SwapOptions and BridgeOptions exactly
// (verified in the installed package's type declarations, 2026-09-19).
//
// A swap is authorized as "spend up to N of tokenIn". WDK's SwapBuyOptions —
// "obtain M of tokenOut, spend whatever that costs" — has no bounded input,
// so it is refused here: the signer cannot vouch for an amount it cannot
// read. Callers quote first and submit the sell side.

import { NATIVE_ASSET, type OperationRecord } from '../types';
import { bridgeDestination, familyOf, isAddress, isChain, normalizeAddress } from './address';

export interface SwapCall {
  protocol: 'swap';
  options: {
    tokenIn: string;
    tokenOut: string;
    /** Recipient of tokenOut. Omitted means the account itself. */
    to?: string;
    tokenInAmount?: string | bigint | number;
    tokenOutAmount?: string | bigint | number;
    minAmountOut?: string | bigint | number;
  };
}

export interface BridgeCall {
  protocol: 'bridge';
  options: {
    targetChain: string;
    recipient: string;
    token: string;
    amount: string | bigint | number;
  };
}

export type ProtocolCall = SwapCall | BridgeCall;

export function isProtocolCall(call: unknown): call is ProtocolCall {
  return Boolean(call) && typeof call === 'object' && ((call as ProtocolCall).protocol === 'swap' || (call as ProtocolCall).protocol === 'bridge') && typeof (call as ProtocolCall).options === 'object';
}

function amountOf(value: string | bigint | number | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) return null;
    return String(value);
  }
  try {
    const n = BigInt(value);
    return n < 0n ? null : n.toString();
  } catch {
    return null;
  }
}

function assetOf(family: string, token: unknown): string | null {
  if (token === NATIVE_ASSET) return NATIVE_ASSET;
  return isAddress(family, token) ? normalizeAddress(family, token) : null;
}

export function extractSwap(chain: string, call: SwapCall): OperationRecord | null {
  const family = familyOf(chain);
  if (!family || call.protocol !== 'swap' || !call.options) return null;
  const { tokenIn, tokenOut, to, tokenInAmount, tokenOutAmount } = call.options;
  const asset = assetOf(family, tokenIn);
  if (!asset || !assetOf(family, tokenOut)) return null;
  if (tokenOutAmount !== undefined && tokenInAmount === undefined) return null; // buy side: unbounded spend
  const amount = amountOf(tokenInAmount);
  if (amount === null) return null;
  let destination: string | null = null;
  if (to !== undefined) {
    if (!isAddress(family, to)) return null;
    destination = normalizeAddress(family, to);
  }
  return { kind: 'swap', chain, asset, amount, destination };
}

export function extractBridge(chain: string, call: BridgeCall): OperationRecord | null {
  const family = familyOf(chain);
  if (!family || call.protocol !== 'bridge' || !call.options) return null;
  const { targetChain, recipient, token, amount } = call.options;
  if (typeof targetChain !== 'string' || !isChain(targetChain) || targetChain === chain) return null;
  const asset = assetOf(family, token);
  const value = amountOf(amount);
  const destination = typeof recipient === 'string' ? bridgeDestination(targetChain, recipient) : null;
  if (!asset || value === null || !destination) return null;
  return { kind: 'bridge', chain, asset, amount: value, destination };
}

export function extractProtocolOperation(chain: string, call: ProtocolCall): OperationRecord | null {
  return call.protocol === 'swap' ? extractSwap(chain, call) : extractBridge(chain, call);
}
