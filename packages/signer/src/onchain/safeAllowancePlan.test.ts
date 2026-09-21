import { describe, it, expect } from 'vitest';
import { PLAN_SELECTORS, safeAllowancePlan } from './safeAllowancePlan';

// Phase 17 — the plan is a document a person executes. It must be
// deterministic, complete, and encode exactly the module's ABI.

const SAFE = '0x1000000000000000000000000000000000000001';
const MODULE = '0xcfbfac74c26f8647cbdb8c5caf80bb5b32e43134';
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

describe('safeAllowancePlan', () => {
  it('emits addDelegate + setAllowance per agent, sorted by name, with the module ABI encoding', () => {
    const plan = safeAllowancePlan({ safeAddress: SAFE, moduleAddress: MODULE, token: TOKEN, agents: [{ agentName: 'zeta', address: B, dailyMax: '5000000' }, { agentName: 'alpha', address: A, dailyMax: '25000000' }] });
    expect(plan.version).toBe(1);
    expect(plan.transactions.map((t) => `${t.op}:${t.agentName}`)).toEqual(['addDelegate:alpha', 'setAllowance:alpha', 'addDelegate:zeta', 'setAllowance:zeta']);
    const [add, set] = plan.transactions;
    expect(add.to).toBe(MODULE);
    expect(add.data).toBe(PLAN_SELECTORS.addDelegate + pad(A));
    expect(set.data).toBe(PLAN_SELECTORS.setAllowance + pad(A) + pad(TOKEN) + (25_000_000n).toString(16).padStart(64, '0') + (1440).toString(16).padStart(64, '0') + '0'.repeat(64));
    expect(set.summary).toContain('25000000');
    expect(plan.transactions.every((t) => t.value === '0')).toBe(true);
  });

  it('is deterministic: the same input in any order yields the same document', () => {
    const agents = [{ agentName: 'b', address: B, dailyMax: '1' }, { agentName: 'a', address: A, dailyMax: '2' }];
    const one = safeAllowancePlan({ safeAddress: SAFE, moduleAddress: MODULE, token: TOKEN, agents });
    const two = safeAllowancePlan({ safeAddress: SAFE, moduleAddress: MODULE, token: TOKEN, agents: [...agents].reverse() });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('retires agents whose envelope is gone: deleteAllowance then removeDelegate', () => {
    const plan = safeAllowancePlan({ safeAddress: SAFE, moduleAddress: MODULE, token: TOKEN, agents: [], retire: [{ agentName: 'gone', address: B }] });
    expect(plan.transactions.map((t) => t.op)).toEqual(['deleteAllowance', 'removeDelegate']);
    expect(plan.transactions[0].data).toBe(PLAN_SELECTORS.deleteAllowance + pad(B) + pad(TOKEN));
    expect(plan.transactions[1].data).toBe(PLAN_SELECTORS.removeDelegate + pad(B) + '0'.repeat(63) + '1');
  });

  it('uses the selectors of the Safe Allowance Module ABI', () => {
    expect(PLAN_SELECTORS).toEqual({ addDelegate: '0xe71bdf41', setAllowance: '0xbeaeb388', removeDelegate: '0xdd43a79f', deleteAllowance: '0x885133e3' });
  });

  it('refuses two agents on one address, a uint96 overflow, and a bad address', () => {
    const base = { safeAddress: SAFE, moduleAddress: MODULE, token: TOKEN };
    expect(() => safeAllowancePlan({ ...base, agents: [{ agentName: 'a', address: A, dailyMax: '1' }, { agentName: 'b', address: A.toUpperCase().replace('0X', '0x'), dailyMax: '1' }] })).toThrow(/one address per agent/);
    expect(() => safeAllowancePlan({ ...base, agents: [{ agentName: 'a', address: A, dailyMax: (1n << 96n).toString() }] })).toThrow(/uint96/);
    expect(() => safeAllowancePlan({ ...base, agents: [{ agentName: 'a', address: 'bob', dailyMax: '1' }] })).toThrow(/no valid address/);
    expect(() => safeAllowancePlan({ ...base, safeAddress: 'safe', agents: [] })).toThrow(/safeAddress/);
  });
});
