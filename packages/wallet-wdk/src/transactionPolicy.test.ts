import { describe, it, expect } from 'vitest';
import {
  AdapterRegistry,
  PolicyAdapterError,
  RemoteAuthorizationPolicy,
  TransactionPolicy,
  coerceAmount,
  defaultAdapterRegistry,
  evaluatePolicies,
  isTransactionPolicyEnabled,
  type PolicyOperationRecord,
  type PolicyVerdict,
} from './transactionPolicy';
import { AuthorizerRefused, AuthorizerUnreachable, type Authorizer } from './client';
import type { SignedSpendAuthorization, Verdict } from './types';

// Phase 3 gates from the brief: abstain-on-timeout is proven fail-closed by
// test, and commit/rollback reconcile the ledger against a reverted
// transaction. Both are here, against a reference engine that implements the
// verdict semantics PR #88 documents.

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

const authorizer = (propose: () => Promise<Verdict>): Authorizer => ({ propose, authorizations: async () => [], publicKeyPem: async () => 'pem' });

const call = { walletType: 'evm', method: 'sendTransaction', args: [{ to: USDT, data: TRANSFER_DATA }], chain: 'evm:8453' };
const op = (): PolicyOperationRecord => defaultAdapterRegistry().toOperationRecord(call);

describe('the flag', () => {
  it('is off unless WALLET_POLICY_MODE=transaction-policy', () => {
    expect(isTransactionPolicyEnabled({})).toBe(false);
    expect(isTransactionPolicyEnabled({ WALLET_POLICY_MODE: 'on' })).toBe(false);
    expect(isTransactionPolicyEnabled({ WALLET_POLICY_MODE: 'transaction-policy' })).toBe(true);
  });
});

describe('coerceAmount', () => {
  it('yields a non-negative bigint or undefined, never a negative', () => {
    expect(coerceAmount('25000000')).toBe(25_000_000n);
    expect(coerceAmount('0x17d7840')).toBe(25_000_000n);
    expect(coerceAmount(7)).toBe(7n);
    expect(coerceAmount(7n)).toBe(7n);
    for (const bad of ['-1', -1, -1n, '1.5', 'lots', null, undefined, {}]) expect(coerceAmount(bad)).toBeUndefined();
  });
});

describe('AdapterRegistry', () => {
  it('turns an EVM sendTransaction into a chain-agnostic record carrying its raw call', () => {
    const record = op();
    expect(record).toMatchObject({ kind: 'transfer', chain: 'evm:8453', asset: USDT, amount: '25000000', destination: VENDOR });
    expect(record.raw).toMatchObject({ walletType: 'evm', method: 'sendTransaction' });
  });

  it.each([
    ['a method with no extractor', { ...call, method: 'swap' }],
    ['a wallet type with no pack', { ...call, walletType: 'tron' }],
    ['a call the extractor cannot vouch for', { ...call, args: [{ to: USDT, data: '0xdeadbeef' }] }],
  ])('throws PolicyAdapterError for %s — fail closed', (_label, bad) => {
    expect(() => defaultAdapterRegistry().toOperationRecord(bad)).toThrow(PolicyAdapterError);
  });

  it('wraps a throwing extractor in PolicyAdapterError', () => {
    const registry = new AdapterRegistry().register('evm', { sendTransaction: () => { throw new Error('boom'); } });
    expect(() => registry.toOperationRecord(call)).toThrow(PolicyAdapterError);
  });

  it('register() replaces a pack and extend() merges into it', () => {
    const registry = defaultAdapterRegistry().extend('evm', { swap: () => ({ kind: 'swap', chain: 'evm:8453', asset: USDT, amount: '1', destination: null }) });
    expect(registry.toOperationRecord({ ...call, method: 'swap' }).kind).toBe('swap');
    expect(registry.toOperationRecord(call).kind).toBe('transfer');
    registry.register('evm', { swap: () => null });
    expect(() => registry.toOperationRecord(call)).toThrow(PolicyAdapterError);
  });
});

describe('RemoteAuthorizationPolicy.evaluate', () => {
  it('allows on ALLOW and holds the authorization for settlement', async () => {
    const policy = new RemoteAuthorizationPolicy({ authorizer: authorizer(async () => ({ verdict: 'ALLOW', authorization, decisionId: 'd' })) });
    expect(await policy.evaluate(op())).toEqual({ type: 'allow' });
    expect(policy.pendingAuthorizations()).toEqual([authorization]);
  });

  it('denies on DENY and on ESCALATE — both are judgements, so both are votes', async () => {
    const denied = new RemoteAuthorizationPolicy({ authorizer: authorizer(async () => ({ verdict: 'DENY', code: 'DAILY_CAP', reason: 'over' })) });
    expect(await denied.evaluate(op())).toEqual({ type: 'deny', reason: 'DAILY_CAP: over' });
    const escalated = new RemoteAuthorizationPolicy({ authorizer: authorizer(async () => ({ verdict: 'ESCALATE', decisionId: 'dec_9', reservationId: 'r', impact: 'HIGH' })) });
    expect((await escalated.evaluate(op())).type).toBe('deny');
  });

  it.each([
    ['unreachable', async (): Promise<Verdict> => { throw new AuthorizerUnreachable('timeout'); }],
    ['refusing to answer', async (): Promise<Verdict> => { throw new AuthorizerRefused(503, 'down'); }],
    ['throwing unexpectedly', async (): Promise<Verdict> => { throw new Error('boom'); }],
  ])('abstains when the plane is %s — never allows, never throws', async (_label, propose) => {
    const policy = new RemoteAuthorizationPolicy({ authorizer: authorizer(propose) });
    const verdict = await policy.evaluate(op());
    expect(verdict.type).toBe('abstain');
    expect(policy.pendingAuthorizations()).toHaveLength(0);
  });

  it('only matches the kinds it was told to speak for', async () => {
    const policy = new RemoteAuthorizationPolicy({ authorizer: authorizer(async () => ({ verdict: 'ALLOW', authorization, decisionId: 'd' })), kinds: ['swap'] });
    expect(await policy.match(op())).toBe(false);
  });
});

describe('under the engine\'s documented verdict semantics', () => {
  class Always extends TransactionPolicy {
    readonly id = 'always';
    constructor(private readonly verdict: PolicyVerdict) { super(); }
    async match() { return true; }
    async evaluate() { return this.verdict; }
    async commit() {}
    async rollback() {}
  }

  it('abstain is not a vote: an unreachable plane leaves the operation with NO_APPLICABLE_RULE', async () => {
    // The Phase 3 gate. No timeout branch, no fail-open edge: the engine's
    // own default-deny does the refusing.
    const remote = new RemoteAuthorizationPolicy({ authorizer: authorizer(async () => { throw new AuthorizerUnreachable('partition'); }) });
    const outcome = await evaluatePolicies([remote], op());
    expect(outcome).toMatchObject({ execute: false, code: 'NO_APPLICABLE_RULE' });
  });

  it('an allow from the plane executes; a deny from any policy refuses', async () => {
    const remote = new RemoteAuthorizationPolicy({ authorizer: authorizer(async () => ({ verdict: 'ALLOW', authorization, decisionId: 'd' })) });
    expect(await evaluatePolicies([remote], op())).toEqual({ execute: true });
    expect(await evaluatePolicies([remote, new Always({ type: 'deny', reason: 'local cap' })], op())).toMatchObject({ execute: false, code: 'RULE_DENIED' });
  });

  it('an abstain beside an allow does not veto it, and an abstain beside nothing does not permit', async () => {
    expect(await evaluatePolicies([new Always({ type: 'allow' }), new Always({ type: 'abstain' })], op())).toEqual({ execute: true });
    expect(await evaluatePolicies([new Always({ type: 'abstain' })], op())).toMatchObject({ execute: false, code: 'NO_APPLICABLE_RULE' });
    expect(await evaluatePolicies([], op())).toMatchObject({ execute: false, code: 'NO_APPLICABLE_RULE' });
  });
});

describe('commit / rollback — the two-phase ledger hooks', () => {
  function withSettlement() {
    const reports: [string, string, string][] = [];
    const policy = new RemoteAuthorizationPolicy({
      authorizer: authorizer(async () => ({ verdict: 'ALLOW', authorization, decisionId: 'd' })),
      settlement: { report: async (a, outcome, txHash) => { reports.push([a.id, outcome, txHash]); } },
    });
    return { policy, reports };
  }

  it('commit reports CONFIRMED for the held authorization and releases the hold', async () => {
    const { policy, reports } = withSettlement();
    const record = op();
    await policy.evaluate(record);
    await policy.commit(record, { txHash: '0xok' });
    expect(reports).toEqual([['auth_1', 'CONFIRMED', '0xok']]);
    expect(policy.pendingAuthorizations()).toHaveLength(0);
  });

  it('rollback after a broadcast revert reports REVERTED so the ledger returns the budget', async () => {
    const { policy, reports } = withSettlement();
    const record = op();
    await policy.evaluate(record);
    await policy.rollback(record, { txHash: '0xrevert', reason: 'execution reverted' });
    expect(reports).toEqual([['auth_1', 'REVERTED', '0xrevert']]);
  });

  it('rollback of a never-broadcast operation reports nothing — expiry returns the budget', async () => {
    const { policy, reports } = withSettlement();
    const record = op();
    await policy.evaluate(record);
    await policy.rollback(record, { reason: 'user cancelled' });
    expect(reports).toEqual([]);
    expect(policy.pendingAuthorizations()).toHaveLength(0);
  });

  it('commit for an operation that was never allowed is a no-op', async () => {
    const { policy, reports } = withSettlement();
    await policy.commit(op(), { txHash: '0xstray' });
    expect(reports).toEqual([]);
  });
});
