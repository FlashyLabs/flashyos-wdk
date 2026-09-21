// One entry point: a chain and whatever the caller is about to hand WDK →
// the OperationRecord it actually performs, or null. Null means refuse.

import type { OperationRecord } from '../types';
import { familyOf } from './address';
import { extractEvmOperation, type EvmCall } from './evm';
import { extractProtocolOperation, isProtocolCall, type BridgeCall, type ProtocolCall, type SwapCall } from './protocols';
import { extractTronOperation, type TronCall } from './tron';

export type SignerCall = EvmCall | TronCall | SwapCall | BridgeCall;

export function extractOperation(chain: string, call: unknown): OperationRecord | null {
  if (!call || typeof call !== 'object') return null;
  if (isProtocolCall(call)) return extractProtocolOperation(chain, call as ProtocolCall);
  const family = familyOf(chain);
  const [, chainId] = chain.split(':');
  if (!family || !chainId) return null;
  if (family === 'evm') return extractEvmOperation(chainId, call as EvmCall);
  if (family === 'tron') return extractTronOperation(chainId, call as TronCall);
  return null;
}
