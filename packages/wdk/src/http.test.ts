import { describe, it, expect } from 'vitest';
import { HttpTransport } from './http';
import { TransportError } from './transport';
import type { SignedSpendAuthorization } from './types';

// Every method against a recording fetch: the URL, the method, the body and
// which credential went on the wire. The point is that a session token
// never reaches an agent route and an agent token never reaches a session
// route — the object's separation of duties is the transport's.

const USDT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const authorization: SignedSpendAuthorization = {
  id: 'auth_1', orgId: 'org_1', agentName: 'ops', chain: 'evm:84532', kind: 'transfer', asset: USDT, maxAmount: '1', destination: '0x7f3c000000000000000000000000000000000001',
  reservationId: 'r', decisionId: 'd', issuedAt: 'i', expiresAt: 'e', sig: 's',
};

function recorder(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', auth: headers?.authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => url.includes(k)) ?? '';
    const route = routes[key] ?? { status: 404, body: { error: 'no route' } };
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const transport = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof HttpTransport>[0]> = {}) =>
  new HttpTransport({ baseUrl: 'https://api.flashyos.com/', orgId: 'org_1', sessionToken: 'SESSION', agentTokens: { ops: 'OPS' }, signerUrl: 'http://signer:8787', fetch: fetchImpl, ...extra });

describe('HttpTransport', () => {
  it('creates an agent: mints with the session, sets scopes with the session, keeps the agent token for later', async () => {
    const { fetchImpl, calls } = recorder({ '/agents/new/scopes': { body: { agentName: 'new', scopes: ['wallet:propose'] } }, '/agents': { status: 201, body: { orgId: 'org_1', agentName: 'new', token: 'NEW' } } });
    const t = transport(fetchImpl);
    expect(await t.createAgent('new', ['wallet:propose'])).toEqual({ orgId: 'org_1', agentName: 'new', scopes: ['wallet:propose'] });
    expect(calls.map((c) => [c.method, c.url.replace('https://api.flashyos.com/api/v1/orgs/org_1', ''), c.auth])).toEqual([
      ['POST', '/agents', 'Bearer SESSION'],
      ['PUT', '/agents/new/scopes', 'Bearer SESSION'],
    ]);
    expect(t.tokenFor('new')).toBe('NEW');
  });

  it('session routes carry the session; agent routes carry the agent token; the signer gets no bearer at all', async () => {
    const { fetchImpl, calls } = recorder({
      '/wallet/envelopes/delegate': { status: 201, body: { delegation: { id: 'child' } } },
      '/wallet/envelopes': { status: 201, body: { envelope: { id: 'env' } } },
      '/wallet/proposals': { status: 201, body: { verdict: 'ALLOW', authorization, decisionId: 'd' } },
      '/wallet/settlements': { status: 202, body: { settlement: { id: 's' }, verdict: { verdict: 'ESCALATE' }, autoAcceptedByPolicyId: null } },
      '/vault/captures': { status: 201, body: { capture: {} } },
      '/decisions/dec_1/resolve': { body: { ok: true } },
      '/execute': { status: 403, body: { ok: false, code: 'MISMATCH', reason: 'no' } },
    });
    const t = transport(fetchImpl);
    await t.setEnvelope('ops', { chain: 'evm:84532', kinds: ['transfer'], assets: [USDT], destinations: [], perTxMax: '1', dailyMax: '1', autoApproveMax: '1' });
    await t.propose('ops', { kind: 'transfer', chain: 'evm:84532', asset: USDT, amount: '1', destination: null });
    await t.delegate('ops', 'junior', { chain: 'evm:84532', kinds: ['transfer'], assets: [USDT], destinations: [], perTxMax: '1', dailyMax: '1', autoApproveMax: '1' });
    expect((await t.settle('ops', { invoiceId: 'inv' })).verdict.verdict).toBe('ESCALATE');
    await t.capture('ops', 'hello', 'notes');
    await t.resolveDecision('dec_1', true);
    expect(await t.execute(authorization, { to: USDT, value: '1' })).toEqual({ ok: false, code: 'MISMATCH', reason: 'no' });

    const auths = calls.map((c) => c.auth);
    expect(auths).toEqual(['Bearer SESSION', 'Bearer OPS', 'Bearer OPS', 'Bearer OPS', 'Bearer OPS', 'Bearer SESSION', null]);
    expect(calls[0].body).toMatchObject({ agentName: 'ops', chain: 'evm:84532' });
    expect(calls[2].body).toMatchObject({ agentName: 'junior' });
    expect(calls[5].url).toBe('https://api.flashyos.com/api/v1/decisions/dec_1/resolve');
    expect(calls[6].url).toBe('http://signer:8787/execute');
    expect(calls[6].body).toEqual({ authorization, call: { to: USDT, value: '1' } });
  });

  it('a missing credential is refused before any request; a missing signer is a refusal value', async () => {
    const { fetchImpl, calls } = recorder({});
    const t = transport(fetchImpl, { sessionToken: undefined, agentTokens: {}, signerUrl: undefined });
    await expect(t.ledger()).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
    await expect(t.propose('ops', { kind: 'transfer', chain: 'evm:84532', asset: USDT, amount: '1', destination: null })).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
    expect(await t.execute(authorization, { to: USDT, value: '1' })).toMatchObject({ ok: false, code: 'NO_SIGNER' });
    expect(calls).toHaveLength(0);
  });

  it('an API error becomes a TransportError with the API\'s code; a 404 receipt is null; a network failure is UNREACHABLE', async () => {
    const { fetchImpl } = recorder({
      '/wallet/envelopes': { status: 400, body: { error: 'caps', code: 'ENVELOPE_INVALID_CAPS' } },
      '/wallet/receipts/x': { status: 404, body: { error: 'not yet', code: 'RECEIPT_NOT_READY' } },
      '/wallet/metrics': { body: { days: 7, metrics: { writes: 3 } } },
    });
    const t = transport(fetchImpl);
    await expect(t.setEnvelope('ops', { chain: 'evm:84532', kinds: ['transfer'], assets: [USDT], destinations: [], perTxMax: '2', dailyMax: '1', autoApproveMax: '1' })).rejects.toMatchObject({ code: 'ENVELOPE_INVALID_CAPS', status: 400 });
    expect(await t.receipt('x')).toBeNull();
    expect((await t.metrics(7)).writes).toBe(3);
    const down = transport((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    await expect(down.ledger()).rejects.toBeInstanceOf(TransportError);
    await expect(down.ledger()).rejects.toMatchObject({ code: 'UNREACHABLE' });
    expect(await down.execute(authorization, { to: USDT, value: '1' })).toMatchObject({ ok: false, code: 'SIGNER_UNREACHABLE' });
  });
});
