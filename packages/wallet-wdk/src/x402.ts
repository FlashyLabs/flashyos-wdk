// Phase 18 — x402: an HTTP 402 challenge becomes a bounded OperationRecord.
//
// x402 (v1) answers a request with 402 and a JSON body naming what it will
// accept: a scheme ("exact"), a network, an asset, a maximum amount, and the
// address to pay. The client answers with an EIP-3009
// `transferWithAuthorization` signed off-chain; a facilitator submits it.
//
// For the plane this is a transfer like any other: the challenge is parsed
// into a record whose amount is the challenge's maximum and whose destination
// is `payTo`; the plane grades it against the envelope; the signer signs the
// typed data only if the typed data re-derives to a record within the
// authorization. Testnets only, by the same rule as everything else: a
// network this file does not list as a testnet is refused, and no flag
// widens the list.

import { isAddress, normalizeAddress } from './extractors/address';
import type { OperationRecord } from './types';

export interface X402Accept {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  /** EIP-712 domain name and version of the asset contract, as x402 carries them. */
  extra?: { name?: string; version?: string };
}

export interface X402Challenge {
  x402Version: number;
  error?: string;
  accepts: X402Accept[];
}

/** x402 network names this package knows. Only `testnet: true` entries can become a record. */
export const X402_NETWORKS: Record<string, { chain: string; testnet: boolean }> = {
  'base-sepolia': { chain: 'evm:84532', testnet: true },
  'sepolia': { chain: 'evm:11155111', testnet: true },
  'avalanche-fuji': { chain: 'evm:43113', testnet: true },
  'base': { chain: 'evm:8453', testnet: false },
  'avalanche': { chain: 'evm:43114', testnet: false },
  'polygon': { chain: 'evm:137', testnet: false },
};

export class X402Refused extends Error {
  constructor(public readonly code: 'MALFORMED' | 'UNSUPPORTED_SCHEME' | 'UNKNOWN_NETWORK' | 'MAINNET_NOT_ENABLED' | 'BAD_ADDRESS' | 'BAD_AMOUNT', message: string) {
    super(message);
    this.name = 'X402Refused';
  }
}

/**
 * Parses a 402 response: the JSON body, or the base64 `PAYMENT-REQUIRED`
 * header some servers send instead. Validates shape only; nothing here
 * decides whether to pay.
 */
export function parseX402Challenge(input: { body?: unknown; header?: string | null }): X402Challenge {
  let raw: unknown = input.body;
  if ((raw === undefined || raw === null) && input.header) {
    try {
      raw = JSON.parse(Buffer.from(input.header, 'base64').toString('utf8'));
    } catch {
      throw new X402Refused('MALFORMED', 'PAYMENT-REQUIRED header is not base64 JSON');
    }
  }
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new X402Refused('MALFORMED', 'challenge body is not JSON');
    }
  }
  const c = raw as X402Challenge;
  if (!c || typeof c !== 'object' || typeof c.x402Version !== 'number' || !Array.isArray(c.accepts) || c.accepts.length === 0) {
    throw new X402Refused('MALFORMED', 'a challenge needs x402Version and a non-empty accepts list');
  }
  for (const a of c.accepts) {
    if (!a || typeof a !== 'object' || typeof a.scheme !== 'string' || typeof a.network !== 'string' || typeof a.maxAmountRequired !== 'string' || typeof a.payTo !== 'string' || typeof a.asset !== 'string') {
      throw new X402Refused('MALFORMED', 'each accepts entry needs scheme, network, maxAmountRequired, payTo and asset');
    }
  }
  return { x402Version: c.x402Version, error: c.error, accepts: c.accepts };
}

const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

/**
 * The first acceptable option as a bounded record. "Acceptable" is strict:
 * scheme `exact`, a network listed as a testnet, valid addresses, an
 * integer amount. The record's amount is the challenge's maximum — the plane
 * authorizes up to it, the signer signs exactly it.
 */
export function x402Record(challenge: X402Challenge): { record: OperationRecord; accept: X402Accept } {
  let last: X402Refused | null = null;
  for (const accept of challenge.accepts) {
    try {
      if (accept.scheme !== 'exact') throw new X402Refused('UNSUPPORTED_SCHEME', `scheme "${accept.scheme}" is not supported; only "exact"`);
      const network = X402_NETWORKS[accept.network];
      if (!network) throw new X402Refused('UNKNOWN_NETWORK', `network "${accept.network}" is not one this package knows`);
      if (!network.testnet) throw new X402Refused('MAINNET_NOT_ENABLED', `network "${accept.network}" is a mainnet; testnets only`);
      if (!isAddress('evm', accept.payTo) || !isAddress('evm', accept.asset)) throw new X402Refused('BAD_ADDRESS', 'payTo and asset must be EVM addresses');
      if (!AMOUNT_RE.test(accept.maxAmountRequired)) throw new X402Refused('BAD_AMOUNT', 'maxAmountRequired must be a base-unit integer string');
      const record: OperationRecord = {
        kind: 'transfer',
        chain: network.chain,
        asset: normalizeAddress('evm', accept.asset),
        amount: accept.maxAmountRequired,
        destination: normalizeAddress('evm', accept.payTo),
        raw: { via: 'x402', scheme: accept.scheme, network: accept.network, resource: accept.resource ?? null },
      };
      return { record, accept };
    } catch (err) {
      if (err instanceof X402Refused) { last = err; continue; }
      throw err;
    }
  }
  throw last ?? new X402Refused('MALFORMED', 'no accepts entry');
}

// ─── EIP-3009 typed data ─────────────────────────────────────────────────────

export interface Eip712TypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: 'TransferWithAuthorization';
  message: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** The typed data an x402 `exact` payment signs. `nonce` is 32 random bytes the caller supplies (hex, 0x-prefixed). */
export function eip3009TypedData(accept: X402Accept, from: string, options: { nonce: string; now?: Date; validAfter?: string }): Eip712TypedData {
  const network = X402_NETWORKS[accept.network];
  if (!network || !network.testnet) throw new X402Refused('MAINNET_NOT_ENABLED', `network "${accept.network}" is not an enabled testnet`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.nonce)) throw new X402Refused('MALFORMED', 'nonce must be 32 bytes, hex');
  if (!isAddress('evm', from)) throw new X402Refused('BAD_ADDRESS', 'from must be an EVM address');
  const now = options.now ?? new Date();
  const validBefore = Math.floor(now.getTime() / 1000) + (accept.maxTimeoutSeconds ?? 60);
  return {
    domain: { name: accept.extra?.name ?? '', version: accept.extra?.version ?? '1', chainId: Number(network.chain.split(':')[1]), verifyingContract: accept.asset },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization.map((f) => ({ ...f })) },
    primaryType: 'TransferWithAuthorization',
    message: { from, to: accept.payTo, value: accept.maxAmountRequired, validAfter: options.validAfter ?? '0', validBefore: String(validBefore), nonce: options.nonce },
  };
}

/**
 * The signer's re-derivation for typed data: what an EIP-3009 authorization
 * would move, as a record — the chain from the domain, the asset from the
 * verifying contract, the amount and destination from the message. Null for
 * anything that is not exactly a TransferWithAuthorization.
 */
export function extractEip3009Operation(chain: string, typedData: unknown): OperationRecord | null {
  const t = typedData as Eip712TypedData;
  if (!t || typeof t !== 'object' || t.primaryType !== 'TransferWithAuthorization' || !t.domain || !t.message) return null;
  if (!Number.isInteger(t.domain.chainId) || chain !== `evm:${t.domain.chainId}`) return null;
  const fields = t.types?.TransferWithAuthorization;
  if (!Array.isArray(fields) || fields.length !== 6 || fields.some((f, i) => f.name !== TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization[i].name || f.type !== TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization[i].type)) return null;
  const { from, to, value, nonce, validBefore } = t.message;
  if (!isAddress('evm', t.domain.verifyingContract) || !isAddress('evm', to) || !isAddress('evm', from)) return null;
  if (typeof value !== 'string' || !AMOUNT_RE.test(value)) return null;
  return {
    kind: 'transfer',
    chain,
    asset: normalizeAddress('evm', t.domain.verifyingContract),
    amount: value,
    destination: normalizeAddress('evm', to),
    raw: { via: 'eip-3009', from: normalizeAddress('evm', from), nonce, validBefore },
  };
}

/** The `X-PAYMENT` header value: base64 of the x402 payment payload carrying the signature and the authorization it signs. */
export function x402PaymentHeader(accept: X402Accept, typedData: Eip712TypedData, signature: string): string {
  const payload = {
    x402Version: 1,
    scheme: accept.scheme,
    network: accept.network,
    payload: { signature, authorization: typedData.message },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// ─── The server side (Phase 25) ──────────────────────────────────────────────

/** The x402 network name for a plane chain id, or null when the chain is not one this package lists. */
export function networkForChain(chain: string): string | null {
  const entry = Object.entries(X402_NETWORKS).find(([, v]) => v.chain === chain);
  return entry ? entry[0] : null;
}

export interface BuildChallengeInput {
  /** `<family>:<chainId>`; must map to a listed testnet. */
  chain: string;
  /** The seller's receiving address — registered, never typed by an agent. */
  payTo: string;
  asset: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

/** A 402 body a seller answers with. Refuses a chain that is not a listed testnet, the same rule as the buyer's side. */
export function buildX402Challenge(input: BuildChallengeInput, error = 'payment required'): X402Challenge {
  const network = networkForChain(input.chain);
  if (!network) throw new X402Refused('UNKNOWN_NETWORK', `chain ${input.chain} has no x402 network name in this package`);
  if (!X402_NETWORKS[network].testnet) throw new X402Refused('MAINNET_NOT_ENABLED', `network "${network}" is a mainnet; testnets only`);
  if (!isAddress('evm', input.payTo) || !isAddress('evm', input.asset)) throw new X402Refused('BAD_ADDRESS', 'payTo and asset must be EVM addresses');
  if (!AMOUNT_RE.test(input.maxAmountRequired)) throw new X402Refused('BAD_AMOUNT', 'maxAmountRequired must be a base-unit integer string');
  return {
    x402Version: 1,
    error,
    accepts: [{
      scheme: 'exact', network, maxAmountRequired: input.maxAmountRequired, resource: input.resource, description: input.description ?? '', mimeType: input.mimeType ?? 'application/json',
      payTo: input.payTo, maxTimeoutSeconds: input.maxTimeoutSeconds ?? 60, asset: input.asset, extra: input.extra ?? { name: 'USDC', version: '2' },
    }],
  };
}

export interface X402Payment {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { signature: string; authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string } };
}

/** Decodes an `X-PAYMENT` header (base64 JSON). Shape only. */
export function parseX402Payment(header: string): X402Payment {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new X402Refused('MALFORMED', 'X-PAYMENT is not base64 JSON');
  }
  const p = raw as X402Payment;
  const a = p?.payload?.authorization;
  if (!p || typeof p !== 'object' || typeof p.scheme !== 'string' || typeof p.network !== 'string' || typeof p.payload?.signature !== 'string' || !a) {
    throw new X402Refused('MALFORMED', 'a payment needs scheme, network, payload.signature and payload.authorization');
  }
  for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const) {
    if (typeof a[k] !== 'string') throw new X402Refused('MALFORMED', `authorization.${k} is required`);
  }
  if (!isAddress('evm', a.from) || !isAddress('evm', a.to)) throw new X402Refused('BAD_ADDRESS', 'authorization.from and .to must be EVM addresses');
  if (!AMOUNT_RE.test(a.value)) throw new X402Refused('BAD_AMOUNT', 'authorization.value must be a base-unit integer string');
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) throw new X402Refused('MALFORMED', 'authorization.nonce must be 32 bytes, hex');
  return p;
}

/** What a payment pays, as the seller's plane records it: the seller's address, the amount, on the network's chain. */
export function x402PaymentRecord(payment: X402Payment, asset: string): OperationRecord {
  const network = X402_NETWORKS[payment.network];
  if (!network) throw new X402Refused('UNKNOWN_NETWORK', `network "${payment.network}" is not one this package knows`);
  if (!network.testnet) throw new X402Refused('MAINNET_NOT_ENABLED', `network "${payment.network}" is a mainnet; testnets only`);
  if (payment.scheme !== 'exact') throw new X402Refused('UNSUPPORTED_SCHEME', `scheme "${payment.scheme}" is not supported; only "exact"`);
  const a = payment.payload.authorization;
  return {
    kind: 'transfer', chain: network.chain, asset: normalizeAddress('evm', asset), amount: a.value, destination: normalizeAddress('evm', a.to),
    raw: { via: 'x402', from: normalizeAddress('evm', a.from), nonce: a.nonce, validBefore: a.validBefore },
  };
}
