import { describe, it, expect } from 'vitest';
import { extractEvmOperation } from '@flashyos/wallet-wdk';
import { SafeAllowanceLimit, SELECTORS } from './safeAllowance';
import { Signer } from '../signer';
import { MockChain } from '../chain';
import { canonicalize } from '../verify';
import { generateKeyPairSync, sign } from 'crypto';
import type { SignedSpendAuthorization } from '@flashyos/wallet-wdk';

// The allowance module, read and encoded, against a scripted eth_call. The
// contract itself is not here — that is the open half of the gate — but
// everything this side of it is: the module's arithmetic, its calldata,
// and the signer refusing on what the chain would refuse.

const MODULE = '0x1111111111111111111111111111111111111111';
const SAFE = '0x2222222222222222222222222222222222222222';
const DELEGATE = '0x3333333333333333333333333333333333333333';
const USDT = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const VENDOR = '0x7f3c000000000000000000000000000000000001';

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
function rpc(allowance: { amount: bigint; spent: bigint; resetTimeMin: number; lastResetMin: number; nonce: number }, hash = '0x' + 'ab'.repeat(32)) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params: [{ data: string }] };
    const data = body.params[0].data;
    calls.push(data);
    const result = data.startsWith(SELECTORS.getTokenAllowance)
      ? '0x' + word(allowance.amount) + word(allowance.spent) + word(allowance.resetTimeMin) + word(allowance.lastResetMin) + word(allowance.nonce)
      : data.startsWith(SELECTORS.generateTransferHash) ? hash : '0x';
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const limit = (fetchImpl: typeof fetch, nowMinutes = () => 1_000_000) => new SafeAllowanceLimit({ rpcUrl: 'http://rpc', moduleAddress: MODULE, safeAddress: SAFE, delegateAddress: DELEGATE, fetch: fetchImpl, nowMinutes });
const transfer = (amount: string) => ({ kind: 'transfer' as const, chain: 'evm:84532', asset: USDT, amount, destination: VENDOR });

describe('SafeAllowanceLimit — reading the chain', () => {
  it('decodes getTokenAllowance and asks for exactly this safe, delegate and token', async () => {
    const { fetchImpl, calls } = rpc({ amount: 100n, spent: 30n, resetTimeMin: 0, lastResetMin: 0, nonce: 7 });
    const a = await limit(fetchImpl).allowance(USDT);
    expect(a).toEqual({ amount: 100n, spent: 30n, resetTimeMin: 0, lastResetMin: 0, nonce: 7 });
    expect(calls[0]).toBe(SELECTORS.getTokenAllowance + word(BigInt(SAFE)) + word(BigInt(DELEGATE)) + word(BigInt(USDT)));
  });

  it('check: within, over, none, and native — with the module\'s reset arithmetic', async () => {
    const { fetchImpl } = rpc({ amount: 100n, spent: 30n, resetTimeMin: 0, lastResetMin: 0, nonce: 0 });
    expect(await limit(fetchImpl).check(transfer('70'))).toMatchObject({ ok: true, remaining: 70n });
    expect(await limit(fetchImpl).check(transfer('71'))).toMatchObject({ ok: false, code: 'ONCHAIN_LIMIT', reason: expect.stringContaining('71 exceeds') });
    const none = rpc({ amount: 0n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 0 });
    expect(await limit(none.fetchImpl).check(transfer('1'))).toMatchObject({ ok: false, code: 'ONCHAIN_LIMIT', reason: expect.stringContaining('no on-chain allowance') });
    expect(await limit(fetchImpl).check({ ...transfer('1'), asset: 'native' })).toMatchObject({ ok: false, code: 'ONCHAIN_UNKNOWN_ASSET' });
    // A daily window that has elapsed: spent resets, the whole amount is back.
    const windowed = rpc({ amount: 100n, spent: 100n, resetTimeMin: 1440, lastResetMin: 1_000_000 - 1440, nonce: 0 });
    expect(await limit(windowed.fetchImpl).check(transfer('100'))).toMatchObject({ ok: true, remaining: 100n });
    const notYet = rpc({ amount: 100n, spent: 100n, resetTimeMin: 1440, lastResetMin: 1_000_000 - 1439, nonce: 0 });
    expect(await limit(notYet.fetchImpl).check(transfer('1'))).toMatchObject({ ok: false, code: 'ONCHAIN_LIMIT' });
    expect(SafeAllowanceLimit.remaining({ amount: 10n, spent: 15n, resetTimeMin: 0, lastResetMin: 0, nonce: 0 }, 0)).toBe(0n);
  });

  it('refuses malformed addresses at construction and a short response from the chain', async () => {
    expect(() => new SafeAllowanceLimit({ rpcUrl: 'x', moduleAddress: 'module', safeAddress: SAFE, delegateAddress: DELEGATE })).toThrow(/moduleAddress/);
    const short = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x00' }))) as unknown as typeof fetch;
    await expect(limit(short).allowance(USDT)).rejects.toThrow(/short response/);
    const errored = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'execution reverted' } }))) as unknown as typeof fetch;
    await expect(limit(errored).allowance(USDT)).rejects.toThrow(/execution reverted/);
  });
});

describe('executeAllowanceTransfer — the calldata, and the extractor that vouches for it', () => {
  it('builds calldata the EVM extractor re-derives as the transfer it is', () => {
    const { fetchImpl } = rpc({ amount: 100n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 0 });
    const call = limit(fetchImpl).transferCall(transfer('25000000'), '0x' + '11'.repeat(65));
    expect(call.to).toBe(MODULE);
    expect(call.data.startsWith(SELECTORS.executeAllowanceTransfer)).toBe(true);
    const record = extractEvmOperation('84532', call);
    expect(record).toMatchObject({ kind: 'transfer', chain: 'evm:84532', asset: USDT, amount: '25000000', destination: VENDOR });
    expect(record?.raw).toEqual({ via: 'safe-allowance-module', module: MODULE, safe: SAFE, delegate: DELEGATE });
  });

  it('refuses a payment to the executor — a second transfer one record cannot express — and native value', () => {
    const { fetchImpl } = rpc({ amount: 100n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 0 });
    const call = limit(fetchImpl).transferCall(transfer('1'), '0xaa');
    // Patch the payment word (index 5) to 1.
    const data = call.data;
    const start = 10 + 5 * 64;
    const withPayment = data.slice(0, start) + word(1) + data.slice(start + 64);
    expect(extractEvmOperation('84532', { to: MODULE, data: withPayment })).toBeNull();
    expect(extractEvmOperation('84532', { to: MODULE, data: call.data, value: '1' })).toBeNull();
    expect(extractEvmOperation('84532', { to: MODULE, data: SELECTORS.executeAllowanceTransfer + word(1) })).toBeNull();
  });

  it('transferHash asks the module with the module\'s own nonce', async () => {
    const { fetchImpl, calls } = rpc({ amount: 100n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 9 }, '0x' + 'cd'.repeat(32));
    const { hash, nonce } = await limit(fetchImpl).transferHash(transfer('5'));
    expect(nonce).toBe(9);
    expect(hash).toBe('0x' + 'cd'.repeat(32));
    expect(calls[1].endsWith(word(9))).toBe(true);
  });
});

describe('Signer with the third line', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const planePublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const issue = (maxAmount: string): SignedSpendAuthorization => {
    const payload = {
      id: `auth_${Math.random().toString(36).slice(2)}`, orgId: 'org_1', agentName: 'ops', chain: 'evm:84532', kind: 'transfer' as const, asset: USDT, maxAmount, destination: VENDOR,
      reservationId: 'r', decisionId: 'd', issuedAt: '2026-09-20T11:00:00.000Z', expiresAt: '2026-09-20T11:05:00.000Z',
    };
    return { ...payload, sig: sign(null, canonicalize({ ...payload, sig: '' }), privateKey).toString('base64url') };
  };
  const NOW = () => new Date('2026-09-20T11:02:00Z');

  it('a spend the plane allowed is refused by the signer when the chain\'s allowance would refuse it — the gate\'s shape, read from the chain', async () => {
    const { fetchImpl } = rpc({ amount: 50n, spent: 40n, resetTimeMin: 0, lastResetMin: 0, nonce: 0 });
    const onChainLimit = limit(fetchImpl);
    const chain = new MockChain({ chain: 'evm:84532' });
    const signer = new Signer({ planePublicKeyPem, chains: [chain], now: NOW, onChainLimit });
    const call = onChainLimit.transferCall(transfer('25'), '0xaa');
    // The plane allowed 25; the chain has 10 left.
    const refused = await signer.execute({ authorization: issue('25'), call });
    expect(refused).toMatchObject({ ok: false, code: 'ONCHAIN_LIMIT', reason: expect.stringContaining('25 exceeds') });
    expect(chain.executions).toHaveLength(0);
    const ok = await signer.execute({ authorization: issue('10'), call: onChainLimit.transferCall(transfer('10'), '0xaa') });
    expect(ok).toMatchObject({ ok: true });
    expect(chain.executions[0].record).toMatchObject({ amount: '10', destination: VENDOR, asset: USDT });
  });
});
