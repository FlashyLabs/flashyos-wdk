// Verification of a SpendAuthorization, signer side.
//
// This is a deliberate copy of packages/api/src/lib/wallet/authorization.ts's
// canonicalize() and verify path — the signer must not depend on the API
// package — and docs/wallet/fixtures/ holds a signed authorization that both
// sides verify by test, so the two copies cannot drift without a failing
// build. Only the public key ever lives here.

import { createPublicKey, verify, type KeyObject } from 'crypto';
import type { SignedSpendAuthorization } from '@flashyos/wallet-wdk';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString(); // same value as its ISO string; see the API copy
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Identical to the API's list. The fixture test fails if the two diverge. */
export const AUTHORIZATION_SIGNED_FIELDS = [
  'id', 'orgId', 'agentName', 'chain', 'kind', 'asset', 'maxAmount', 'destination',
  'reservationId', 'decisionId', 'issuedAt', 'expiresAt',
] as const;

export function canonicalize(auth: SignedSpendAuthorization): Buffer {
  const picked: Record<string, unknown> = {};
  for (const key of AUTHORIZATION_SIGNED_FIELDS) picked[key] = (auth as unknown as Record<string, unknown>)[key];
  return Buffer.from(JSON.stringify(sortKeys(picked)), 'utf8');
}

export const publicKeyFromPem = (pem: string): KeyObject => createPublicKey(pem);

export type VerifyResult = { ok: true } | { ok: false; code: 'BAD_SIGNATURE' | 'EXPIRED' | 'NOT_YET_VALID' };

const SKEW_MS = 30_000;

export function verifyAuthorization(auth: SignedSpendAuthorization, publicKey: KeyObject, now: Date = new Date()): VerifyResult {
  let valid = false;
  try {
    valid = verify(null, canonicalize(auth), publicKey, Buffer.from(auth.sig, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: 'BAD_SIGNATURE' };
  const issued = Date.parse(auth.issuedAt);
  const expires = Date.parse(auth.expiresAt);
  if (Number.isNaN(issued) || Number.isNaN(expires)) return { ok: false, code: 'BAD_SIGNATURE' };
  if (now.getTime() + SKEW_MS < issued) return { ok: false, code: 'NOT_YET_VALID' };
  if (now.getTime() > expires) return { ok: false, code: 'EXPIRED' };
  return { ok: true };
}
