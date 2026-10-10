import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { SignedSpendAuthorization, SignerCall } from '@flashyos/wallet-wdk';
import { Signer, type ExecuteResult, type SettlementReporter } from './signer';
import { MockChain, type ChainBackend, type ChainResult } from './chain';
import { FileNonceStore, type NonceStore } from './nonces';
import { canonicalize } from './verify';
import { expectViolation, property, type Applied, type PropertyCommand } from '../vendor-invariants.mjs';

// Recovery. Every other suite here runs inside one process; this one kills
// it. A "process" is a Signer over a FileNonceStore; a "kill" is dropping
// that Signer with a call still in flight; a "restart" is a new Signer over
// the same nonce file, reopened from disk. What must survive the gap is one
// fact — which authorizations have been consumed — and I-6 in INVARIANTS.md
// says what follows from it: an authorization the previous process spent is
// refused by the next, whatever the previous process managed to do with it.
// Stranded, never doubled.

// ── fixtures: the same shape the invariants suite uses, on Base Sepolia ─────

const CHAIN = 'evm:84532';
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const PAY_TO = '0x7f3c000000000000000000000000000000000009';
const START = () => new Date('2026-09-20T10:02:00Z');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const planePublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function issue(id: string, maxAmount = '10000'): SignedSpendAuthorization {
  const payload = {
    id, orgId: 'org_1', agentName: 'research-ops', chain: CHAIN, kind: 'transfer' as const,
    asset: USDC, maxAmount, destination: PAY_TO, reservationId: 'rsv_1', decisionId: 'dec_1',
    issuedAt: '2026-09-20T10:00:00.000Z', expiresAt: '2026-09-20T10:05:00.000Z',
  };
  return { ...payload, sig: sign(null, canonicalize({ ...payload, sig: '' }), privateKey).toString('base64url') };
}

const transferData = (to: string, amount: bigint) => '0xa9059cbb' + to.replace(/^0x/, '').padStart(64, '0') + amount.toString(16).padStart(64, '0');
/** An ERC-20 transfer of exactly `amount` to the authorized payee. */
const callFor = (amount: string): SignerCall => ({ to: USDC, data: transferData(PAY_TO, BigInt(amount)) });

/** A nonce file that does not exist yet, in a directory that does not exist yet — the way a first boot finds it. */
const freshPath = () => join(mkdtempSync(join(tmpdir(), 'signer-recovery-')), 'spent', 'nonces.txt');

/** The bytes a crash mid-append leaves behind: written through one descriptor, fsync'd, no newline. */
function tearTail(path: string, fragment: string) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try { writeSync(fd, fragment, null, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
}

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── the process model ───────────────────────────────────────────────────────

/** One signer process: the store reopened from disk, a Signer over it. Nothing else carries over. */
function boot(path: string, chain: ChainBackend, settlement?: SettlementReporter) {
  const store = new FileNonceStore(path);
  const signer = new Signer({ planePublicKeyPem, chains: [chain], nonces: store, now: START, settlement });
  return { signer, store };
}

/** A backend that is asked and never answers — the process dies with the call in flight. */
class HangingChain implements ChainBackend {
  readonly chain = CHAIN;
  asked = 0;
  execute(): Promise<ChainResult> {
    this.asked += 1;
    return new Promise<ChainResult>(() => {});
  }
}

// ── 1. killed between spend and broadcast ───────────────────────────────────

describe('killed between spend and broadcast', () => {
  it('killed between spend and broadcast: the next process over the same nonce file refuses the authorization as REPLAY, with zero broadcasts — stranded, never doubled', async () => {
    const path = freshPath();
    const hung = new HangingChain();
    const reported: string[] = [];
    const first = boot(path, hung, { report: async (a) => { reported.push(a.id); } });
    const authorization = issue('auth_killed');
    const call = callFor('10000');

    // The call reaches the backend and the backend never answers. The spend
    // has already happened — `spend` returns only after the fsync, and the
    // signer asks the backend only after `spend` — so the file holds the id
    // before anything could have been broadcast.
    const inFlight = first.signer.execute({ authorization, call });
    expect(await Promise.race([inFlight.then(() => 'settled'), tick(20).then(() => 'still in flight')])).toBe('still in flight');
    expect(hung.asked).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('auth_killed\n');
    expect(reported).toEqual([]);

    // What the first process holds about the attempt, read from the code and
    // not from what one would wish: `pendingExecutions` is filled by the
    // `catch` around the backend, and a backend that hangs throws nothing, so
    // the array is EMPTY. A kill would lose the array anyway — it is memory.
    // The record of the stranded attempt that survives the kill is the line
    // in the nonce file: an id spent with no settlement report behind it,
    // which the plane's nightly sweep releases and an operator reconciles
    // against the chain.
    expect(first.signer.pendingExecutions).toEqual([]);
    expect(first.signer.unreportedSettlements).toEqual([]);

    // The process dies here: the Signer is dropped, the promise never settles.
    const recording = new MockChain({ chain: CHAIN });
    const second = boot(path, recording);
    expect(second.store.size).toBe(1);
    expect(await second.signer.execute({ authorization, call })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect(await second.signer.execute({ authorization, call })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect(recording.executions).toHaveLength(0);
    expect(hung.asked).toBe(1);
    expect(second.signer.pendingExecutions).toEqual([]);
  });
});

// ── 2. restart and replay, k authorizations ─────────────────────────────────

describe('restart and replay', () => {
  it('after k executions and a restart, every one of the k replays is REPLAY with zero new broadcasts, and a fresh authorization executes exactly once', async () => {
    const k = 5;
    const path = freshPath();
    const chain = new MockChain({ chain: CHAIN });
    const auths = Array.from({ length: k }, (_, i) => issue(`auth_${i}`, String(10_000 + i)));
    const callOf = (a: SignedSpendAuthorization) => callFor(a.maxAmount);

    const before = boot(path, chain);
    for (const a of auths) expect((await before.signer.execute({ authorization: a, call: callOf(a) })).ok).toBe(true);
    expect(chain.executions).toHaveLength(k);
    expect(readFileSync(path, 'utf8')).toBe(auths.map((a) => `${a.id}\n`).join(''));

    const after = boot(path, chain);
    expect(after.store.size).toBe(k);
    const replays = await Promise.all(auths.map((a) => after.signer.execute({ authorization: a, call: callOf(a) })));
    expect(replays.map((r) => (r.ok ? 'ok' : r.code))).toEqual(Array.from({ length: k }, () => 'REPLAY'));
    expect(chain.executions).toHaveLength(k);

    const fresh = issue(`auth_${k}`, String(10_000 + k));
    expect((await after.signer.execute({ authorization: fresh, call: callOf(fresh) })).ok).toBe(true);
    expect(await after.signer.execute({ authorization: fresh, call: callOf(fresh) })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect(chain.executions).toHaveLength(k + 1);
    expect(chain.executions.map((e) => e.record.amount)).toEqual([...auths, fresh].map((a) => a.maxAmount));
    expect(new FileNonceStore(path).size).toBe(k + 1);
  });
});

// ── 3. a torn write ─────────────────────────────────────────────────────────

describe('a torn write', () => {
  // What `FileNonceStore`'s constructor does with the file, read from the
  // code: every line is trimmed, and every non-empty result is loaded as a
  // spent id. A crash mid-append leaves a trailing fragment with no newline;
  // the constructor loads that fragment as a spent id of its own. It can only
  // ever be a prefix of the id whose spend did not complete — and that spend
  // did not complete, so `spend` never returned and nothing was broadcast.

  it('a torn tail: the fragment loads as an inert spent id and the real id, whose spend never returned, executes exactly once', async () => {
    const path = freshPath();
    tearTail(path, 'auth_tor'); // the first eight bytes of `auth_torn`, then the crash

    const chain = new MockChain({ chain: CHAIN });
    const { signer, store } = boot(path, chain);
    expect(store.size).toBe(1);
    expect(await store.has('auth_tor')).toBe(true); // inert: no authorization carries this id
    expect(await store.has('auth_torn')).toBe(false); // the spend that was torn never returned, so it never happened

    const authorization = issue('auth_torn');
    const call = callFor('10000');
    expect((await signer.execute({ authorization, call })).ok).toBe(true);
    expect(await signer.execute({ authorization, call })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect(chain.executions).toHaveLength(1);
  });

  it('regression: a spend appended after a torn tail is still spent on the next restart — the fragment and the id never merge into one line', async () => {
    // Found writing this suite. The store appended `${id}\n` directly after
    // the fragment, so `auth_tor` + `auth_torn\n` read back as ONE line,
    // `auth_torauth_torn`, and the id whose spend had returned true — fsync'd,
    // broadcast — was unspent two restarts later. A replay then executed.
    const path = freshPath();
    tearTail(path, 'auth_tor');

    const chain = new MockChain({ chain: CHAIN });
    const authorization = issue('auth_torn');
    const call = callFor('10000');
    const second = boot(path, chain);
    expect((await second.signer.execute({ authorization, call })).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('auth_tor\nauth_torn\n');

    const third = boot(path, chain);
    expect(await third.store.has('auth_torn')).toBe(true);
    expect(await third.signer.execute({ authorization, call })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect(chain.executions).toHaveLength(1);
  });

  it('a fragment that happens to spell another real id strands that authorization, and never doubles any', async () => {
    // `auth_1` is a prefix of `auth_10`. A crash mid-append of `auth_10` can
    // leave `auth_1` on disk, and the store will then refuse `auth_1` though
    // it was never spent. That is the safe direction: a stranded authorization
    // is recoverable (the plane's sweep releases its budget) and a doubled one
    // is not. The torn `auth_10` itself executes exactly once.
    const path = freshPath();
    tearTail(path, 'auth_1');

    const chain = new MockChain({ chain: CHAIN });
    const { signer } = boot(path, chain);
    const one = issue('auth_1', '10001');
    const ten = issue('auth_10', '10010');
    expect(await signer.execute({ authorization: one, call: callFor('10001') })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect((await signer.execute({ authorization: ten, call: callFor('10010') })).ok).toBe(true);
    expect(await signer.execute({ authorization: ten, call: callFor('10010') })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect(chain.executions.map((e) => e.record.amount)).toEqual(['10010']);

    const again = boot(path, chain);
    expect(await again.signer.execute({ authorization: one, call: callFor('10001') })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect(await again.signer.execute({ authorization: ten, call: callFor('10010') })).toMatchObject({ ok: false, code: 'REPLAY' });
    expect(chain.executions).toHaveLength(1);
  });
});

// ── 4. the property: execute and restart, mixed ─────────────────────────────

const IDS = ['auth_a', 'auth_b', 'auth_c'] as const;
type Id = (typeof IDS)[number];
/** Distinct amounts per authorization, so a record the backend received names the authorization it came from. */
const AMOUNT: Record<Id, string> = { auth_a: '10000', auth_b: '10001', auth_c: '10002' };
const idOfAmount = (amount: string): string => IDS.find((id) => AMOUNT[id] === amount) ?? `?${amount}`;

/** A store that remembers in memory only and writes nothing — what a signer on `MemoryNonceStore` restarts into. */
class VolatileNonceStore implements NonceStore {
  private readonly spent = new Set<string>();
  constructor(_path: string) {}
  async has(id: string) { return this.spent.has(id); }
  async add(id: string) { this.spent.add(id); }
  async spend(id: string) { if (this.spent.has(id)) return false; this.spent.add(id); return true; }
}

interface Processes {
  /** The chain outlives every process: what was broadcast stays broadcast. */
  chain: MockChain;
  path: string;
  /** The current process. */
  signer: Signer;
  store: NonceStore;
  restarts: number;
  auths: Record<Id, SignedSpendAuthorization>;
  calls: Record<Id, SignerCall>;
}

/** Counts across every run, so the suite can show the property was not vacuous. */
interface Seen { restarts: number; replaysAfterRestart: number }

function processes(seen: Seen, variant: { volatile?: boolean } = {}): Processes & { restart(): void } {
  const path = freshPath();
  const chain = new MockChain({ chain: CHAIN });
  const open = (): NonceStore => (variant.volatile ? new VolatileNonceStore(path) : new FileNonceStore(path));
  const by = <T>(f: (id: Id) => T) => Object.fromEntries(IDS.map((id) => [id, f(id)])) as Record<Id, T>;
  const sys: Processes & { restart(): void } = {
    chain, path, restarts: 0,
    store: open(),
    signer: undefined as unknown as Signer,
    auths: by((id) => issue(id, AMOUNT[id])),
    calls: by((id) => callFor(AMOUNT[id])),
    restart() {
      // A new process: the store reopened from whatever is on disk, a new
      // Signer over it. The old Signer, and everything it held in memory,
      // is gone.
      sys.store = open();
      sys.signer = new Signer({ planePublicKeyPem, chains: [chain], nonces: sys.store, now: START });
      sys.restarts += 1;
      seen.restarts += 1;
    },
  };
  sys.signer = new Signer({ planePublicKeyPem, chains: [chain], nonces: sys.store, now: START });
  return sys;
}

const commands = (seen: Seen): PropertyCommand<Processes & { restart(): void }, { id?: Id }>[] => [
  {
    name: 'execute',
    gen: (r) => ({ id: r.pick(IDS) }),
    run: async (w, { id }) => {
      const res = await w.signer.execute({ authorization: w.auths[id!], call: w.calls[id!] });
      if (w.restarts > 0 && !res.ok && res.code === 'REPLAY') seen.replaysAfterRestart += 1;
      return res;
    },
  },
  { name: 'restart', gen: () => ({}), run: (w) => { w.restart(); } },
];

/**
 * After every command, across every process so far: each authorization was
 * broadcast at most once and succeeded at most once; every id the chain has
 * broadcast is held spent by the CURRENT store, however many restarts ago it
 * was spent; and a store reopened from the file right now agrees with it.
 */
async function strandedNeverDoubled(w: Processes, { applied }: { applied: Applied[] }): Promise<string[]> {
  const reasons: string[] = [];
  const broadcast = w.chain.executions.map((e) => idOfAmount(e.record.amount));
  for (const id of IDS) { const n = broadcast.filter((b) => b === id).length; if (n > 1) reasons.push(`${id} was broadcast ${n} times across ${w.restarts + 1} process(es)`); }

  const okPer = new Map<string, number>();
  for (const a of applied) {
    if (a.name !== 'execute') continue;
    if (a.error) { reasons.push(`execute ${(a.args as { id: Id }).id} threw: ${a.error}`); continue; }
    const res = a.result as ExecuteResult;
    if (res.ok) { const id = (a.args as { id: Id }).id; okPer.set(id, (okPer.get(id) ?? 0) + 1); }
  }
  for (const [id, n] of okPer) if (n > 1) reasons.push(`${id} succeeded ${n} times`);

  for (const id of new Set(broadcast)) if (!(await w.store.has(id))) reasons.push(`${id} was broadcast and the current process does not hold it spent`);
  return reasons;
}

describe('across restarts', () => {
  it('under random execute and restart sequences over one nonce file: broadcasts per authorization never exceed one across every process, and the current process holds every broadcast id spent', async () => {
    const seen: Seen = { restarts: 0, replaysAfterRestart: 0 };
    const r = await property({
      setup: () => processes(seen),
      commands: commands(seen),
      invariants: strandedNeverDoubled,
      // Every spend fsyncs and every restart re-reads the file; sixty runs keep the suite quick.
      runs: 60,
      maxLen: 10,
      seed: 20261010,
    });
    expect(r.runs).toBe(60);
    expect(r.commands).toBeGreaterThan(r.runs);
    // The walk was not vacuous: processes did restart, and replays did arrive after a restart and were refused.
    expect(seen.restarts).toBeGreaterThan(0);
    expect(seen.replaysAfterRestart).toBeGreaterThan(0);
  });

  it('mutation: a nonce store that records spends in memory only is refused by the harness at the restart that forgot the spend, and the replay after it executes', async () => {
    // Caught one command before the double broadcast it permits: the moment
    // the restart forgets the spend, the current process no longer holds a
    // broadcast id spent. The harness shrinks to those two commands — the
    // defect itself — and the third, applied below, is the replay executing.
    const seen: Seen = { restarts: 0, replaysAfterRestart: 0 };
    const err = await expectViolation(
      () => property({ setup: () => processes(seen, { volatile: true }), commands: commands(seen), invariants: strandedNeverDoubled, runs: 60, maxLen: 10, seed: 20261010 }),
      { match: /auth_\w was broadcast and the current process does not hold it spent/ },
    );
    const seq = err.sequence!;
    expect(seq.map((s) => s.name)).toEqual(['execute', 'restart']);
    expect((err.applied![0].result as ExecuteResult).ok).toBe(true);
    expect(err.seed).toBe(20261010);

    // The same two commands and one more: the replay after the restart
    // executes, and the authorization is doubled — with the real store, the
    // property above refuses that in every one of its runs.
    const id = (seq[0].args as { id: Id }).id;
    const volatile = processes(seen, { volatile: true });
    expect((await volatile.signer.execute({ authorization: volatile.auths[id], call: volatile.calls[id] })).ok).toBe(true);
    volatile.restart();
    expect((await volatile.signer.execute({ authorization: volatile.auths[id], call: volatile.calls[id] })).ok).toBe(true);
    expect(volatile.chain.executions).toHaveLength(2);
    expect(await strandedNeverDoubled(volatile, { applied: [] })).toEqual([`${id} was broadcast 2 times across 2 process(es)`]);
  });
});
