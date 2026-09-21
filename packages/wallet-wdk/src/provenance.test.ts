import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { anchorCalldata, canonicalRoot, chainEntries, exportRoot, metricsFromExport, parseExport, verifyExport, type ProvenanceRootPayload } from './provenance';

const facts = [
  { at: '2026-09-21T09:00:00.000Z', kind: 'decision' as const, id: 'd1', data: { kind: 'wallet.spend', impact: 'LOW', summary: 'Spend: 5' } },
  { at: '2026-09-21T09:00:01.000Z', kind: 'capture' as const, id: 'c1', data: { sourcePath: 'wallet/deny', body: '{"reason":"over"}' } },
  { at: '2026-09-21T09:00:02.000Z', kind: 'decision' as const, id: 'd2', data: { kind: 'wallet.spend', impact: 'MEDIUM', summary: 'Spend: 500' } },
  { at: '2026-09-21T09:00:03.000Z', kind: 'settlement' as const, id: 's1', data: { status: 'SETTLED', settledAt: '2026-09-21T09:00:33.000Z' } },
  { at: '2026-09-21T09:00:04.000Z', kind: 'settlement-in' as const, id: 's2', data: { status: 'SETTLED' } },
];

describe('the hash chain', () => {
  it('chains, verifies, and yields a stable root and JSONL round trip', () => {
    const entries = chainEntries(facts);
    expect(entries[0].prev).toBe('0'.repeat(64));
    expect(entries[1].prev).toBe(entries[0].hash);
    const check = verifyExport(entries);
    expect(check).toEqual({ ok: true, entries: 5, root: exportRoot(entries) });
    const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
    expect(verifyExport(jsonl)).toEqual(check);
    expect(parseExport(JSON.stringify(entries))).toEqual(entries);
    expect(chainEntries(facts)).toEqual(entries);
    expect(anchorCalldata(check.ok ? check.root! : '')).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('names the altered entry: one character changed in the data, a hash, a prev, or a seq', () => {
    const entries = chainEntries(facts);
    const altered = entries.map((e, i) => (i === 2 ? { ...e, data: { ...e.data, summary: 'Spend: 5000' } } : e));
    expect(verifyExport(altered)).toMatchObject({ ok: false, code: 'HASH_MISMATCH', seq: 2 });
    const rehashed = [...entries.slice(0, 3), { ...entries[3], hash: 'ab'.repeat(32) }, entries[4]];
    expect(verifyExport(rehashed)).toMatchObject({ ok: false, code: 'HASH_MISMATCH', seq: 3 });
    const dropped = chainEntries(facts).filter((_, i) => i !== 1).map((e, i) => ({ ...e, seq: i }));
    expect(verifyExport(dropped)).toMatchObject({ ok: false, code: 'CHAIN_BROKEN', seq: 1 });
    const gap = entries.map((e, i) => (i === 4 ? { ...e, seq: 9 } : e));
    expect(verifyExport(gap)).toMatchObject({ ok: false, code: 'SEQ_GAP', seq: 4 });
    expect(verifyExport('not json')).toMatchObject({ ok: false, code: 'MALFORMED' });
  });

  it('checks the sealed root and its signature under the plane key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const entries = chainEntries(facts);
    const payload: ProvenanceRootPayload = { version: 1, org: 'acme', seq: 1, entries: entries.length, through: entries[4].at, root: exportRoot(entries)! };
    const sealed = { ...payload, sig: sign(null, canonicalRoot(payload), privateKey).toString('base64url') };
    expect(verifyExport(entries, { root: sealed, publicKey: pub })).toMatchObject({ ok: true });
    expect(verifyExport(entries, { root: { ...sealed, root: 'ff'.repeat(32) }, publicKey: pub })).toMatchObject({ ok: false, code: 'ROOT_MISMATCH' });
    expect(verifyExport(entries, { root: { ...sealed, sig: sealed.sig.replace(/^./, 'A') }, publicKey: pub })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyExport(entries, { root: sealed })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyExport(entries, { root: sealed, publicKey: other })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyExport(entries.slice(0, 4), { root: sealed, publicKey: pub })).toMatchObject({ ok: false, code: 'ROOT_MISMATCH' });
  });
});

describe('metrics re-derived from the export', () => {
  it('counts writes, asks, refusals, settlements and latency the way the plane does', () => {
    const m = metricsFromExport(chainEntries(facts), { since: '2026-09-21T00:00:00.000Z', until: '2026-09-22T00:00:00.000Z' });
    expect(m).toEqual({
      writes: 3, proposalsAllowed: 1, proposalsEscalated: 1, proposalsRefused: 1, humanAsks: 1, humanAsksPerHundredWrites: 33.33,
      reasonedOutcomes: 3, reasonCoverage: 1,
      settlementsPaid: { attempted: 1, settled: 1, reverted: 0, refused: 0, pending: 0 }, settlementsReceived: 1,
      settlementLatencySeconds: { mean: 30, median: 30, samples: 1 },
    });
    expect(metricsFromExport(chainEntries(facts), { since: '2027-01-01T00:00:00.000Z', until: '2027-01-02T00:00:00.000Z' }).writes).toBe(0);
  });
});
