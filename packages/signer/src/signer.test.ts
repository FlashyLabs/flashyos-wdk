import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { Signer, type SettlementReporter } from './signer';
import { MockChain } from './chain';
import { canonicalize } from './verify';
import type { SignedSpendAuthorization } from '@flashyos/wallet-wdk';

// The signer's five refusals, in order, and the one path through them. Every
// refusal here is a case where a valid-looking request would have moved money
// it was not entitled to move.

const USDT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const VENDOR = '0x7f3c000000000000000000000000000000000001';
const STRANGER = '0x7f3c000000000000000000000000000000000099';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const planePublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function issue(patch: Partial<SignedSpendAuthorization> = {}): SignedSpendAuthorization {
  const payload = {
    id: `auth_${Math.random().toString(36).slice(2)}`,
    orgId: 'org_1',
    agentName: 'research-ops',
    chain: 'evm:8453',
    kind: 'transfer' as const,
    asset: USDT,
    maxAmount: '25000000',
    destination: VENDOR,
    reservationId: 'rsv_1',
    decisionId: 'dec_1',
    issuedAt: '2026-09-19T11:00:00.000Z',
    expiresAt: '2026-09-19T11:05:00.000Z',
    ...patch,
  };
  const unsigned = { ...payload, sig: '' };
  return { ...payload, sig: sign(null, canonicalize(unsigned), privateKey).toString('base64url') };
}

const transferData = (to: string, amount: bigint) =>
  '0xa9059cbb' + to.replace(/^0x/, '').padStart(64, '0') + amount.toString(16).padStart(64, '0');

const NOW = () => new Date('2026-09-19T11:02:00Z');

describe('Signer.execute', () => {
  it('executes a call that matches its authorization and reports settlement', async () => {
    const chain = new MockChain();
    const reported: unknown[] = [];
    const settlement: SettlementReporter = { report: async (a, outcome, txHash) => { reported.push([a.id, outcome, txHash]); } };
    const signer = new Signer({ planePublicKeyPem, chains: [chain], settlement, now: NOW });

    const authorization = issue();
    const result = await signer.execute({ authorization, call: { to: USDT, data: transferData(VENDOR, 25_000_000n) } });

    expect(result).toMatchObject({ ok: true, outcome: 'CONFIRMED', settled: true });
    expect(chain.executions[0].record).toMatchObject({ asset: USDT, destination: VENDOR, amount: '25000000' });
    expect(reported).toEqual([[authorization.id, 'CONFIRMED', chain.executions[0].result.txHash]]);
  });

  it('accepts a smaller amount than authorized — maxAmount is a ceiling', async () => {
    const signer = new Signer({ planePublicKeyPem, chains: [new MockChain()], now: NOW });
    const result = await signer.execute({ authorization: issue(), call: { to: USDT, data: transferData(VENDOR, 1n) } });
    expect(result.ok).toBe(true);
  });

  it('refuses a tampered authorization before anything else', async () => {
    const chain = new MockChain();
    const signer = new Signer({ planePublicKeyPem, chains: [chain], now: NOW });
    const tampered = { ...issue(), maxAmount: '999999999' };
    await expect(signer.execute({ authorization: tampered, call: { to: USDT, data: transferData(VENDOR, 1n) } })).resolves.toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(chain.executions).toHaveLength(0);
  });

  it('refuses an authorization signed by a key that is not the plane\'s', async () => {
    const other = generateKeyPairSync('ed25519');
    const signer = new Signer({ planePublicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }).toString(), chains: [new MockChain()], now: NOW });
    await expect(signer.execute({ authorization: issue(), call: { to: USDT, data: transferData(VENDOR, 1n) } })).resolves.toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('refuses an expired authorization', async () => {
    const signer = new Signer({ planePublicKeyPem, chains: [new MockChain()], now: () => new Date('2026-09-19T11:06:00Z') });
    await expect(signer.execute({ authorization: issue(), call: { to: USDT, data: transferData(VENDOR, 1n) } })).resolves.toMatchObject({ ok: false, code: 'EXPIRED' });
  });

  it('refuses a replay: the second use of one authorization does nothing', async () => {
    const chain = new MockChain();
    const signer = new Signer({ planePublicKeyPem, chains: [chain], now: NOW });
    const authorization = issue();
    const call = { to: USDT, data: transferData(VENDOR, 1n) };
    expect((await signer.execute({ authorization, call })).ok).toBe(true);
    await expect(signer.execute({ authorization, call })).resolves.toMatchObject({ ok: false, code: 'REPLAY' });
    expect(chain.executions).toHaveLength(1);
  });

  it.each([
    ['a larger amount', { to: USDT, data: transferData(VENDOR, 25_000_001n) }],
    ['a different payee', { to: USDT, data: transferData(STRANGER, 1n) }],
    ['a different token', { to: STRANGER, data: transferData(VENDOR, 1n) }],
    ['a native transfer when a token was authorized', { to: VENDOR, value: '1' }],
  ])('refuses a call that does not match the authorization: %s', async (_label, call) => {
    const chain = new MockChain();
    const signer = new Signer({ planePublicKeyPem, chains: [chain], now: NOW });
    await expect(signer.execute({ authorization: issue(), call })).resolves.toMatchObject({ ok: false, code: 'MISMATCH' });
    expect(chain.executions).toHaveLength(0);
  });

  it('refuses a call it cannot vouch for, and a chain it has no backend for', async () => {
    const signer = new Signer({ planePublicKeyPem, chains: [new MockChain()], now: NOW });
    await expect(signer.execute({ authorization: issue(), call: { to: USDT, data: '0x095ea7b3' } })).resolves.toMatchObject({ ok: false, code: 'UNRECOGNISED_CALL' });
    await expect(signer.execute({ authorization: issue({ chain: 'evm:1' }), call: { to: USDT, data: transferData(VENDOR, 1n) } })).resolves.toMatchObject({ ok: false, code: 'NO_BACKEND' });
  });

  it('marks the nonce spent even when the chain reverts, and reports REVERTED', async () => {
    const chain = new MockChain({ outcomeFor: () => 'REVERTED' });
    const reported: string[] = [];
    const signer = new Signer({ planePublicKeyPem, chains: [chain], now: NOW, settlement: { report: async (_a, o) => { reported.push(o); } } });
    const authorization = issue();
    const call = { to: USDT, data: transferData(VENDOR, 1n) };
    expect(await signer.execute({ authorization, call })).toMatchObject({ ok: true, outcome: 'REVERTED' });
    expect(reported).toEqual(['REVERTED']);
    await expect(signer.execute({ authorization, call })).resolves.toMatchObject({ ok: false, code: 'REPLAY' });
  });

  it('keeps an unreported settlement for retry rather than losing it', async () => {
    const signer = new Signer({
      planePublicKeyPem, chains: [new MockChain()], now: NOW,
      settlement: { report: async () => { throw new Error('plane down'); } },
    });
    const result = await signer.execute({ authorization: issue(), call: { to: USDT, data: transferData(VENDOR, 1n) } });
    expect(result).toMatchObject({ ok: true, settled: false });
    expect(signer.unreportedSettlements).toHaveLength(1);
    expect(signer.unreportedSettlements[0].error).toBe('plane down');
  });

  it('a backend failure after the nonce is spent is EXECUTION_FAILED, kept for the operator, never a replay window', async () => {
    const { ReceiptTimeout } = await import('./receipts');
    let attempt = 0;
    const flaky = {
      chain: 'evm:8453',
      execute: async () => {
        attempt += 1;
        if (attempt === 1) throw new ReceiptTimeout('0xbroadcast', 1000); // broadcast, unconfirmed
        throw new Error('rpc unreachable'); // never broadcast
      },
    };
    const reported: unknown[] = [];
    const signer = new Signer({ planePublicKeyPem, chains: [flaky], now: NOW, settlement: { report: async (a) => { reported.push(a.id); } } });

    const first = issue();
    const call = { to: USDT, data: transferData(VENDOR, 1n) };
    expect(await signer.execute({ authorization: first, call })).toMatchObject({ ok: false, code: 'EXECUTION_FAILED', reason: expect.stringContaining('0xbroadcast') });
    expect(await signer.execute({ authorization: issue(), call })).toMatchObject({ ok: false, code: 'EXECUTION_FAILED', reason: expect.stringMatching(/^not broadcast/) });

    expect(signer.pendingExecutions.map((p) => p.txHash)).toEqual(['0xbroadcast', null]);
    expect(reported).toEqual([]); // nothing settled: the plane's nightly releases the budget or the operator reconciles
    // The first authorization's nonce was spent before the attempt; a retry is a replay.
    await expect(signer.execute({ authorization: first, call })).resolves.toMatchObject({ ok: false, code: 'REPLAY' });
  });
});
