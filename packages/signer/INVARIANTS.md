# Invariants — `@flashyos/signer`

The guarantees this signer makes, each stated once, each with the code that
enforces it and the tests that prove it. Written to the `invariants/1`
contract: `vendor-invariants.mjs` beside this file is spec-kit's harness,
vendored byte-identically, and `src/invariants.test.ts` drives it — every pair
of calls under every schedule the harness knows, random sequences shrunk to
the shortest that fails, and one deliberately broken variant per invariant so
the harness is seen to catch each defect rather than trusted to.
`node vendor-invariants.mjs check packages/signer` holds this document to the
suite: every test cited below exists under `src/` by its exact title, or the
check fails. (A citation is matched verbatim, which is why each sits on one
line.)

A refusal is a result, never a failure. The signer is allowed to say no; it is
not allowed to say yes twice.

## I-1 · At most once

**Claim.** A signed authorization is executed at most once. Any number of
`execute()` and `signTypedData()` calls carrying one authorization id —
sequential, started together, yielded between, or split across a clock
boundary — produce exactly one `ok: true`, exactly one backend action (one
broadcast or one off-chain signature, never one of each), and the losing calls
are refused `REPLAY`. This holds with `MemoryNonceStore` and `FileNonceStore`
alike, and across the two paths: an authorization signed as typed data cannot
then be broadcast, or the reverse.

**Why.** An authorization is a bounded permission to move value once. Two
executions of one authorization are a double spend the plane's reservation
never covered, and an external audit on 2026-10-10 reproduced exactly that
against this signer: two concurrent requests carrying one authorization both
executed, in this source and in the npm release, because the replay check and
the record were two steps with awaits between them.

**Enforced by.** `Signer.execute()` and `Signer.signTypedData()` in
`src/signer.ts` consume the authorization through `NonceStore.spend(id)`, which
checks and records in one step and says whether this call did it; only the
call `spend` answers `true` to proceeds to the backend. The early `has()` is a
fast refusal, not the guarantee. Nothing in the signer constructs a success
without passing through `spend`.

**Proved by.** `src/invariants.test.ts`
› *every execute/signTypedData pair, under every schedule, executes the authorization exactly once and refuses the call after the clock boundary as EXPIRED*
— every ordered pair of the two calls, self-pairs included, under all seven
schedules, for both stores, with the backend's action count, the store's win
count and the file's line count all read back. The mutation
› *mutation: a check-then-add nonce store wired into the real Signer lets both started-together calls through, and only those*
rebuilds the pre-fix store, wires it into the real `Signer`, and the harness
fails exactly the two started-together schedules and no other — the shape the
audit found. `src/signer.test.ts`
› *two concurrent executes with one authorization: exactly one executes, the other is REPLAY*,
› *twenty concurrent executes with one authorization still execute once* and
› *a nonce store whose has() is slow still admits exactly one*;
`src/signer.typedData.test.ts`
› *a signed authorization cannot then be broadcast as a transaction: one nonce, one use, either path*.

## I-2 · A spend is one step

**Claim.** For any id, `NonceStore.spend(id)` returns `true` exactly once
under any interleaving of calls, and `has(id)` is `true` from that moment on.
`FileNonceStore` additionally records the id in its file exactly once. This is
true of both stores the package ships.

**Why.** I-1 rests on it. A store whose check and record can be interleaved
lets two callers both read "unspent" and both record, and no amount of care in
the signer above it can recover the guarantee — the signer's own suite had
twenty concurrent executions passing one at a time while the pair failed.

**Enforced by.** `MemoryNonceStore.spend` and `FileNonceStore.spend` in
`src/nonces.ts` check and set the in-memory set with no `await` between the
two, so no other caller can run in the gap; the file append in
`FileNonceStore` happens after the in-memory record has already decided the
winner.

**Proved by.** `src/invariants.test.ts`
› *spend() returns true exactly once for an id under every schedule, and has() agrees*,
run for both stores under the five schedules without a clock. The mutation
› *mutation: a check-then-add store spends one id twice under the started-together schedules*
shows the harness refusing the two-step store on exactly those schedules.
`src/nonces.test.ts`
› *MemoryNonceStore: the first spend wins, every later one loses, has() agrees*.

## I-3 · Expiry is read from the signer's clock, at the call

**Claim.** Each call reads the signer's clock once, at its start, and refuses
the authorization `EXPIRED` when that reading is strictly after `expiresAt` —
the instant of expiry is still accepted, and the 30-second skew allowance
applies only to `issuedAt` (`NOT_YET_VALID`), never to expiry. A refusal for
expiry happens before the nonce is consulted: nothing is broadcast, nothing is
signed, the id is not spent, and nothing is recorded in `pendingExecutions` or
`unreportedSettlements` — the authorization is untouched, and only the clock
has ended it. A call that read the clock before a boundary completes on that
reading; a call that reads it after is refused.

**Why.** An authorization's window is how the plane bounds its exposure to a
leaked or stale permission. A signer that checked expiry against anything but
its own clock — the authorization's own timestamps, a clock read once at start
— would let the holder of an expired authorization choose when it is valid.
And a refusal that consumed the nonce would turn an honest clock skew into a
lost authorization.

**Enforced by.** `verifyAuthorization(authorization, this.publicKey,
this.now())` is the first statement of both `Signer.execute()` and
`Signer.signTypedData()` in `src/signer.ts`, before `has`, before `spend`,
before any backend; `verifyAuthorization` in `src/verify.ts` applies
`now.getTime() > expires` with no skew. `now` is injectable so a test can move
it.

**Proved by.** `src/invariants.test.ts`
› *an authorization is accepted at the instant it expires and refused one millisecond after, with nothing broadcast and the nonce untouched*
pins the boundary and the absence of every side effect. The clock-crossing
schedules of
› *every execute/signTypedData pair, under every schedule, executes the authorization exactly once and refuses the call after the clock boundary as EXPIRED*
prove the call started before the boundary completes and the one after it is
`EXPIRED`, for both stores; the property run
› *under random execute, signTypedData, outage and tick sequences: the backend acts at most once per authorization, spent ids are exactly the attempted ids, and nothing succeeds after expiry*
checks after every command that no call is `EXPIRED` before the clock moves and
none is anything else after. The mutation
› *mutation: a signer whose clock was read once and never again accepts the call after the boundary, and exactly the two clock-crossing schedules fail*
shows the harness refusing a signer that captured the time once.
`src/signer.test.ts` › *refuses an expired authorization*.

## I-4 · Spent before broadcast, and never unspent

**Claim.** The nonce is spent before the backend is asked to act, and nothing
ever unspends it. The ids a store holds as spent are exactly the ids that
reached a backend: a refusal before the spend — bad signature, expired, no
backend, unrecognised call, mismatch, on-chain limit — spends nothing and
records nothing, and a backend failure after the spend keeps the id spent,
reports `EXECUTION_FAILED`, keeps the attempt in `pendingExecutions` for an
operator, and refuses a retry as `REPLAY`. The backend is therefore asked to
act on an authorization at most once, whatever it did with the request.

**Why.** A crash or failure between spend and broadcast strands an authorization
that was never used, which the plane's nightly sweep recovers; the reverse
order strands a broadcast with no record of it, which is a double spend waiting
for the retry. A backend that threw may still have broadcast — `ReceiptTimeout`
carries the hash — so "release the nonce and let them retry" is the one
accommodation this signer will not make.

**Enforced by.** The order of `Signer.execute()` and `Signer.signTypedData()`
in `src/signer.ts`: every refusal returns before `spend`; `spend` precedes
`backend.execute` / `backend.signTypedData`; the `catch` around the backend
pushes to `pendingExecutions` and returns. The `NonceStore` interface in
`src/nonces.ts` has no verb that removes an id.

**Proved by.** `src/invariants.test.ts`
› *under random execute, signTypedData, outage and tick sequences: the backend acts at most once per authorization, spent ids are exactly the attempted ids, and nothing succeeds after expiry*
— random sequences over a pool of three authorizations with an outage switch on
the backend, for both stores, checking after every command that spent ids equal
attempted ids and that every attempt which did not broadcast is in
`pendingExecutions`. The mutation
› *mutation: a signer that released the nonce when the backend failed leaves an attempted authorization unspent, and the harness shrinks it to outage, call*
shows the harness finding the retry-friendly variant and shrinking it to the
two commands that are the defect — an outage and the one call it broke, caught
at the forgotten spend rather than at the double execution it would have
allowed. `src/signer.test.ts`
› *a backend failure after the nonce is spent is EXECUTION_FAILED, kept for the operator, never a replay window*
and › *marks the nonce spent even when the chain reverts, and reports REVERTED*;
`src/signer.typedData.test.ts`
› *spends the nonce: a second signature under the same authorization is a REPLAY*.

## I-5 · Durable before believed

**Claim.** `FileNonceStore` believes a spend only after the id is durable on
disk. A spend whose write failed is not a spend: the call that attempted it
fails, nothing is broadcast, the id is not held as spent in memory, and a store
reloaded from the same file does not hold it either. What the store does hold
survives a restart.

**Why.** A signer that forgets what it spent accepts a replay of every
authorization still inside its window, so the file is the replay protection
across restarts. A store that marked an id spent in memory and failed to
persist it would refuse the replay today and admit it one restart later — the
failure that looks like success for exactly as long as the process lives.

**Enforced by.** `FileNonceStore.add` in `src/nonces.ts` writes and `fsync`s
through one append descriptor and only then adds the id to the in-memory set;
`FileNonceStore.spend` decides the winner on the set and then calls `add`, so a
failed write throws out of `spend` and out of `Signer.execute()` before any
backend is reached.

**Proved by.** `src/invariants.test.ts`
› *a spend whose write failed is not a spend: the call fails, nothing is broadcast, and the id is not believed spent*,
with a directory standing where the file should be, under every schedule. The
mutation
› *mutation: a file store that records before it writes believes a spend it never persisted, in every schedule*
shows the harness refusing the other order. `src/nonces.test.ts`
› *does not mark a nonce spent when the write fails* and
› *survives a restart — the property MemoryNonceStore lacks*.
