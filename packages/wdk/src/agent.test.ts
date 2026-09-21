import { describe, it, expect } from 'vitest';
import { FlashyOrganization } from './organization';
import { FlashyEvents } from './events';
import { TransportError, type Transport } from './transport';
import type { AuthorizationView, EnvelopeView, MeterView, SignedSpendAuthorization, Verdict } from './types';

// The object over a scripted transport: what each verb calls, what it
// returns, and which event it emits. The transport is what a test doubles;
// the object's own logic — transact's five outcomes, waiting for a human,
// the event stream — is what is under test.

const USDT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const VENDOR = '0x7f3c000000000000000000000000000000000001';
const calldata = (to: string, amount: bigint) => '0xa9059cbb' + to.slice(2).padStart(64, '0') + amount.toString(16).padStart(64, '0');

const authorization: SignedSpendAuthorization = {
  id: 'auth_1', orgId: 'org_1', agentName: 'ops', chain: 'evm:84532', kind: 'transfer', asset: USDT, maxAmount: '25', destination: VENDOR,
  reservationId: 'rsv', decisionId: 'dec_1', issuedAt: '2026-09-20T10:00:00.000Z', expiresAt: '2026-09-20T10:05:00.000Z', sig: 'sig',
};

const meterView = (patch: Partial<MeterView> & { agentName: string }): MeterView => ({
  id: 'm_1', chain: 'evm:84532', asset: USDT, provider: VENDOR, providerName: 'Inference Co', unit: 'token', cap: '1000', used: '0', units: '0', toleranceBps: 100,
  status: 'OPEN', decisionId: 'dec_m', authorizationId: null, txHash: null, providerUnits: null, providerAmount: null, difference: null, refusalCode: null, openedAt: 'now', closedAt: null, ticks: 0, ...patch,
});

function fakeTransport(script: Partial<Transport> & { verdicts?: Verdict[]; listings?: AuthorizationView[][] } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const verdicts = [...(script.verdicts ?? [])];
  const listings = [...(script.listings ?? [])];
  const rec = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const envelope: EnvelopeView = {
    id: 'env_1', agentName: 'ops', chain: 'evm:84532', kinds: ['transfer'], assets: [USDT], destinations: [VENDOR], perTxMax: '100', dailyMax: '500',
    autoApproveMax: '25', alwaysEscalate: false, escalationImpact: 'MEDIUM', active: true, version: 1, createdAt: 'now', delegable: true, delegatedBy: null, parentEnvelopeId: null,
  };
  const t: Transport = {
    orgId: 'org_1',
    createAgent: async (agentName, scopes) => { rec('createAgent', agentName, scopes); return { orgId: 'org_1', agentName, scopes }; },
    setEnvelope: async (agentName, input) => { rec('setEnvelope', agentName, input); return { ...envelope, agentName }; },
    revokeEnvelope: async (a, c) => { rec('revokeEnvelope', a, c); },
    listEnvelopes: async () => [envelope, { ...envelope, id: 'env_2', agentName: 'other' }],
    registerAddress: async (i) => { rec('registerAddress', i); return { id: 'addr', chain: i.chain, address: i.address, label: i.label ?? '', active: true, createdAt: 'now' }; },
    setSettlementPolicy: async (i) => { rec('setSettlementPolicy', i); return { id: 'pol', ...i, createdBy: 'u', active: true, createdAt: 'now' }; },
    listDecisions: async () => [{ id: 'dec_1', orgId: 'org_1', agentName: 'ops', summary: 's', impact: 'MEDIUM', status: 'PENDING', resolvedBy: null, resolvedAt: null, createdAt: 'now' }],
    resolveDecision: async (d, a) => { rec('resolveDecision', d, a); },
    ledger: async () => [],
    metrics: async (days) => { rec('metrics', days); return { orgId: 'org_1', since: 's', until: 'u', writes: 0, proposalsAllowed: 0, proposalsEscalated: 0, proposalsRefused: 0, humanAsks: 0, humanAsksPerHundredWrites: null, reasonedOutcomes: 0, reasonCoverage: null, settlementsPaid: { attempted: 0, settled: 0, reverted: 0, refused: 0, pending: 0 }, settlementsReceived: 0, settlementLatencySeconds: { mean: null, median: null, samples: 0 } }; },
    receivables: async () => ({ outstandingInvoices: [], expected: [], received: [], refused: [], reverted: [], totals: [], byPayer: [], receipts: [], outboundInvoices: [], inboundPayments: [] }),
    receipt: async () => null,
    propose: async (agentName, record) => { rec('propose', agentName, record); return verdicts.shift() ?? { verdict: 'DENY', code: 'NO_ENVELOPE', reason: 'none' }; },
    authorizations: async (agentName) => { rec('authorizations', agentName); return listings.shift() ?? []; },
    delegate: async (a, target, input) => { rec('delegate', a, target, input); return { ...envelope, id: 'env_child', agentName: target, delegatedBy: a, parentEnvelopeId: 'env_1', decisionId: 'dec_del' }; },
    revokeDelegation: async (a, target, chain) => { rec('revokeDelegation', a, target, chain); },
    settle: async (a, input) => { rec('settle', a, input); return { settlement: { id: 'stl', workBroadcastId: 'wb', payerOrgId: 'org_1', payeeOrgId: 'org_2', payerAgentName: a, chain: 'evm:84532', asset: USDT, amount: '5', destination: VENDOR, status: 'AUTHORIZED', refusalCode: null, decisionId: 'd', authorizationId: 'auth', txHash: null, settledAt: null, invoiceId: 'invoiceId' in input ? input.invoiceId : null, createdAt: 'now' }, verdict: { verdict: 'ALLOW', authorization, decisionId: 'd' }, autoAcceptedByPolicyId: null }; },
    invoice: async (a, input) => { rec('invoice', a, input); return { id: 'inv', workBroadcastId: input.workBroadcastId, payeeOrgId: 'org_1', payerOrgId: 'org_2', chain: input.chain, asset: input.asset, amount: input.amount, memo: input.memo ?? '', status: 'ISSUED', issuedBy: a, createdAt: 'now' }; },
    capture: async (a, body, sourcePath) => { rec('capture', a, body, sourcePath); },
    execute: async (auth, call) => { rec('execute', auth, call); return { ok: true, txHash: '0xtx', outcome: 'CONFIRMED', settled: true }; },
    assignIdentity: async (agentName, family) => { rec('assignIdentity', agentName, family); return { agentName, family, accountIndex: 1, address: null, createdAt: 'now' }; },
    listIdentities: async () => [],
    allowancePlan: async (input) => { rec('allowancePlan', input); return { plan: { version: 1, safeAddress: input.safeAddress, moduleAddress: input.moduleAddress, token: input.token, transactions: [] }, missingAddress: [], agents: [] }; },
    listMeters: async () => [],
    listExternalSettlements: async () => [],
    publicKey: async () => ({ algorithm: 'Ed25519', format: 'spki-pem', publicKey: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n' }),
    openMeter: async (agentName, input) => { rec('openMeter', agentName, input); return { verdict: 'ALLOW', meter: meterView({ agentName, ...input }) }; },
    tickMeter: async (agentName, meterId, input) => { rec('tickMeter', agentName, meterId, input); return meterView({ agentName, used: input.amount, units: input.units, ticks: 1 }); },
    closeMeter: async (agentName, meterId, input) => { rec('closeMeter', agentName, meterId, input); return { closed: true, meter: meterView({ agentName, status: 'CLOSED', used: '300', providerAmount: input.providerAmount }), authorization: { ...authorization, maxAmount: '300' } }; },
    settleExternal: async (agentName, invoice) => { rec('settleExternal', agentName, invoice); const inv = invoice as { id: string; payee: { name: string }; amount: string; chain: string }; return { settlement: { id: 'ext', payerAgentName: agentName, payeeName: inv.payee.name, payeePublicKey: 'k', invoiceId: inv.id, invoice: invoice as never, chain: inv.chain, asset: USDT, amount: inv.amount, destination: VENDOR, status: 'AUTHORIZED', refusalCode: null, decisionId: 'd', authorizationId: 'auth_1', txHash: null, settledAt: null, receipt: null, createdAt: 'now' }, verdict: { verdict: 'ALLOW', authorization, decisionId: 'd' } }; },
    externalReceipt: async () => null,
    provenance: async () => [],
    seals: async () => [],
    seal: async () => { rec('seal'); return { version: 1, org: 'org_1', seq: 1, entries: 3, through: 'now', root: 'ab'.repeat(32), sig: 's', id: 'seal_1', createdAt: 'now', anchorCalldata: '0x' + 'ab'.repeat(32) }; },
    setWalletSharing: async (share) => { rec('setWalletSharing', share); return { share }; },
    planeDocument: async () => ({ version: 1, plane: { name: 'flashyos', url: null }, keys: [{ kid: 'k'.repeat(64), publicKey: 'pem', status: 'active' }], chains: ['evm:84532'], schemas: [], generatedAt: 'g' }),
    listTrustedPlanes: async () => [],
    trustPlane: async (input) => { rec('trustPlane', input); return [{ id: 'tp', name: input.name, kid: 'k'.repeat(64), publicKey: 'pem', url: null, createdBy: 'u', active: true, createdAt: 'now', revokedAt: null }]; },
    revokeTrustedPlane: async (id) => { rec('revokeTrustedPlane', id); },
    signingKeys: async () => [{ id: 'key', kid: 'a'.repeat(64), publicKey: 'pem', active: true, createdAt: 'now', retiredAt: null }],
    rotateSigningKey: async () => { rec('rotateSigningKey'); return { id: 'key2', kid: 'b'.repeat(64), publicKey: 'pem2', active: true, createdAt: 'now', retiredAt: null }; },
    listOutboundInvoices: async () => [],
    listInboundPayments: async () => [],
    moneyPage: async (days) => { rec('moneyPage', days); return null; },
    issueSignedInvoice: async (agentName, input) => { rec('issueSignedInvoice', agentName, input); return { id: 'ob', invoiceId: input.invoiceId ?? 'acme-1', invoice: {} as never, invoiceHash: 'h'.repeat(64), kid: 'a'.repeat(64), chain: input.chain, asset: input.asset, amount: input.amount, destination: VENDOR, memo: input.memo ?? '', status: 'ISSUED', issuedBy: agentName, receipt: null, receiptKid: null, txHash: null, paidAt: null, expiresAt: 'later', createdAt: 'now' }; },
    voidOutboundInvoice: async (agentName, id) => { rec('voidOutboundInvoice', agentName, id); return { id, invoiceId: 'acme-1', invoice: {} as never, invoiceHash: 'h'.repeat(64), kid: 'a'.repeat(64), chain: 'evm:84532', asset: USDT, amount: '1', destination: VENDOR, memo: '', status: 'VOID', issuedBy: agentName, receipt: null, receiptKid: null, txHash: null, paidAt: null, expiresAt: 'later', createdAt: 'now' }; },
    acceptReceipt: async (agentName, receipt) => { rec('acceptReceipt', agentName, receipt); return { accepted: true, invoice: { id: 'ob', invoiceId: 'acme-1', invoice: {} as never, invoiceHash: 'h'.repeat(64), kid: 'a'.repeat(64), chain: 'evm:84532', asset: USDT, amount: '1', destination: VENDOR, memo: '', status: 'PAID', issuedBy: agentName, receipt: receipt as never, receiptKid: 'k'.repeat(64), txHash: '0xpaid', paidAt: 'now', expiresAt: 'later', createdAt: 'now' }, verifiedUnder: { kid: 'k'.repeat(64), name: 'partner-plane', source: 'registry' }, page: { key: 'receipts/inbound/ob', address: 'mind:org_1/receipts/inbound/ob@abc' } }; },
    x402Challenge: async (agentName, input) => { rec('x402Challenge', agentName, input); return { x402Version: 1, accepts: [{ scheme: 'exact', network: 'base-sepolia', maxAmountRequired: input.amount, payTo: VENDOR, asset: input.asset, resource: input.resource }] }; },
    recordX402Settlement: async (agentName, input) => { rec('recordX402Settlement', agentName, input); return { id: 'ip', kind: 'x402', chain: 'evm:84532', asset: input.asset, amount: '5000', from: '0x1111111111111111111111111111111111111111', to: VENDOR, nonce: '0x' + '11'.repeat(32), resource: input.resource ?? null, txHash: input.txHash, outcome: input.outcome, createdAt: 'now' }; },
    networkWallet: async () => ({ contributing: 0, since: 's', until: 'u', writes: 0, humanAsks: 0, humanAsksPerHundredWrites: null, reasonedOutcomes: 0, reasonCoverage: null, settlementsPaid: { attempted: 0, settled: 0, reverted: 0, refused: 0, pending: 0 }, settlementsReceived: 0, settlementLatencySeconds: { median: null, samples: 0 }, generatedAt: 'g' }),
    signTypedData: async (auth, typedData) => { rec('signTypedData', auth, typedData); return { ok: true, signature: '0xsig', address: '0xfrom', reference: `eip3009:${typedData.message.nonce}`, settled: true }; },
    ...script,
  };
  return { t, calls };
}

describe('FlashyOrganization — the human side', () => {
  it('creates an agent with its identity and emits agent.created', async () => {
    const { t, calls } = fakeTransport();
    const org = new FlashyOrganization(t);
    const agent = await org.agents.create('ops', ['wallet:propose', 'wallet:read']);
    expect(agent.identity).toEqual({ orgId: 'org_1', agentName: 'ops', scopes: ['wallet:propose', 'wallet:read'] });
    expect(calls[0]).toEqual({ method: 'createAgent', args: ['ops', ['wallet:propose', 'wallet:read']] });
    expect(org.events.log.map((e) => e.type)).toEqual(['agent.created']);
    expect(org.agents.get('ops')).toBe(agent);
    expect(org.agents.list()).toHaveLength(1);
  });

  it('sets and revokes authority, resolves decisions, reads the books — each a session act with an event', async () => {
    const { t, calls } = fakeTransport();
    const org = new FlashyOrganization(t);
    const env = await org.authority.set('ops', { chain: 'evm:84532', kinds: ['transfer'], assets: [USDT], destinations: [VENDOR], perTxMax: '100', dailyMax: '500', autoApproveMax: '25', delegable: true });
    expect(env.delegable).toBe(true);
    await org.authority.revoke('ops', 'evm:84532');
    expect(await org.decisions.pending()).toHaveLength(1);
    await org.decisions.resolve('dec_1', true);
    await org.metrics(30);
    expect(calls.map((c) => c.method)).toEqual(['setEnvelope', 'revokeEnvelope', 'resolveDecision', 'metrics']);
    expect(calls[3].args).toEqual([30]);
    expect(org.events.counts()).toEqual({ 'envelope.set': 1, 'envelope.revoked': 1, 'decision.resolved': 1 });
  });
});

describe('FlashyAgent.wallet.transact — the five outcomes', () => {
  const call = { to: USDT, data: calldata(VENDOR, 25n) };

  it('executed: allowed by the plane, executed by the signer, with the same call', async () => {
    const { t, calls } = fakeTransport({ verdicts: [{ verdict: 'ALLOW', authorization, decisionId: 'dec_1' }] });
    const agent = new FlashyOrganization(t).agents.get('ops');
    const result = await agent.wallet.transact('evm:84532', call);
    expect(result).toMatchObject({ status: 'executed', txHash: '0xtx', outcome: 'CONFIRMED', record: { kind: 'transfer', asset: USDT, amount: '25', destination: VENDOR } });
    expect(calls.map((c) => c.method)).toEqual(['propose', 'execute']);
    expect(calls[1].args[1]).toBe(call);
  });

  it('denied: the plane refused; nothing reaches the signer', async () => {
    const { t, calls } = fakeTransport({ verdicts: [{ verdict: 'DENY', code: 'PER_TX_CAP', reason: 'over' }] });
    const org = new FlashyOrganization(t);
    const result = await org.agents.get('ops').wallet.transact('evm:84532', call);
    expect(result).toMatchObject({ status: 'denied', code: 'PER_TX_CAP', reason: 'over' });
    expect(calls.map((c) => c.method)).toEqual(['propose']);
    expect(org.events.log.map((e) => e.type)).toEqual(['wallet.proposed', 'wallet.denied']);
  });

  it('refused: the signer said no to a valid authorization', async () => {
    const { t } = fakeTransport({ verdicts: [{ verdict: 'ALLOW', authorization, decisionId: 'dec_1' }], execute: async () => ({ ok: false, code: 'MISMATCH', reason: 'the call does not match' }) });
    const org = new FlashyOrganization(t);
    const result = await org.agents.get('ops').wallet.transact('evm:84532', call);
    expect(result).toMatchObject({ status: 'refused', code: 'MISMATCH' });
    expect(org.events.log.at(-1)?.type).toBe('wallet.refused');
  });

  it('escalated: returns the decision immediately when not asked to wait', async () => {
    const { t, calls } = fakeTransport({ verdicts: [{ verdict: 'ESCALATE', decisionId: 'dec_9', reservationId: 'r', impact: 'HIGH' }] });
    const result = await new FlashyOrganization(t).agents.get('ops').wallet.transact('evm:84532', call);
    expect(result).toEqual({ status: 'escalated', record: expect.any(Object), decisionId: 'dec_9', impact: 'HIGH' });
    expect(calls.map((c) => c.method)).toEqual(['propose']);
  });

  it('escalated then approved: waits, picks up the issued authorization, executes', async () => {
    const issued: AuthorizationView = { ...authorization, status: 'ISSUED', spentAt: null, txHash: null };
    const { t, calls } = fakeTransport({
      verdicts: [{ verdict: 'ESCALATE', decisionId: 'dec_1', reservationId: 'r', impact: 'MEDIUM' }],
      listings: [[], [{ ...issued, status: 'ISSUED', sig: undefined }], [issued]],
    });
    let clock = 0;
    const result = await new FlashyOrganization(t).agents.get('ops').wallet.transact('evm:84532', call, {
      waitForDecision: { timeoutMs: 10_000, pollMs: 100 }, now: () => clock, sleep: async (ms) => { clock += ms; },
    });
    expect(result).toMatchObject({ status: 'executed', authorization: { id: 'auth_1' } });
    expect(calls.map((c) => c.method)).toEqual(['propose', 'authorizations', 'authorizations', 'authorizations', 'execute']);
  });

  it('escalated then rejected, or timed out: no execution', async () => {
    const rejected: AuthorizationView = { ...authorization, status: 'REVOKED', spentAt: null, txHash: null };
    const { t } = fakeTransport({ verdicts: [{ verdict: 'ESCALATE', decisionId: 'dec_1', reservationId: 'r', impact: 'MEDIUM' }], listings: [[rejected]] });
    let clock = 0;
    const r1 = await new FlashyOrganization(t).agents.get('ops').wallet.transact('evm:84532', call, { waitForDecision: { timeoutMs: 1000, pollMs: 100 }, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(r1.status).toBe('escalated');
    const { t: t2, calls } = fakeTransport({ verdicts: [{ verdict: 'ESCALATE', decisionId: 'dec_1', reservationId: 'r', impact: 'MEDIUM' }] });
    const r2 = await new FlashyOrganization(t2).agents.get('ops').wallet.transact('evm:84532', call, { waitForDecision: { timeoutMs: 250, pollMs: 100 }, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(r2.status).toBe('escalated');
    expect(calls.filter((c) => c.method === 'execute')).toHaveLength(0);
  });

  it('complete: picks up an issued authorization for a decision and executes; escalated again when nothing is issued', async () => {
    const issued: AuthorizationView = { ...authorization, status: 'ISSUED', spentAt: null, txHash: null };
    const { t, calls } = fakeTransport({ listings: [[issued], []] });
    const agent = new FlashyOrganization(t).agents.get('ops');
    expect(await agent.wallet.complete('dec_1', 'evm:84532', call)).toMatchObject({ status: 'executed', txHash: '0xtx' });
    expect(await agent.wallet.complete('dec_1', 'evm:84532', call)).toMatchObject({ status: 'escalated', decisionId: 'dec_1' });
    expect(calls.map((c) => c.method)).toEqual(['authorizations', 'execute', 'authorizations']);
    expect((await agent.wallet.complete('dec_1', 'evm:84532', { to: USDT, data: '0x095ea7b3' })).status).toBe('unrecognised');
  });

  it('execute: a signer refusal on a mismatched call is a value, and the authorization\'s chain picks the extractor', async () => {
    const { t } = fakeTransport({ execute: async () => ({ ok: false, code: 'MISMATCH', reason: 'no' }) });
    const agent = new FlashyOrganization(t).agents.get('ops');
    expect(await agent.wallet.execute(authorization, { to: USDT, data: calldata('0x7f3c000000000000000000000000000000000099', 25n) })).toMatchObject({ status: 'refused', code: 'MISMATCH' });
    expect((await agent.wallet.execute(authorization, { to: USDT, data: '0x095ea7b3' })).status).toBe('unrecognised');
  });

  it('unrecognised: a call no extractor vouches for never reaches the plane', async () => {
    const { t, calls } = fakeTransport();
    const result = await new FlashyOrganization(t).agents.get('ops').wallet.transact('evm:84532', { to: USDT, data: '0x095ea7b3' });
    expect(result.status).toBe('unrecognised');
    expect(calls).toHaveLength(0);
  });

  it('is chain-agnostic: a TRON transfer and a swap protocol call take the same path', async () => {
    const tronAuth = { ...authorization, chain: 'tron:nile', asset: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', destination: 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9', maxAmount: '5' };
    const { t, calls } = fakeTransport({ verdicts: [{ verdict: 'ALLOW', authorization: tronAuth, decisionId: 'd' }, { verdict: 'ALLOW', authorization: { ...authorization, kind: 'swap', destination: null }, decisionId: 'd' }] });
    const agent = new FlashyOrganization(t).agents.get('ops');
    expect((await agent.wallet.transact('tron:nile', { token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', recipient: 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9', amount: '5' })).status).toBe('executed');
    expect((await agent.wallet.transact('evm:84532', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: 'native', tokenInAmount: '25' } })).status).toBe('executed');
    expect((calls[0].args[1] as { chain: string }).chain).toBe('tron:nile');
    expect((calls[2].args[1] as { kind: string }).kind).toBe('swap');
  });
});

describe('FlashyAgent — authority, memory, partners', () => {
  it('delegates and revokes, records, invoices and settles, each with its event', async () => {
    const { t, calls } = fakeTransport();
    const org = new FlashyOrganization(t);
    const treasury = org.agents.get('treasury');
    const d = await treasury.authority.delegate('ops', { chain: 'evm:84532', kinds: ['transfer'], assets: [USDT], destinations: [VENDOR], perTxMax: '10', dailyMax: '10', autoApproveMax: '10' });
    expect(d).toMatchObject({ agentName: 'ops', delegatedBy: 'treasury', decisionId: 'dec_del' });
    await treasury.authority.revokeDelegation('ops', 'evm:84532');
    expect(await org.agents.get('ops').authority.envelopes()).toHaveLength(1);
    await treasury.memory.record('note', 'notes/today');
    await treasury.partners.invoice({ workBroadcastId: 'wb', chain: 'evm:84532', asset: USDT, amount: '5' });
    await treasury.partners.settle({ invoiceId: 'inv' });
    expect(calls.map((c) => c.method)).toEqual(['delegate', 'revokeDelegation', 'capture', 'invoice', 'settle']);
    expect(org.events.log.map((e) => e.type)).toEqual(['delegation.created', 'delegation.revoked', 'memory.recorded', 'invoice.issued', 'settlement.attempted']);
    expect(org.events.log.every((e) => typeof JSON.stringify(e) === 'string')).toBe(true);
  });

  it('a transport error is thrown, never turned into a verdict', async () => {
    const { t } = fakeTransport({ propose: async () => { throw new TransportError('UNREACHABLE', 0, 'down'); } });
    await expect(new FlashyOrganization(t).agents.get('ops').wallet.propose({ kind: 'transfer', chain: 'evm:84532', asset: USDT, amount: '1', destination: VENDOR })).rejects.toBeInstanceOf(TransportError);
  });

  it('events: listeners by type and wildcard; a throwing listener does not stop the verb; the log is bounded', () => {
    const events = new FlashyEvents({ keep: 3, now: () => new Date('2026-09-20T00:00:00Z') });
    const seen: string[] = [];
    events.on('wallet.denied', () => { throw new Error('listener bug'); });
    const off = events.on('*', (e) => seen.push(e.type));
    events.emit('wallet.denied', 'org', 'a', {});
    events.emit('wallet.allowed', 'org', 'a', {});
    off();
    events.emit('wallet.executed', 'org', 'a', {});
    events.emit('wallet.executed', 'org', 'a', {});
    expect(seen).toEqual(['wallet.denied', 'wallet.allowed']);
    expect(events.log).toHaveLength(3);
    expect(events.log[0].at).toBe('2026-09-20T00:00:00.000Z');
    expect(events.counts()).toEqual({ 'wallet.allowed': 1, 'wallet.executed': 2 });
  });
});

describe('FlashyAgent — meters, external invoices, x402 (Phases 17–19)', () => {
  it('opens, ticks and closes a meter, each with its event', async () => {
    const { t, calls } = fakeTransport();
    const org = new FlashyOrganization(t);
    const agent = org.agents.get('ops');
    const opened = await agent.wallet.meter.open({ chain: 'evm:84532', asset: USDT, provider: VENDOR, unit: 'token', cap: '1000' });
    expect(opened.verdict).toBe('ALLOW');
    const meterId = opened.verdict === 'DENY' ? '' : opened.meter.id;
    await agent.wallet.meter.tick(meterId, { units: '120', amount: '300' });
    const closed = await agent.wallet.meter.close(meterId, { providerUnits: '121', providerAmount: '301' });
    expect(closed.closed).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['openMeter', 'tickMeter', 'closeMeter']);
    expect(calls[1].args).toEqual(['ops', 'm_1', { units: '120', amount: '300' }]);
    expect(org.events.log.map((e) => e.type)).toEqual(['meter.opened', 'meter.ticked', 'meter.closed']);
    expect(org.events.log[2].data).toMatchObject({ meterId: 'm_1', paid: '300' });
  });

  it('a refused close is meter.refused with the difference, and a denied open is wallet.denied', async () => {
    const { t } = fakeTransport({
      closeMeter: async (agentName) => ({ closed: false, meter: meterView({ agentName, status: 'REFUSED', difference: '900' }), code: 'METER_DISAGREE', reason: 'far apart' }),
      openMeter: async () => ({ verdict: 'DENY', code: 'DESTINATION_NOT_PERMITTED', reason: 'not listed' }),
    });
    const org = new FlashyOrganization(t);
    const agent = org.agents.get('ops');
    expect((await agent.wallet.meter.open({ chain: 'evm:84532', asset: USDT, provider: VENDOR, unit: 'token', cap: '1' })).verdict).toBe('DENY');
    const closed = await agent.wallet.meter.close('m_1', { providerUnits: '1', providerAmount: '1200' });
    expect(closed).toMatchObject({ closed: false, code: 'METER_DISAGREE' });
    expect(org.events.counts()).toEqual({ 'wallet.denied': 1, 'meter.refused': 1 });
    expect(org.events.log[1].data).toMatchObject({ difference: '900' });
  });

  it('pays an external SignedInvoice through the plane and emits invoice.paid', async () => {
    const { t, calls } = fakeTransport();
    const org = new FlashyOrganization(t);
    const agent = org.agents.get('procurement');
    const invoice = { version: 1, id: 'inv-9', payee: { name: 'Northwind', publicKey: 'pem' }, chain: 'evm:84532', asset: USDT, amount: '25', destination: VENDOR, memo: 'm', issuedAt: 'a', expiresAt: 'b', sig: 's' };
    const result = await agent.partners.pay(invoice);
    expect(result.verdict.verdict).toBe('ALLOW');
    expect(calls[0]).toEqual({ method: 'settleExternal', args: ['procurement', invoice] });
    expect(org.events.log[0]).toMatchObject({ type: 'invoice.paid', agentName: 'procurement', data: { invoiceId: 'inv-9', payee: 'Northwind', status: 'AUTHORIZED', verdict: 'ALLOW' } });
    expect(await agent.partners.receipt('inv-9')).toBeNull();
  });

  it('answers a 402: challenge → bounded record → plane → signer → X-PAYMENT header, with payment.signed', async () => {
    const usdc = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
    const { t, calls } = fakeTransport({ verdicts: [{ verdict: 'ALLOW', authorization: { ...authorization, asset: usdc, maxAmount: '10000' }, decisionId: 'dec_x' }] });
    const org = new FlashyOrganization(t);
    const agent = org.agents.get('ops');
    const challenge = { x402Version: 1, accepts: [{ scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000', payTo: VENDOR, asset: usdc, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }] };
    const from = '0x1111111111111111111111111111111111111111';
    const nonce = '0x' + '77'.repeat(32);
    const result = await agent.wallet.pay402(challenge, from, { nonce, now: () => Date.parse('2026-09-20T10:00:00Z') });
    expect(result.status).toBe('signed');
    if (result.status !== 'signed') return;
    expect(result.record).toMatchObject({ kind: 'transfer', chain: 'evm:84532', asset: usdc, amount: '10000', destination: VENDOR });
    expect(result.reference).toBe(`eip3009:${nonce}`);
    const decoded = JSON.parse(Buffer.from(result.header, 'base64').toString('utf8'));
    expect(decoded.payload.authorization).toMatchObject({ from, to: VENDOR, value: '10000', nonce });
    expect(calls.map((c) => c.method)).toEqual(['propose', 'signTypedData']);
    expect(org.events.log.map((e) => e.type)).toEqual(['wallet.proposed', 'wallet.allowed', 'payment.signed']);
  });

  it('a mainnet 402 is unrecognised before the plane is asked; a denied one is denied; a refused signature is refused', async () => {
    const usdc = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
    const accept = { scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000', payTo: VENDOR, asset: usdc };
    const from = '0x1111111111111111111111111111111111111111';
    const { t, calls } = fakeTransport({
      verdicts: [{ verdict: 'DENY', code: 'DESTINATION_NOT_PERMITTED', reason: 'no' }, { verdict: 'ALLOW', authorization: { ...authorization, asset: usdc, maxAmount: '10000' }, decisionId: 'd' }],
      signTypedData: async () => ({ ok: false, code: 'TYPED_DATA_UNSUPPORTED', reason: 'seed signer' }),
    });
    const agent = new FlashyOrganization(t).agents.get('ops');
    const mainnet = await agent.wallet.pay402({ x402Version: 1, accepts: [{ ...accept, network: 'base' }] }, from);
    expect(mainnet).toMatchObject({ status: 'unrecognised', reason: expect.stringContaining('MAINNET_NOT_ENABLED') });
    expect(calls).toHaveLength(0);
    expect(await agent.wallet.pay402({ x402Version: 1, accepts: [accept] }, from)).toMatchObject({ status: 'denied', code: 'DESTINATION_NOT_PERMITTED' });
    expect(await agent.wallet.pay402({ x402Version: 1, accepts: [accept] }, from)).toMatchObject({ status: 'refused', code: 'TYPED_DATA_UNSUPPORTED' });
  });

  it('the organization assigns identities and reads the plan, meters, external settlements and the public key', async () => {
    const { t, calls } = fakeTransport();
    const org = new FlashyOrganization(t);
    const identity = await org.identities.assign('ops', 'evm');
    expect(identity.accountIndex).toBe(1);
    const plan = await org.identities.plan({ safeAddress: '0x1', moduleAddress: '0x2', token: USDT, chain: 'evm:84532' });
    expect(plan.plan.version).toBe(1);
    expect(await org.meters()).toEqual([]);
    expect(await org.externalSettlements()).toEqual([]);
    expect((await org.publicKey()).algorithm).toBe('Ed25519');
    expect(calls.map((c) => c.method)).toEqual(['assignIdentity', 'allowancePlan']);
    expect(org.events.log[0]).toMatchObject({ type: 'identity.assigned', agentName: 'ops', data: { family: 'evm', accountIndex: 1 } });
  });

  it('the organization exports and seals its provenance and opts into the network', async () => {
    const { t, calls } = fakeTransport();
    const org = new FlashyOrganization(t);
    expect(await org.provenance.export()).toEqual([]);
    const seal = await org.provenance.seal();
    expect(seal.anchorCalldata).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await org.network.share(true)).toEqual({ share: true });
    expect((await org.network.summary()).contributing).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(['seal', 'setWalletSharing']);
    expect(org.events.log[0]).toMatchObject({ type: 'provenance.sealed', data: { seq: 1, entries: 3 } });
  });
});

describe('federation (Phases 23–26)', () => {
  it('the organization reads the plane document, trusts and revokes a plane, rotates its key, and reads the money page', async () => {
    const { t, calls } = fakeTransport();
    const org = new FlashyOrganization(t);
    expect((await org.trust.plane()).keys[0].status).toBe('active');
    const trusted = await org.trust.add({ name: 'partner-plane', publicKey: 'pem' });
    expect(trusted[0].name).toBe('partner-plane');
    await org.trust.revoke('tp');
    expect((await org.keys.list())[0].active).toBe(true);
    expect((await org.keys.rotate()).kid).toBe('b'.repeat(64));
    expect(await org.money(14)).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(['trustPlane', 'revokeTrustedPlane', 'rotateSigningKey', 'moneyPage']);
    expect(calls[3].args).toEqual([14]);
    expect(org.events.log.map((e) => e.type)).toEqual(['plane.trusted', 'plane.revoked', 'key.rotated']);
  });

  it('an agent issues a signed invoice, presents a receipt, builds a 402 and records a settlement, each with its event', async () => {
    const { t, calls } = fakeTransport();
    const org = new FlashyOrganization(t);
    const agent = org.agents.get('billing');
    const invoice = await agent.partners.issueSignedInvoice({ chain: 'evm:84532', asset: USDT, amount: '250', memo: 'September' });
    expect(invoice.status).toBe('ISSUED');
    await agent.partners.voidInvoice('ob');
    const accepted = await agent.partners.acceptReceipt({ version: 1, invoiceId: 'acme-1' });
    expect(accepted.verifiedUnder.name).toBe('partner-plane');
    const challenge = await agent.partners.x402Challenge({ chain: 'evm:84532', asset: USDT, amount: '5000', resource: 'https://api.acme/report' });
    expect(challenge.accepts[0].payTo).toBe(VENDOR);
    const payment = await agent.partners.recordX402Settlement({ payment: 'aGVhZGVy', asset: USDT, txHash: '0xfac', outcome: 'CONFIRMED' });
    expect(payment.amount).toBe('5000');
    expect(calls.map((c) => c.method)).toEqual(['issueSignedInvoice', 'voidOutboundInvoice', 'acceptReceipt', 'x402Challenge', 'recordX402Settlement']);
    expect(org.events.log.map((e) => e.type)).toEqual(['invoice.signed', 'invoice.voided', 'receipt.accepted', 'x402.received']);
    expect(org.events.log[2].data).toMatchObject({ invoiceId: 'acme-1', verifiedUnder: { source: 'registry' } });
  });
});
