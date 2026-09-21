import { describe, it, expect } from 'vitest';
import { createElicitationHandler } from './elicitation';
import { AuthorizerUnreachable, AuthorizerRefused, type Authorizer } from './client';
import type { AuthorizationView, SignedSpendAuthorization, Verdict } from './types';

// Every path through the handler that is not an ALLOW must be a decline.
// The tests below enumerate them; there is no case where an error, a timeout
// or an unrecognised call turns into an accept.

const USDT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const VENDOR = '0x7f3c000000000000000000000000000000000001';
const TRANSFER_DATA =
  '0xa9059cbb' +
  '0000000000000000000000007f3c000000000000000000000000000000000001' +
  '00000000000000000000000000000000000000000000000000000000017d7840';

const pending = { chain: 'evm:8453', call: { to: USDT, data: TRANSFER_DATA } };

const authorization: SignedSpendAuthorization = {
  id: 'auth_1', orgId: 'org', agentName: 'research-ops', chain: 'evm:8453', kind: 'transfer', asset: USDT,
  maxAmount: '25000000', destination: VENDOR, reservationId: 'rsv_1', decisionId: 'dec_1',
  issuedAt: '2026-09-19T11:00:00.000Z', expiresAt: '2026-09-19T11:05:00.000Z', sig: 'c2ln',
};

function fake(propose: () => Promise<Verdict>, lists: AuthorizationView[][] = []): Authorizer & { proposals: unknown[] } {
  const proposals: unknown[] = [];
  let calls = 0;
  return {
    proposals,
    async propose(record) {
      proposals.push(record);
      return propose();
    },
    async authorizations() {
      const list = lists[Math.min(calls, lists.length - 1)] ?? [];
      calls += 1;
      return list;
    },
    async publicKeyPem() {
      return 'pem';
    },
  };
}

describe('createElicitationHandler', () => {
  it('accepts an ALLOW with the signed authorization, having proposed the extracted record', async () => {
    const authorizer = fake(async () => ({ verdict: 'ALLOW', authorization, decisionId: 'dec_1' }));
    const handle = createElicitationHandler({ authorizer });
    await expect(handle(pending)).resolves.toEqual({ action: 'accept', authorization });
    expect(authorizer.proposals[0]).toMatchObject({ kind: 'transfer', asset: USDT, amount: '25000000', destination: VENDOR });
  });

  it('declines a DENY with the plane\'s code', async () => {
    const handle = createElicitationHandler({ authorizer: fake(async () => ({ verdict: 'DENY', code: 'DAILY_CAP', reason: 'over' })) });
    await expect(handle(pending)).resolves.toEqual({ action: 'decline', code: 'DAILY_CAP', reason: 'over' });
  });

  it('declines an unrecognised call without ever asking the plane', async () => {
    const authorizer = fake(async () => ({ verdict: 'ALLOW', authorization, decisionId: 'dec_1' }));
    const handle = createElicitationHandler({ authorizer });
    const decision = await handle({ chain: 'evm:8453', call: { to: USDT, data: '0xdeadbeef' } });
    expect(decision).toMatchObject({ action: 'decline', code: 'UNRECOGNISED_CALL' });
    expect(authorizer.proposals).toHaveLength(0);
  });

  it('declines when the plane is unreachable — fail closed', async () => {
    const handle = createElicitationHandler({
      authorizer: fake(async () => { throw new AuthorizerUnreachable('timeout'); }),
    });
    await expect(handle(pending)).resolves.toMatchObject({ action: 'decline', code: 'AUTHORIZER_UNREACHABLE' });
  });

  it('declines when the plane refuses to answer (bad token, rate limit)', async () => {
    const handle = createElicitationHandler({
      authorizer: fake(async () => { throw new AuthorizerRefused(429, 'rate limit exceeded'); }),
    });
    await expect(handle(pending)).resolves.toMatchObject({ action: 'decline', code: 'AUTHORIZER_REFUSED' });
  });

  describe('ESCALATE', () => {
    const escalate = async (): Promise<Verdict> => ({ verdict: 'ESCALATE', decisionId: 'dec_9', reservationId: 'rsv_9', impact: 'HIGH' });
    const view = (patch: Partial<AuthorizationView>): AuthorizationView => ({
      id: 'auth_9', orgId: 'org', agentName: 'research-ops', chain: 'evm:8453', kind: 'transfer', asset: USDT, maxAmount: '25000000',
      destination: VENDOR, status: 'ISSUED', decisionId: 'dec_9', reservationId: 'rsv_9',
      issuedAt: '2026-09-19T11:00:00.000Z', expiresAt: '2026-09-19T11:05:00.000Z', spentAt: null, txHash: null, sig: 'c2ln', ...patch,
    });

    it('declines immediately with the decisionId when not asked to wait', async () => {
      const handle = createElicitationHandler({ authorizer: fake(escalate) });
      await expect(handle(pending)).resolves.toMatchObject({ action: 'decline', code: 'ESCALATED', decisionId: 'dec_9' });
    });

    it('accepts once a human approves and the signed authorization appears', async () => {
      let t = 0;
      const handle = createElicitationHandler({
        authorizer: fake(escalate, [[], [], [view({})]]),
        waitForDecision: { timeoutMs: 1000, pollMs: 100 },
        now: () => t,
        sleep: async (ms) => { t += ms; },
      });
      const decision = await handle(pending);
      expect(decision.action).toBe('accept');
      if (decision.action === 'accept') expect(decision.authorization).toMatchObject({ decisionId: 'dec_9', sig: 'c2ln', orgId: 'org' });
    });

    it('declines when the wait times out, and when the listing has no signature', async () => {
      let t = 0;
      const timesOut = createElicitationHandler({
        authorizer: fake(escalate, [[]]),
        waitForDecision: { timeoutMs: 300, pollMs: 100 },
        now: () => t,
        sleep: async (ms) => { t += ms; },
      });
      await expect(timesOut(pending)).resolves.toMatchObject({ action: 'decline', code: 'ESCALATED' });

      t = 0;
      const unsigned = createElicitationHandler({
        authorizer: fake(escalate, [[view({ sig: undefined })]]),
        waitForDecision: { timeoutMs: 300, pollMs: 100 },
        now: () => t,
        sleep: async (ms) => { t += ms; },
      });
      await expect(unsigned(pending)).resolves.toMatchObject({ action: 'decline' });
    });

    it('stops waiting as soon as the authorization is seen in a non-ISSUED state', async () => {
      let polls = 0;
      const handle = createElicitationHandler({
        authorizer: { ...fake(escalate), async authorizations() { polls += 1; return [view({ status: 'REVOKED' })]; } },
        waitForDecision: { timeoutMs: 10_000, pollMs: 100 },
        now: () => 0,
        sleep: async () => {},
      });
      await expect(handle(pending)).resolves.toMatchObject({ action: 'decline', code: 'ESCALATED' });
      expect(polls).toBe(1);
    });
  });
});
