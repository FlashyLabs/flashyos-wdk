import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { publicKeyFromPem, verifyAuthorization } from './verify';
import type { SignedSpendAuthorization } from '@flashyos/wallet-wdk';

// The other half of the conformance pair: an authorization signed by the API
// (packages/api/src/lib/wallet/fixtures.test.ts) verifies here with only the
// public key. If either side's canonicalization changes, this fails.

const DIR = path.resolve(__dirname, '../../../docs/wallet/fixtures');
const fixture = JSON.parse(readFileSync(path.join(DIR, 'authorization.json'), 'utf8')) as SignedSpendAuthorization;
const publicKey = publicKeyFromPem(readFileSync(path.join(DIR, 'test-signing-key.pub.pem'), 'utf8'));

describe('verifyAuthorization — conformance with the API', () => {
  it('verifies the API-signed fixture with the public key alone', () => {
    expect(verifyAuthorization(fixture, publicKey, new Date('2026-09-19T11:01:00Z'))).toEqual({ ok: true });
  });

  it('is insensitive to key order in the JSON it receives', () => {
    const reordered = Object.fromEntries(Object.entries(fixture).reverse()) as SignedSpendAuthorization;
    expect(verifyAuthorization(reordered, publicKey, new Date('2026-09-19T11:01:00Z'))).toEqual({ ok: true });
  });

  it('refuses one altered byte', () => {
    expect(verifyAuthorization({ ...fixture, maxAmount: '25000001' }, publicKey)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('accepts Date objects where the plane signed ISO strings', () => {
    const withDates = { ...fixture, issuedAt: new Date(fixture.issuedAt), expiresAt: new Date(fixture.expiresAt) } as unknown as SignedSpendAuthorization;
    expect(verifyAuthorization(withDates, publicKey, new Date('2026-09-19T11:01:00Z'))).toEqual({ ok: true });
  });

  it('accepts a listing-decorated authorization (status, txHash) — those fields are not signed', () => {
    const decorated = { ...fixture, status: 'ISSUED', spentAt: null, txHash: null } as unknown as SignedSpendAuthorization;
    expect(verifyAuthorization(decorated, publicKey, new Date('2026-09-19T11:01:00Z'))).toEqual({ ok: true });
  });
});
