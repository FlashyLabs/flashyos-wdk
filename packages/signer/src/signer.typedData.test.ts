import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { eip3009TypedData, type SignedSpendAuthorization } from '@flashyos/wallet-wdk';
import { Signer, type SettlementReporter } from './signer';
import { MockChain } from './chain';
import { canonicalize } from './verify';

// Phase 18 — the signer's typed-data path. An x402 payment is an EIP-3009
// authorization signed off-chain; the signer treats it exactly like a
// broadcast: re-derive, match, spend the nonce, sign, report.

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const PAY_TO = '0x7f3c000000000000000000000000000000000009';
const FROM = '0x1111111111111111111111111111111111111111';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const planePublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const NOW = () => new Date('2026-09-20T10:02:00Z');

function issue(patch: Partial<SignedSpendAuthorization> = {}): SignedSpendAuthorization {
  const payload = {
    id: `auth_${Math.random().toString(36).slice(2)}`, orgId: 'org_1', agentName: 'research-ops', chain: 'evm:84532', kind: 'transfer' as const,
    asset: USDC, maxAmount: '10000', destination: PAY_TO, reservationId: 'rsv_1', decisionId: 'dec_1',
    issuedAt: '2026-09-20T10:00:00.000Z', expiresAt: '2026-09-20T10:05:00.000Z', ...patch,
  };
  return { ...payload, sig: sign(null, canonicalize({ ...payload, sig: '' }), privateKey).toString('base64url') };
}

const accept = { scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000', payTo: PAY_TO, maxTimeoutSeconds: 60, asset: USDC, extra: { name: 'USDC', version: '2' } };
const nonce = '0x' + '5a'.repeat(32);
const typedData = () => eip3009TypedData(accept, FROM, { nonce, now: NOW() });

function signer(overrides: { settlement?: SettlementReporter; chain?: MockChain; accountIndexFor?: (a: SignedSpendAuthorization) => Promise<number | undefined> } = {}) {
  const chain = overrides.chain ?? new MockChain({ chain: 'evm:84532' });
  return { chain, signer: new Signer({ planePublicKeyPem, chains: [chain], now: NOW, settlement: overrides.settlement, accountIndexFor: overrides.accountIndexFor }) };
}

describe('Signer.signTypedData', () => {
  it('signs typed data that matches its authorization, with the agent\'s account, and reports the nonce as the reference', async () => {
    const reports: { id: string; outcome: string; txHash: string }[] = [];
    const { chain, signer: s } = signer({
      settlement: { report: async (a, outcome, txHash) => { reports.push({ id: a.id, outcome, txHash }); } },
      accountIndexFor: async () => 7,
    });
    const authorization = issue();
    const result = await s.signTypedData({ authorization, typedData: typedData() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reference).toBe(`eip3009:${nonce}`);
    expect(result.settled).toBe(true);
    expect(result.address).toBe('0x0000000000000000000000000000000000000007');
    expect(chain.signed[0].accountIndex).toBe(7);
    expect(reports).toEqual([{ id: authorization.id, outcome: 'CONFIRMED', txHash: `eip3009:${nonce}` }]);
  });

  it('refuses typed data whose destination, amount, asset or chain differ from the authorization', async () => {
    const { signer: s } = signer();
    const base = typedData();
    const cases: [string, unknown][] = [
      ['destination', { ...base, message: { ...base.message, to: FROM } }],
      ['amount', { ...base, message: { ...base.message, value: '10001' } }],
      ['asset', { ...base, domain: { ...base.domain, verifyingContract: PAY_TO } }],
    ];
    for (const [label, td] of cases) {
      const result = await s.signTypedData({ authorization: issue(), typedData: td as never });
      expect(result, label).toEqual({ ok: false, code: 'MISMATCH', reason: 'the typed data does not match what was authorized' });
    }
    const wrongChain = await s.signTypedData({ authorization: issue(), typedData: { ...base, domain: { ...base.domain, chainId: 11155111 } } });
    expect(wrongChain).toMatchObject({ ok: false, code: 'UNRECOGNISED_CALL' });
  });

  it('spends the nonce: a second signature under the same authorization is a REPLAY', async () => {
    const { chain, signer: s } = signer();
    const authorization = issue();
    expect((await s.signTypedData({ authorization, typedData: typedData() })).ok).toBe(true);
    expect(await s.signTypedData({ authorization, typedData: typedData() })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect(chain.signed).toHaveLength(1);
  });

  it('a signed authorization cannot then be broadcast as a transaction: one nonce, one use, either path', async () => {
    const { signer: s } = signer();
    const authorization = issue();
    expect((await s.signTypedData({ authorization, typedData: typedData() })).ok).toBe(true);
    const data = '0xa9059cbb' + PAY_TO.slice(2).padStart(64, '0') + (10000n).toString(16).padStart(64, '0');
    expect(await s.execute({ authorization, call: { to: USDC, value: '0', data } })).toMatchObject({ ok: false, code: 'REPLAY' });
  });

  it('refuses a tampered or expired authorization before anything else', async () => {
    const { signer: s } = signer();
    const authorization = issue();
    expect(await s.signTypedData({ authorization: { ...authorization, maxAmount: '99999' }, typedData: typedData() })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(await s.signTypedData({ authorization: issue({ expiresAt: '2026-09-20T10:01:00.000Z' }), typedData: typedData() })).toMatchObject({ ok: false, code: 'EXPIRED' });
  });

  it('is TYPED_DATA_UNSUPPORTED on a backend without the capability, and NO_BACKEND without one at all', async () => {
    const bare = { chain: 'evm:84532', execute: async () => ({ txHash: '0x', outcome: 'CONFIRMED' as const }) };
    const s = new Signer({ planePublicKeyPem, chains: [bare], now: NOW });
    expect(await s.signTypedData({ authorization: issue(), typedData: typedData() })).toMatchObject({ ok: false, code: 'TYPED_DATA_UNSUPPORTED' });
    const none = new Signer({ planePublicKeyPem, chains: [], now: NOW });
    expect(await none.signTypedData({ authorization: issue(), typedData: typedData() })).toMatchObject({ ok: false, code: 'NO_BACKEND' });
  });

  it('keeps an unreported settlement for retry when the plane is unreachable', async () => {
    const { signer: s } = signer({ settlement: { report: async () => { throw new Error('plane down'); } } });
    const result = await s.signTypedData({ authorization: issue(), typedData: typedData() });
    expect(result).toMatchObject({ ok: true, settled: false });
    expect(s.unreportedSettlements).toHaveLength(1);
    expect(s.unreportedSettlements[0].txHash).toBe(`eip3009:${nonce}`);
  });
});
