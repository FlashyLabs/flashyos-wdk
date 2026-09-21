import { describe, it, expect } from 'vitest';
import { remoteAuthorizationRule, registerRemotePolicy } from './policy';
import { AuthorizerUnreachable, type Authorizer } from './client';
import type { SignedSpendAuthorization, Verdict } from './types';

const USDT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const VENDOR = '0x7f3c000000000000000000000000000000000001';
const TRANSFER_DATA =
  '0xa9059cbb' +
  '0000000000000000000000007f3c000000000000000000000000000000000001' +
  '00000000000000000000000000000000000000000000000000000000017d7840';

const authorization: SignedSpendAuthorization = {
  id: 'auth_1', orgId: 'org', agentName: 'a', chain: 'evm:8453', kind: 'transfer', asset: USDT, maxAmount: '25000000',
  destination: VENDOR, reservationId: 'r', decisionId: 'd', issuedAt: '2026-09-19T11:00:00.000Z',
  expiresAt: '2026-09-19T11:05:00.000Z', sig: 'c2ln',
};

const authorizer = (propose: () => Promise<Verdict>): Authorizer => ({
  propose,
  authorizations: async () => [],
  publicKeyPem: async () => 'pem',
});

const ctx = (args: unknown[]) => ({ operation: 'sendTransaction', wallet: 'evm', account: {}, args });

describe('remoteAuthorizationRule', () => {
  it('is an ALLOW rule on the four write operations with one async condition', () => {
    const rule = remoteAuthorizationRule({ authorizer: authorizer(async () => ({ verdict: 'DENY', code: 'DAILY_CAP', reason: 'x' })), chainId: 8453 });
    expect(rule).toMatchObject({ operation: ['sendTransaction', 'transfer', 'swap', 'bridge'], action: 'ALLOW' });
    expect(rule.conditions).toHaveLength(1);
    expect(() => remoteAuthorizationRule({ authorizer: authorizer(async () => ({ verdict: 'DENY', code: 'DAILY_CAP', reason: 'x' })) })).toThrow(/chain/);
  });

  it('re-derives swaps and bridges from their protocol options, and TRON transfers on a TRON chain', async () => {
    const proposed: unknown[] = [];
    const evm = remoteAuthorizationRule({
      authorizer: authorizer(async () => ({ verdict: 'ALLOW', authorization, decisionId: 'd' })),
      chainId: 8453,
      onAuthorized: () => {},
    });
    const a = { propose: async (r: unknown) => { proposed.push(r); return { verdict: 'ALLOW', authorization, decisionId: 'd' } as Verdict; }, authorizations: async () => [], publicKeyPem: async () => 'pem' };
    const rule = remoteAuthorizationRule({ authorizer: a, chainId: 8453 });
    expect(await rule.conditions[0]({ ...ctx([{ tokenIn: USDT, tokenOut: '0x4200000000000000000000000000000000000006', tokenInAmount: 5n }]), operation: 'swap' })).toBe(true);
    expect(proposed[0]).toEqual({ kind: 'swap', chain: 'evm:8453', asset: USDT, amount: '5', destination: null });
    expect(await rule.conditions[0]({ ...ctx([{ targetChain: 'evm:42161', recipient: VENDOR, token: USDT, amount: '7' }]), operation: 'bridge' })).toBe(true);
    expect(proposed[1]).toMatchObject({ kind: 'bridge', destination: `evm:42161:${VENDOR}` });
    // The buy side of a swap has no bounded input: refused before the plane is asked.
    expect(await rule.conditions[0]({ ...ctx([{ tokenIn: USDT, tokenOut: VENDOR, tokenOutAmount: 5n }]), operation: 'swap' })).toBe(false);
    expect(proposed).toHaveLength(2);
    expect(evm.operation).toContain('transfer');

    const tron = remoteAuthorizationRule({ authorizer: a, chain: 'tron:mainnet' });
    expect(await tron.conditions[0]({ ...ctx([{ token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', recipient: 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9', amount: 1 }]), operation: 'transfer', wallet: 'tron' })).toBe(true);
    expect(proposed[2]).toMatchObject({ kind: 'transfer', chain: 'tron:mainnet', destination: 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9' });
  });

  it('returns true only for ALLOW and hands the authorization to onAuthorized', async () => {
    const seen: SignedSpendAuthorization[] = [];
    const rule = remoteAuthorizationRule({
      authorizer: authorizer(async () => ({ verdict: 'ALLOW', authorization, decisionId: 'd' })),
      chainId: 8453,
      onAuthorized: (a) => seen.push(a),
    });
    expect(await rule.conditions[0](ctx([{ to: USDT, data: TRANSFER_DATA }]))).toBe(true);
    expect(seen).toEqual([authorization]);
  });

  it.each([
    ['DENY', async (): Promise<Verdict> => ({ verdict: 'DENY', code: 'PER_TX_CAP', reason: 'over' }), 'PER_TX_CAP'],
    ['ESCALATE', async (): Promise<Verdict> => ({ verdict: 'ESCALATE', decisionId: 'd', reservationId: 'r', impact: 'HIGH' }), 'ESCALATED'],
    ['an unreachable plane', async (): Promise<Verdict> => { throw new AuthorizerUnreachable('down'); }, 'AUTHORIZER_ERROR'],
    ['an unexpected throw', async (): Promise<Verdict> => { throw new Error('boom'); }, 'AUTHORIZER_ERROR'],
  ])('returns false for %s and never throws', async (_label, propose, code) => {
    const refused: { code: string }[] = [];
    const rule = remoteAuthorizationRule({ authorizer: authorizer(propose), chainId: 8453, onRefused: (d) => refused.push(d) });
    await expect(rule.conditions[0](ctx([{ to: USDT, data: TRANSFER_DATA }]))).resolves.toBe(false);
    expect(refused[0]?.code).toBe(code);
  });

  it('returns false for a call it cannot vouch for, without asking the plane', async () => {
    let asked = 0;
    const rule = remoteAuthorizationRule({
      authorizer: authorizer(async () => { asked += 1; return { verdict: 'ALLOW', authorization, decisionId: 'd' }; }),
      chainId: 8453,
    });
    expect(await rule.conditions[0](ctx([{ to: USDT, data: '0x095ea7b3' }]))).toBe(false);
    expect(await rule.conditions[0](ctx([]))).toBe(false);
    expect(asked).toBe(0);
  });

  it('registers as a project-scoped policy in WDK\'s documented shape', () => {
    const registered: unknown[] = [];
    registerRemotePolicy({ registerPolicy: (p) => registered.push(p) }, { authorizer: authorizer(async () => ({ verdict: 'DENY', code: 'DAILY_CAP', reason: 'x' })), chainId: 1 });
    expect(registered[0]).toMatchObject({ id: 'flashyos-remote', scope: 'project', rules: [{ operation: ['sendTransaction', 'transfer', 'swap', 'bridge'], action: 'ALLOW' }] });
  });
});
