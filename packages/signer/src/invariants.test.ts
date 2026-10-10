import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { eip3009TypedData, type Eip712TypedData, type OperationRecord, type SignedSpendAuthorization, type SignerCall } from '@flashyos/wallet-wdk';
import { Signer, type ExecuteResult, type SignTypedDataResult } from './signer';
import { MockChain, type ChainResult, type ExecuteOptions, type TypedDataSignature } from './chain';
import { FileNonceStore, MemoryNonceStore, type NonceStore } from './nonces';
import { canonicalize } from './verify';
import {
  checkInvariantsDoc,
  expectViolation,
  interleave,
  property,
  type Applied,
  type InterleaveContext,
  type InterleaveOp,
  type PropertyCommand,
} from '../vendor-invariants.mjs';

// invariants/1 over the signer. Every guarantee the signer's suite proves one
// call at a time is proved here for a PAIR — two calls carrying one
// authorization under every schedule the harness knows, including across a
// clock boundary — and for random sequences of calls, and each guarantee has a
// deliberately broken variant the harness must refuse, because a harness that
// has never failed has proved nothing. INVARIANTS.md at the package root
// states the guarantees and cites the tests here by title; the last test holds
// the two together.

const PKG = resolve(__dirname, '..');
const HARNESS = resolve(PKG, 'vendor-invariants.mjs');

// ── fixtures: the same shape the typed-data suite uses, on Base Sepolia ─────

const CHAIN = 'evm:84532';
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const PAY_TO = '0x7f3c000000000000000000000000000000000009';
const FROM = '0x1111111111111111111111111111111111111111';
const ISSUED_AT = '2026-09-20T10:00:00.000Z';
const EXPIRES_AT = '2026-09-20T10:05:00.000Z';
/** Where every clock starts: inside the window. One tick moves it ten minutes, past the window. */
const START = () => new Date('2026-09-20T10:02:00Z');
const TICK_MS = 10 * 60_000;

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const planePublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function issue(id: string, maxAmount = '10000', patch: Partial<SignedSpendAuthorization> = {}): SignedSpendAuthorization {
  const payload = {
    id, orgId: 'org_1', agentName: 'research-ops', chain: CHAIN, kind: 'transfer' as const,
    asset: USDC, maxAmount, destination: PAY_TO, reservationId: 'rsv_1', decisionId: 'dec_1',
    issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, ...patch,
  };
  return { ...payload, sig: sign(null, canonicalize({ ...payload, sig: '' }), privateKey).toString('base64url') };
}

const transferData = (to: string, amount: bigint) => '0xa9059cbb' + to.replace(/^0x/, '').padStart(64, '0') + amount.toString(16).padStart(64, '0');
/** An ERC-20 transfer of exactly `amount` to the authorized payee. */
const callFor = (amount: string): SignerCall => ({ to: USDC, data: transferData(PAY_TO, BigInt(amount)) });
/** An EIP-3009 TransferWithAuthorization of exactly `amount` to the authorized payee. */
const typedFor = (amount: string, nonce: string): Eip712TypedData =>
  eip3009TypedData(
    { scheme: 'exact', network: 'base-sepolia', maxAmountRequired: amount, payTo: PAY_TO, maxTimeoutSeconds: 60, asset: USDC, extra: { name: 'USDC', version: '2' } },
    FROM,
    { nonce, now: START() },
  );
const nonceFor = (seed: string) => '0x' + Buffer.from(seed.padEnd(32, '.')).toString('hex');

type Outcome = ExecuteResult | SignTypedDataResult;

// ── the two stores the signer ships, each a fresh instance per schedule ─────

interface StoreKind {
  name: string;
  make: () => { store: NonceStore; path?: string };
}
const STORES: StoreKind[] = [
  { name: 'MemoryNonceStore', make: () => ({ store: new MemoryNonceStore() }) },
  {
    name: 'FileNonceStore',
    make: () => {
      const path = join(mkdtempSync(join(tmpdir(), 'signer-invariants-')), 'spent', 'nonces.txt');
      return { store: new FileNonceStore(path), path };
    },
  },
];

/** Wraps a store so the suite can count how many times `spend` said "you did it". */
function counted(store: NonceStore): { store: NonceStore; won: string[] } {
  const won: string[] = [];
  return {
    won,
    store: {
      has: (id) => store.has(id),
      add: (id) => store.add(id),
      spend: async (id) => { const did = await store.spend(id); if (did) won.push(id); return did; },
    },
  };
}

/** How many lines of the file are exactly `id`. */
const recordedInFile = (path: string, id: string) => readFileSync(path, 'utf8').split('\n').filter((line) => line === id).length;

// ── the broken variants: the shape of each defect, so the harness can be seen to see it ──

/**
 * The nonce store the signer had before 2026-10-10: the check and the record
 * are two steps with an await between them, so two calls that both read
 * "unspent" both record and both execute.
 */
class CheckThenAddNonceStore implements NonceStore {
  private readonly spent = new Set<string>();
  async has(id: string) { return this.spent.has(id); }
  async add(id: string) { this.spent.add(id); }
  async spend(id: string) {
    if (this.spent.has(id)) return false;
    await Promise.resolve(); // the gap between check and record
    this.spent.add(id);
    return true;
  }
}

/** A store a "retry-friendly" signer could release a nonce back into. The real stores have no such verb. */
class ForgettableNonceStore implements NonceStore {
  private readonly spent = new Set<string>();
  async has(id: string) { return this.spent.has(id); }
  async add(id: string) { this.spent.add(id); }
  async spend(id: string) { if (this.spent.has(id)) return false; this.spent.add(id); return true; }
  forget(id: string) { this.spent.delete(id); }
}

/** A file store that believes a spend before the bytes are durable — the order FileNonceStore refuses. */
class RecordThenWriteNonceStore implements NonceStore {
  private readonly spent = new Set<string>();
  constructor(private readonly path: string) {}
  async has(id: string) { return this.spent.has(id); }
  async add(id: string) { await this.spend(id); }
  async spend(id: string) {
    if (this.spent.has(id)) return false;
    this.spent.add(id); // recorded…
    const fd = openSync(this.path, 'a'); // …and only then persisted
    try { writeSync(fd, `${id}\n`); } finally { closeSync(fd); }
    return true;
  }
}

// ── one authorization, two calls: the pair system ───────────────────────────

interface PairSystem {
  signer: Signer;
  chain: MockChain;
  store: NonceStore;
  won: string[];
  path?: string;
  clock: { now: Date };
  authorization: SignedSpendAuthorization;
  call: SignerCall;
  typedData: Eip712TypedData;
}

function pairSystem(kind: StoreKind, variant: { nonces?: NonceStore; clockReadOnce?: boolean } = {}): PairSystem {
  const made = variant.nonces ? { store: variant.nonces } : kind.make();
  const { store, won } = counted(made.store);
  const chain = new MockChain({ chain: CHAIN });
  const clock = { now: START() };
  const readOnce = clock.now;
  const signer = new Signer({ planePublicKeyPem, chains: [chain], nonces: store, now: variant.clockReadOnce ? () => readOnce : () => clock.now });
  return { signer, chain, store, won, path: made.path, clock, authorization: issue('auth_pair'), call: callFor('10000'), typedData: typedFor('10000', nonceFor('pair')) };
}

const PAIR_OPS: InterleaveOp<PairSystem, Outcome>[] = [
  { name: 'execute', run: (s) => s.signer.execute({ authorization: s.authorization, call: s.call }) },
  { name: 'signTypedData', run: (s) => s.signer.signTypedData({ authorization: s.authorization, typedData: s.typedData }) },
];
const tick = (s: { clock: { now: Date } }) => { s.clock.now = new Date(s.clock.now.getTime() + TICK_MS); };

/**
 * What must be true after any two calls carrying one authorization: exactly
 * one succeeded, the backend acted exactly once, `spend` was won exactly once,
 * the id is spent (once, in the file too), the loser was refused as REPLAY —
 * and, when the clock moved between them, the second was refused as EXPIRED.
 */
async function exactlyOnce(sys: PairSystem, { results, pattern }: InterleaveContext<Outcome>): Promise<string[]> {
  const reasons: string[] = [];
  results.forEach((r, i) => { if (!r.ok) reasons.push(`call ${i + 1} threw instead of refusing: ${r.error}`); });
  const outcomes = results.map((r) => (r.ok ? r.value : null));
  const oks = outcomes.filter((o) => o?.ok).length;
  if (oks !== 1) reasons.push(`${oks} of ${results.length} calls succeeded; exactly one may`);
  const acted = sys.chain.executions.length + sys.chain.signed.length;
  if (acted !== 1) reasons.push(`the backend acted ${acted} time(s); exactly once`);
  if (sys.won.length !== 1) reasons.push(`spend() returned true ${sys.won.length} time(s); exactly once`);
  if (!(await sys.store.has(sys.authorization.id))) reasons.push('the authorization is not recorded as spent');
  if (sys.path && recordedInFile(sys.path, sys.authorization.id) !== 1) reasons.push(`the file records the id ${recordedInFile(sys.path, sys.authorization.id)} time(s)`);
  const [a, b] = outcomes;
  if (pattern.includes('T')) {
    if (!a?.ok) reasons.push(`the call before the clock boundary was refused as ${a ? (a as { code: string }).code : 'a throw'}`);
    if (!b || b.ok || b.code !== 'EXPIRED') reasons.push(`the call after the clock boundary was ${b ? (b.ok ? 'accepted' : b.code) : 'a throw'}; expected EXPIRED`);
  } else {
    for (const o of outcomes) if (o && !o.ok && o.code !== 'REPLAY') reasons.push(`the losing call was refused as ${o.code}, not REPLAY`);
  }
  return reasons;
}

// ── a pool of authorizations, random sequences: the property world ──────────

const IDS = ['auth_a', 'auth_b', 'auth_c'] as const;
type Id = (typeof IDS)[number];
/** Distinct amounts per authorization, so a record the backend received names the authorization it came from. */
const AMOUNT: Record<Id, string> = { auth_a: '10000', auth_b: '10001', auth_c: '10002' };
const idOfAmount = (amount: string): string => IDS.find((id) => AMOUNT[id] === amount) ?? `?${amount}`;

/** MockChain, plus every attempt (failed ones included) and an outage switch. */
class RecordingChain extends MockChain {
  readonly attempts: string[] = [];
  failNext = false;
  private outage() { if (!this.failNext) return; this.failNext = false; throw new Error('rpc unreachable'); }
  async execute(record: OperationRecord): Promise<ChainResult> {
    this.attempts.push(idOfAmount(record.amount));
    this.outage();
    return super.execute(record);
  }
  async signTypedData(typedData: Eip712TypedData, options?: ExecuteOptions): Promise<TypedDataSignature> {
    this.attempts.push(idOfAmount(typedData.message.value));
    this.outage();
    return super.signTypedData(typedData, options);
  }
}

interface World {
  signer: Signer;
  chain: RecordingChain;
  store: NonceStore;
  clock: { now: Date };
  auths: Record<Id, SignedSpendAuthorization>;
  calls: Record<Id, SignerCall>;
  typed: Record<Id, Eip712TypedData>;
  /** Only the broken variant has this: the real stores cannot forget. */
  forget?: (id: string) => void;
}

function world(kind: StoreKind, variant: { refundsOnFailure?: boolean } = {}): World {
  const forgettable = variant.refundsOnFailure ? new ForgettableNonceStore() : null;
  const store = forgettable ?? kind.make().store;
  const chain = new RecordingChain({ chain: CHAIN });
  const clock = { now: START() };
  const signer = new Signer({ planePublicKeyPem, chains: [chain], nonces: store, now: () => clock.now });
  const by = <T>(f: (id: Id) => T) => Object.fromEntries(IDS.map((id) => [id, f(id)])) as Record<Id, T>;
  return {
    signer, chain, store, clock,
    auths: by((id) => issue(id, AMOUNT[id])),
    calls: by((id) => callFor(AMOUNT[id])),
    typed: by((id) => typedFor(AMOUNT[id], nonceFor(id))),
    forget: forgettable ? (id) => forgettable.forget(id) : undefined,
  };
}

const commands = (): PropertyCommand<World, { id?: Id }>[] => [
  {
    name: 'execute',
    gen: (r) => ({ id: r.pick(IDS) }),
    run: async (w, { id }) => {
      const res = await w.signer.execute({ authorization: w.auths[id!], call: w.calls[id!] });
      if (!res.ok && res.code === 'EXECUTION_FAILED') w.forget?.(id!);
      return res;
    },
  },
  {
    name: 'signTypedData',
    gen: (r) => ({ id: r.pick(IDS) }),
    run: async (w, { id }) => {
      const res = await w.signer.signTypedData({ authorization: w.auths[id!], typedData: w.typed[id!] });
      if (!res.ok && res.code === 'EXECUTION_FAILED') w.forget?.(id!);
      return res;
    },
  },
  { name: 'outage', gen: () => ({}), run: (w) => { w.chain.failNext = true; } },
];

/**
 * After every command: the backend acted at most once per authorization; the
 * spent ids are exactly the ids that reached the backend (a refusal spends
 * nothing, a failure unspends nothing); every attempt that did not broadcast
 * is in `pendingExecutions`; and once the clock has moved past the window
 * every call is refused EXPIRED, while none is before it.
 */
async function worldHolds(w: World, { applied }: { applied: Applied[] }): Promise<string[]> {
  const reasons: string[] = [];
  const attempts = new Map<string, number>();
  for (const id of w.chain.attempts) attempts.set(id, (attempts.get(id) ?? 0) + 1);
  for (const [id, n] of attempts) if (n > 1) reasons.push(`the backend was asked to act on ${id} ${n} times`);

  const broadcast = [...w.chain.executions.map((e) => idOfAmount(e.record.amount)), ...w.chain.signed.map((s) => idOfAmount(s.typedData.message.value))];
  for (const id of IDS) { const n = broadcast.filter((b) => b === id).length; if (n > 1) reasons.push(`${id} was broadcast ${n} times`); }

  const spent: string[] = [];
  for (const id of IDS) if (await w.store.has(id)) spent.push(id);
  const attempted = [...attempts.keys()].sort();
  if (JSON.stringify(spent.sort()) !== JSON.stringify(attempted)) reasons.push(`spent ${JSON.stringify(spent)} ≠ attempted ${JSON.stringify(attempted)}: a refusal spent something, or a failure unspent it`);

  const pending = w.signer.pendingExecutions.map((p) => p.authorization.id).sort();
  const failed = attempted.filter((id) => !broadcast.includes(id));
  if (JSON.stringify(pending) !== JSON.stringify(failed)) reasons.push(`pendingExecutions ${JSON.stringify(pending)} ≠ attempts that did not broadcast ${JSON.stringify(failed)}`);

  const firstTick = applied.findIndex((a) => a.name === 'tick');
  const okPer = new Map<string, number>();
  applied.forEach((a, i) => {
    if (a.name !== 'execute' && a.name !== 'signTypedData') return;
    const id = (a.args as { id: Id }).id;
    if (a.error) { reasons.push(`step ${i + 1}: ${a.name} ${id} threw: ${a.error}`); return; }
    const res = a.result as Outcome;
    if (res.ok) okPer.set(id, (okPer.get(id) ?? 0) + 1);
    const afterBoundary = firstTick >= 0 && i > firstTick;
    if (afterBoundary && (res.ok || res.code !== 'EXPIRED')) reasons.push(`step ${i + 1}: ${a.name} ${id} after the clock boundary was ${res.ok ? 'accepted' : res.code}; expected EXPIRED`);
    if (!afterBoundary && !res.ok && res.code === 'EXPIRED') reasons.push(`step ${i + 1}: ${a.name} ${id} was EXPIRED before the clock moved`);
  });
  for (const [id, n] of okPer) if (n > 1) reasons.push(`${id} succeeded ${n} times`);
  return reasons;
}

// ── the suite ───────────────────────────────────────────────────────────────

describe.each(STORES)('$name', (kind) => {
  it('every execute/signTypedData pair, under every schedule, executes the authorization exactly once and refuses the call after the clock boundary as EXPIRED', async () => {
    const r = await interleave({ setup: () => pairSystem(kind), ops: PAIR_OPS, invariants: exactlyOnce, tick });
    // Two ops, every ordered pair (self-pairs included), five schedules plus the two that cross the clock.
    expect(r).toMatchObject({ kit: 'invariants/1', pairs: 4, schedules: 28 });
  });

  it('spend() returns true exactly once for an id under every schedule, and has() agrees', async () => {
    const r = await interleave({
      setup: () => { const made = kind.make(); return { ...made, ...counted(made.store) }; },
      ops: [{ name: 'spend', run: (s) => s.store.spend('auth_1') }],
      invariants: async (s, { results }) => {
        const reasons: string[] = [];
        const trues = results.filter((r) => r.ok && r.value === true).length;
        if (trues !== 1) reasons.push(`${trues} of ${results.length} spends returned true`);
        if (s.won.length !== 1) reasons.push(`the store counted ${s.won.length} wins`);
        if (!(await s.store.has('auth_1'))) reasons.push('has() disagrees: not spent');
        if (s.path && recordedInFile(s.path, 'auth_1') !== 1) reasons.push(`the file records the id ${recordedInFile(s.path, 'auth_1')} time(s)`);
        return reasons;
      },
    });
    expect(r.schedules).toBe(5);
  });

  it('under random execute, signTypedData, outage and tick sequences: the backend acts at most once per authorization, spent ids are exactly the attempted ids, and nothing succeeds after expiry', async () => {
    const r = await property({
      setup: () => world(kind),
      commands: commands(),
      invariants: worldHolds,
      tick,
      // The file store fsyncs every spend; fewer runs there keep the suite quick without thinning the memory store's.
      runs: kind.name === 'FileNonceStore' ? 60 : 150,
      maxLen: 10,
      seed: 20261010,
    });
    expect(r.runs).toBeGreaterThan(0);
    expect(r.commands).toBeGreaterThan(r.runs);
  });
});

describe('the clock', () => {
  it('an authorization is accepted at the instant it expires and refused one millisecond after, with nothing broadcast and the nonce untouched', async () => {
    const clock = { now: new Date(EXPIRES_AT) };
    const chain = new MockChain({ chain: CHAIN });
    const store = new MemoryNonceStore();
    const signer = new Signer({ planePublicKeyPem, chains: [chain], nonces: store, now: () => clock.now });
    const onTheLine = issue('auth_on_the_line');
    expect((await signer.execute({ authorization: onTheLine, call: callFor('10000') })).ok).toBe(true);

    clock.now = new Date(clock.now.getTime() + 1);
    const late = issue('auth_late');
    expect(await signer.execute({ authorization: late, call: callFor('10000') })).toEqual({ ok: false, code: 'EXPIRED', reason: 'authorization expired' });
    expect(await signer.signTypedData({ authorization: late, typedData: typedFor('10000', nonceFor('late')) })).toEqual({ ok: false, code: 'EXPIRED', reason: 'authorization expired' });
    expect(chain.executions).toHaveLength(1);
    expect(chain.signed).toHaveLength(0);
    expect(await store.has(late.id)).toBe(false);
    expect(signer.pendingExecutions).toEqual([]);
    expect(signer.unreportedSettlements).toEqual([]);
  });
});

describe('the harness can see each defect', () => {
  it('mutation: a check-then-add nonce store wired into the real Signer lets both started-together calls through, and only those', async () => {
    const err = await expectViolation(
      () => interleave({ setup: () => pairSystem(STORES[0], { nonces: new CheckThenAddNonceStore() }), ops: PAIR_OPS, invariants: exactlyOnce, tick }),
      { match: /2 of 2 calls succeeded/ },
    );
    // Sequential, yielded and clock-crossing schedules pass — the defect lives exactly where the audit found it.
    expect([...new Set(err.failures!.map((f) => f.pattern))].sort()).toEqual(['a||b', 'b||a']);
    expect(err.failures).toHaveLength(8);
    expect(err.failures!.every((f) => f.violations.some((v) => /backend acted 2 time/.test(v)))).toBe(true);
  });

  it('mutation: a check-then-add store spends one id twice under the started-together schedules', async () => {
    const err = await expectViolation(
      () => interleave({
        setup: () => counted(new CheckThenAddNonceStore()),
        ops: [{ name: 'spend', run: (s) => s.store.spend('auth_1') }],
        invariants: (s, { results }) => (results.filter((r) => r.ok && r.value === true).length === 1 && s.won.length === 1 ? [] : [`${s.won.length} wins`]),
      }),
      { match: /2 wins/ },
    );
    expect(err.failures!.map((f) => f.pattern).sort()).toEqual(['a||b', 'b||a']);
  });

  it('mutation: a signer whose clock was read once and never again accepts the call after the boundary, and exactly the two clock-crossing schedules fail', async () => {
    const err = await expectViolation(
      () => interleave({ setup: () => pairSystem(STORES[0], { clockReadOnce: true }), ops: PAIR_OPS, invariants: exactlyOnce, tick }),
      { match: /after the clock boundary was REPLAY; expected EXPIRED/ },
    );
    expect([...new Set(err.failures!.map((f) => f.pattern))].sort()).toEqual(['a;T;b', 'a||T||b']);
    expect(err.failures).toHaveLength(8);
  });

  it('mutation: a signer that released the nonce when the backend failed leaves an attempted authorization unspent, and the harness shrinks it to outage, call', async () => {
    // The retry-friendly variant is caught one command earlier than the double
    // execution it would permit: the moment the failed attempt is forgotten,
    // the spent ids no longer equal the attempted ids. The minimal sequence is
    // the defect itself — an outage, then the one call it broke.
    const err = await expectViolation(
      () => property({ setup: () => world(STORES[0], { refundsOnFailure: true }), commands: commands(), invariants: worldHolds, tick, runs: 150, maxLen: 10, seed: 20261010 }),
      { match: /spent \[\] ≠ attempted \["auth_\w"\]: a refusal spent something, or a failure unspent it/ },
    );
    const seq = err.sequence!;
    expect(seq.map((s) => s.name)).toEqual(['outage', expect.stringMatching(/^(execute|signTypedData)$/)]);
    expect(err.applied![1].result).toMatchObject({ ok: false, code: 'EXECUTION_FAILED' });
    expect(err.seed).toBe(20261010);
  });
});

describe('durable before believed', () => {
  // A directory standing where the file should be makes the write fail on
  // every platform, created after the store loads so it fails at exactly the
  // step under test — the same device nonces.test.ts uses.
  const blockedPath = () => { const path = join(mkdtempSync(join(tmpdir(), 'signer-invariants-')), 'nonces.txt'); return path; };
  const blocked = (store: (path: string) => NonceStore) => {
    const path = blockedPath();
    const s = store(path);
    mkdirSync(path, { recursive: true });
    const chain = new MockChain({ chain: CHAIN });
    const signer = new Signer({ planePublicKeyPem, chains: [chain], nonces: s, now: START });
    return { signer, chain, store: s, authorization: issue('auth_blocked'), call: callFor('10000') };
  };
  type Blocked = ReturnType<typeof blocked>;
  const ops: InterleaveOp<Blocked, ExecuteResult>[] = [{ name: 'execute', run: (s) => s.signer.execute({ authorization: s.authorization, call: s.call }) }];
  const nothingBelieved = async (s: Blocked, { results }: InterleaveContext<ExecuteResult>) => {
    const reasons: string[] = [];
    if (results.some((r) => r.ok)) reasons.push('a call whose spend could not be persisted returned instead of failing');
    if (s.chain.executions.length) reasons.push(`the backend acted ${s.chain.executions.length} time(s) on a spend that was never durable`);
    if (await s.store.has(s.authorization.id)) reasons.push('the store believes a spend it could not persist');
    if (s.signer.pendingExecutions.length) reasons.push('an attempt was recorded though nothing reached the backend');
    return reasons;
  };

  it('a spend whose write failed is not a spend: the call fails, nothing is broadcast, and the id is not believed spent', async () => {
    const r = await interleave({ setup: () => blocked((path) => new FileNonceStore(path)), ops, invariants: nothingBelieved });
    expect(r.schedules).toBe(5);
  });

  it('mutation: a file store that records before it writes believes a spend it never persisted, in every schedule', async () => {
    const err = await expectViolation(
      () => interleave({ setup: () => blocked((path) => new RecordThenWriteNonceStore(path)), ops, invariants: nothingBelieved }),
      { match: /believes a spend it could not persist/ },
    );
    expect(err.failures).toHaveLength(5);
  });
});

describe('INVARIANTS.md', () => {
  const suiteSource = () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []));
    return walk(__dirname).map((p) => readFileSync(p, 'utf8')).join('\n');
  };

  it('holds: numbered from I-1 without gaps, every part present, and every cited test is in this suite by its exact title', () => {
    const r = checkInvariantsDoc(readFileSync(join(PKG, 'INVARIANTS.md'), 'utf8'), suiteSource());
    expect(r.problems).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.invariants.length).toBeGreaterThanOrEqual(5);
    expect(r.citations.length).toBeGreaterThanOrEqual(r.invariants.length);
  });

  it('the checker would notice: a citation with no test behind it is named', () => {
    const r = checkInvariantsDoc(readFileSync(join(PKG, 'INVARIANTS.md'), 'utf8'), suiteSource().replace(/exactly once/g, 'about once'));
    expect(r.valid).toBe(false);
    expect(r.problems.some((p) => /cites a test that does not exist/.test(p))).toBe(true);
  });

  it('node vendor-invariants.mjs check <package> — the command CI runs — exits 0 here', () => {
    const out = execFileSync(process.execPath, [HARNESS, 'check', PKG], { encoding: 'utf8' });
    expect(out).toMatch(/^ok — \d+ invariant\(s\), \d+ citation\(s\) found in \d+ test file\(s\)/);
  });
});
