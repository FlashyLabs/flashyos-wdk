// Phase 20 — the export, and the verifier anyone can run.
//
// An organization's wallet history leaves the plane as a hash chain: one
// JSON entry per fact (a decision, a capture, an authorization, a
// settlement, a meter), each carrying the hash of the entry before it and
// its own hash over everything but the hash. A Merkle root over the entries
// is signed by the plane's authorization key and, optionally, anchored on
// a chain by a person. Given the export, the root and the public key, this
// file checks all of it without FlashyOS being reachable — and re-derives
// the weekly metrics from the export, so the numbers the plane reports are
// numbers a counterparty can recompute.
//
// The Merkle construction is the brain's (packages/api/src/lib/mind/merkle.ts):
// leaf and node prefixes for domain separation, leaves sorted by key, an odd
// node promoted. A test in the API keeps the two implementations equal.

import { createHash, createPublicKey, verify } from 'crypto';

export type ProvenanceKind = 'decision' | 'capture' | 'authorization' | 'settlement' | 'settlement-in' | 'external-settlement' | 'meter';

export interface ProvenanceEntryPayload {
  /** Position in the export, from 0. */
  seq: number;
  /** ISO time the fact was recorded. */
  at: string;
  kind: ProvenanceKind;
  /** The row's id. */
  id: string;
  data: Record<string, unknown>;
  /** The previous entry's hash; 64 zeros for the first. */
  prev: string;
}

export interface ProvenanceEntry extends ProvenanceEntryPayload {
  /** sha256 of the canonical payload, hex. */
  hash: string;
}

export const GENESIS = '0'.repeat(64);

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function canonicalEntry(entry: ProvenanceEntryPayload): Buffer {
  const { seq, at, kind, id, data, prev } = entry;
  return Buffer.from(JSON.stringify(sortKeys({ seq, at, kind, id, data, prev })), 'utf8');
}

export function entryHash(entry: ProvenanceEntryPayload): string {
  return createHash('sha256').update(canonicalEntry(entry)).digest('hex');
}

/** Chains bare facts, in the order given, into entries with prev and hash. */
export function chainEntries(facts: { at: string; kind: ProvenanceKind; id: string; data: Record<string, unknown> }[]): ProvenanceEntry[] {
  const out: ProvenanceEntry[] = [];
  let prev = GENESIS;
  facts.forEach((f, seq) => {
    const payload: ProvenanceEntryPayload = { seq, at: f.at, kind: f.kind, id: f.id, data: f.data, prev };
    const hash = entryHash(payload);
    out.push({ ...payload, hash });
    prev = hash;
  });
  return out;
}

// ─── Merkle (the brain's construction) ───────────────────────────────────────

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);
const sha256 = (...parts: Buffer[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};
export const leafHash = (key: string, contentHash: string) => sha256(LEAF_PREFIX, Buffer.from(`${key}\0${contentHash}`, 'utf8'));
const nodeHash = (l: string, r: string) => sha256(NODE_PREFIX, Buffer.from(l, 'hex'), Buffer.from(r, 'hex'));

export const entryKey = (e: Pick<ProvenanceEntry, 'kind' | 'id'>) => `${e.kind}:${e.id}`;

/** The Merkle root over an export: leaves keyed `<kind>:<id>` with the entry hash as content. Null for an empty export. */
export function exportRoot(entries: ProvenanceEntry[]): string | null {
  const leaves = entries.map((e) => ({ key: entryKey(e), hash: leafHash(entryKey(e), e.hash) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (leaves.length === 0) return null;
  let level = leaves.map((l) => l.hash);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

// ─── The signed root ─────────────────────────────────────────────────────────

export interface ProvenanceRootPayload {
  version: 1;
  org: string;
  seq: number;
  entries: number;
  /** ISO time of the last entry covered. */
  through: string;
  root: string;
}

export interface SignedProvenanceRoot extends ProvenanceRootPayload {
  /** base64url(ed25519(canonical payload)) under the plane's authorization key. */
  sig: string;
}

export function canonicalRoot(r: ProvenanceRootPayload): Buffer {
  const { version, org, seq, entries, through, root } = r;
  return Buffer.from(JSON.stringify(sortKeys({ version, org, seq, entries, through, root })), 'utf8');
}

/** The 32 bytes a person anchors on a chain — as calldata of any transaction they choose to send. */
export const anchorCalldata = (root: string) => `0x${root}`;

// ─── The verifier ────────────────────────────────────────────────────────────

export type ExportCheck =
  | { ok: true; entries: number; root: string | null }
  | { ok: false; code: 'MALFORMED' | 'HASH_MISMATCH' | 'CHAIN_BROKEN' | 'SEQ_GAP' | 'ROOT_MISMATCH' | 'BAD_SIGNATURE' | 'NOT_ORDERED'; seq?: number; detail: string };

const HEX64 = /^[0-9a-f]{64}$/;

/** Parses JSONL or a JSON array into entries, without checking anything. */
export function parseExport(text: string): ProvenanceEntry[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as ProvenanceEntry[];
  return trimmed.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ProvenanceEntry);
}

/**
 * Every entry's hash recomputes; every prev is the previous hash; seqs are
 * contiguous; times never go backwards. With `root` given, the Merkle root
 * matches; with a signed root and the plane's public key, the signature
 * verifies. One altered character anywhere is a refusal that names the
 * entry.
 */
export function verifyExport(input: string | ProvenanceEntry[], options: { root?: SignedProvenanceRoot | { root: string }; publicKey?: string } = {}): ExportCheck {
  let entries: ProvenanceEntry[];
  try {
    entries = typeof input === 'string' ? parseExport(input) : input;
  } catch (err) {
    return { ok: false, code: 'MALFORMED', detail: (err as Error).message };
  }
  let prev = GENESIS;
  let lastAt = '';
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || typeof e !== 'object' || typeof e.hash !== 'string' || typeof e.prev !== 'string' || typeof e.at !== 'string' || typeof e.id !== 'string' || !e.data) {
      return { ok: false, code: 'MALFORMED', seq: i, detail: `entry ${i} is not a provenance entry` };
    }
    if (e.seq !== i) return { ok: false, code: 'SEQ_GAP', seq: i, detail: `entry ${i} carries seq ${e.seq}` };
    if (e.prev !== prev) return { ok: false, code: 'CHAIN_BROKEN', seq: i, detail: `entry ${i} names prev ${e.prev.slice(0, 12)}…, expected ${prev.slice(0, 12)}…` };
    if (!HEX64.test(e.hash) || entryHash(e) !== e.hash) return { ok: false, code: 'HASH_MISMATCH', seq: i, detail: `entry ${i} (${entryKey(e)}) does not hash to what it claims` };
    if (e.at < lastAt) return { ok: false, code: 'NOT_ORDERED', seq: i, detail: `entry ${i} is dated before entry ${i - 1}` };
    lastAt = e.at;
    prev = e.hash;
  }
  const root = exportRoot(entries);
  if (options.root) {
    if (options.root.root !== root) return { ok: false, code: 'ROOT_MISMATCH', detail: `the export's root is ${root ?? 'null'}; the sealed root is ${options.root.root}` };
    if ('sig' in options.root) {
      if (!options.publicKey) return { ok: false, code: 'BAD_SIGNATURE', detail: 'a signed root needs the plane\'s public key to verify' };
      if (options.root.entries !== entries.length) return { ok: false, code: 'ROOT_MISMATCH', detail: `the sealed root covers ${options.root.entries} entries; the export has ${entries.length}` };
      try {
        const ok = verify(null, canonicalRoot(options.root), createPublicKey(options.publicKey), Buffer.from(options.root.sig, 'base64url'));
        if (!ok) return { ok: false, code: 'BAD_SIGNATURE', detail: 'the sealed root does not verify under the given key' };
      } catch (err) {
        return { ok: false, code: 'BAD_SIGNATURE', detail: (err as Error).message };
      }
    }
  }
  return { ok: true, entries: entries.length, root };
}

// ─── Metrics, re-derived ─────────────────────────────────────────────────────

export interface ExportMetrics {
  writes: number;
  proposalsAllowed: number;
  proposalsEscalated: number;
  proposalsRefused: number;
  humanAsks: number;
  humanAsksPerHundredWrites: number | null;
  reasonedOutcomes: number;
  reasonCoverage: number | null;
  settlementsPaid: { attempted: number; settled: number; reverted: number; refused: number; pending: number };
  settlementsReceived: number;
  settlementLatencySeconds: { mean: number | null; median: number | null; samples: number };
}

const median = (v: number[]) => {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The same arithmetic as the plane's walletMetrics, over the export instead
 * of the database: wallet.spend decisions and wallet/deny captures are the
 * writes; escalations are the human asks; settlements paid and received
 * and their latency. `since` inclusive, `until` exclusive, on `at`.
 */
export function metricsFromExport(entries: ProvenanceEntry[], window: { since: string; until: string }): ExportMetrics {
  const inWindow = entries.filter((e) => e.at >= window.since && e.at < window.until);
  const decisions = inWindow.filter((e) => e.kind === 'decision' && e.data.kind === 'wallet.spend');
  const denials = inWindow.filter((e) => e.kind === 'capture' && e.data.sourcePath === 'wallet/deny');
  const proposalsEscalated = decisions.filter((d) => d.data.impact !== 'LOW').length;
  const writes = decisions.length + denials.length;
  const reasonedOutcomes = decisions.filter((d) => String(d.data.summary ?? '').trim().length > 0).length + denials.filter((d) => String(d.data.body ?? '').includes('"reason"')).length;
  const paid = inWindow.filter((e) => e.kind === 'settlement');
  const received = inWindow.filter((e) => e.kind === 'settlement-in' && e.data.status === 'SETTLED').length;
  const latencies = paid.filter((s) => s.data.status === 'SETTLED' && s.data.settledAt).map((s) => (Date.parse(String(s.data.settledAt)) - Date.parse(s.at)) / 1000);
  return {
    writes,
    proposalsAllowed: decisions.length - proposalsEscalated,
    proposalsEscalated,
    proposalsRefused: denials.length,
    humanAsks: proposalsEscalated,
    humanAsksPerHundredWrites: writes === 0 ? null : Math.round((proposalsEscalated / writes) * 10_000) / 100,
    reasonedOutcomes,
    reasonCoverage: writes === 0 ? null : reasonedOutcomes / writes,
    settlementsPaid: {
      attempted: paid.length,
      settled: paid.filter((s) => s.data.status === 'SETTLED').length,
      reverted: paid.filter((s) => s.data.status === 'REVERTED').length,
      refused: paid.filter((s) => s.data.status === 'REFUSED').length,
      pending: paid.filter((s) => s.data.status === 'AUTHORIZED' || s.data.status === 'ESCALATED').length,
    },
    settlementsReceived: received,
    settlementLatencySeconds: { mean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null, median: median(latencies), samples: latencies.length },
  };
}
