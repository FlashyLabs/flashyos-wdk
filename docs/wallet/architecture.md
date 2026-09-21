# Architecture — the authorization plane, as built

Status: describes what is in the repository · 2026-09-19
Companions: `threat-model.md` (why), `spec.md` (the contract), `runbook.md`
(how to operate it), `demo.md` (what it does in a week).

## The shape

```
 ┌────────────────────────┐   proposal    ┌────────────────────────────┐  authorization  ┌───────────────────────┐
 │  Agent runtime         │ ───────────▶  │  FlashyOS authorization    │ ──────────────▶ │  Signer               │
 │  (untrusted)           │               │  plane (packages/api)      │   (signed,      │  (packages/signer)    │
 │  holds: agent token    │ ◀───────────  │  holds: Ed25519 private key│    single-use,  │  holds: seed +        │
 │  never: keys, policy   │   verdict     │  never: a seed             │    5 min)       │  plane's PUBLIC key   │
 └────────────────────────┘               └────────────────────────────┘                 └──────────┬────────────┘
          ▲                                         │  every verdict                                │ settle
          │  @flashyos/wallet-wdk                    ▼                                               │ (wallet:settle)
          │  (client · elicitation handler ·  ┌──────────────┐                                       ▼
          │   policy rule · TransactionPolicy)│ Flashy Mind  │ ◀───────────────────────────  Tether WDK → chain
                                              └──────────────┘
```

Two boundaries. The first is a network hop: the agent's process holds no key
and no policy, so a fully compromised agent can produce unlimited proposals
and sign none. The second is a process boundary: the signer holds the seed
but only the plane's public key, so a fully compromised signer can spend what
it was authorized to spend and mint nothing.

## Inside the plane (`packages/api`)

| Piece | File | Job |
|---|---|---|
| Scopes | `src/lib/mind/scopes.ts` | `wallet:read` · `wallet:propose` · `wallet:settle`; propose+settle refused on one token |
| Types + JSON schemas | `src/lib/wallet/types.ts`, `schemas.ts` | `OperationRecord` (Tether's vocabulary), `SpendEnvelope`, `SpendAuthorization`, `Verdict`; ajv validators; published copies drift-checked |
| Signing | `src/lib/wallet/authorization.ts` | canonical form (signed-field whitelist, sorted keys, Dates as ISO), Ed25519 sign/verify, 30 s skew, 5 min TTL |
| Envelopes + ledger | `src/services/spendEnvelopeService.ts` | versioned envelopes; `reserve()` under SERIALIZABLE with retry; commit/release; `ledger()` |
| The five checks | `src/services/spendAuthorizationService.ts` | `propose()` → verdict; escalation into `Decision`; `settle()`; `expireStaleAuthorizations()`; `revokeAuthorization()`; capture on every outcome |
| Decision hook | `src/services/decisionService.ts` | `resolveDecision()` calls `onWalletDecisionResolved()`; the wallet has no second approval path |
| Settlement | `src/services/settlementService.ts` | receiving-address registry; `settleWorkBroadcast()`; hooks so both orgs' memories agree |
| Routes | `src/app/api/v1/orgs/[orgId]/wallet/*` | envelopes (session), proposals (agent), authorizations (audit), settle (signer), revoke (session), ledger, addresses, settlements |
| Demo | `src/lib/wallet/demo/` | the four-agent week; `npm run wallet:demo` |

Tables: `SpendEnvelope`, `BudgetReservation`, `SpendAuthorization`,
`OrgWalletAddress`, `Settlement`, plus `Decision.metadata.kind = "wallet.spend"`.

## The adapter (`packages/wallet-wdk`, Apache-2.0)

Consumed by agent runtimes and signers; carries no API dependency.

- `FlashyOSAuthorizer` — the client. An unreachable plane is an error, never a verdict.
- `createElicitationHandler` — answers `@tetherto/wdk-mcp-toolkit`'s per-write elicitation with the plane's verdict; every non-ALLOW path is a decline; can wait for a human decision.
- `remoteAuthorizationRule` — an async condition in WDK's documented `registerPolicy()` shape; returns `true` only for ALLOW and never throws.
- `RemoteAuthorizationPolicy` — a `TransactionPolicy` against PR #88's draft contract: `allow` / `deny` / **`abstain`** (unreachable → abstain → engine default-deny), `commit` / `rollback` as the ledger's two-phase hooks. Behind `WALLET_POLICY_MODE=transaction-policy`.
- `extractEvmOperation` — the one chain-specific piece: native and ERC-20 `transfer` only; everything else returns null, and null means refuse.
- `parseToolkitConfirmation` / `createToolkitElicitationClient` — the seam to `@tetherto/wdk-mcp-toolkit`'s actual elicitation (a text confirmation message, verified against its source); rebuilds the call, asks the plane, answers `accept`/`decline`. Fail closed.

## The signer (`packages/signer`, Apache-2.0)

`Signer.execute({ authorization, call })`, in a fixed order: verify signature
and window → refuse a seen nonce → find the chain backend → **re-derive the
`OperationRecord` from the actual call** → refuse any mismatch → mark the
nonce spent → execute → report settlement. A backend failure after the nonce
is spent is `EXECUTION_FAILED`, kept in `pendingExecutions` with the hash if
one was broadcast — never a replay window. `MockChain` for tests and the
demos; `WdkChain` for **testnets only** (`testnets.ts` is the list; no
override): `@tetherto/wdk` + `wdk-wallet-evm`, a JSON-RPC receipt poller so a
hash is not mistaken for a confirmation, and WDK's own policy engine
registered as a deny-by-default second line that allows exactly the
operation in flight. `FileNonceStore` persists spent nonces across restarts.
`createSignerServer` is a thin `POST /execute`. See [`testnet.md`](testnet.md).

## What is deliberately not here

- No agent path to set an envelope or a receiving address. Both are human
  acts with an org role.
- No in-process policy as a boundary. WDK's engine is used in the signer as a
  second line (built in Phase 6); the contributor guide documents its bypass.
- No on-chain limits. ERC-4337 session keys and multisig are the layers that
  hold when the plane is wrong; they are a precondition of the pilot
  (`runbook.md`), not code in this repository — and WDK's ERC-4337 module
  does not provide them (`testnet.md`).
- No mainnet. `WdkChain` constructs for the testnets in `testnets.ts` and
  nothing else, by decision.
- No extraction for `approve`, `transferFrom`, permits, ERC-7702 delegation,
  arbitrary calldata, TRON smart-contract payloads, or the buy side of a
  swap. Transfers (EVM and TRON), swaps and bridges are covered;
  [`schema/extractor-packs.json`](schema/extractor-packs.json) is the
  published, drift-checked list of what is and is not.

## Test surface

| Package | Tests | What the load-bearing ones prove |
|---|---|---|
| `packages/api` (wallet) | 164 across 14 files: unit, schema and OpenAPI drift, fixture, envelope, authorization, settlement, product layer, routes, the four-agent week, the network demo, the testnet rehearsal | tamper → refused (transfer and swap); 8 racing reservations → 1 winner; every denial code; escalation both ways; envelope revoked mid-decision; post-expiry settlement recorded as an anomaly; delegation monotonic on every axis and partitioned; a policy answering an escalation on the record; receipts in both vaults; the whole demo week and the whole network, pinned |
| `packages/wallet-wdk` | 94 | extractors refuse `approve`/`transferFrom`/arbitrary calldata/the buy side of a swap; TRON addresses never case-folded; every non-ALLOW elicitation path declines; the toolkit's real confirmation messages parsed; abstain-on-unreachable → `NO_APPLICABLE_RULE`; commit/rollback reconcile a reverted tx; published coverage manifest drift-checked |
| `packages/signer` | 63 | tampered, foreign-key, expired, replayed, mismatched calls all refused before execution; mainnet refused at construction; the real WDK engine refuses anything not in flight, protocol methods included; a simulated backend bug meets the second line; receipt timeout kept for the operator; nonces survive a restart |
