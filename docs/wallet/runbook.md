# Runbook — operating the authorization plane and the signer

Status: Phase 4 deliverable · 2026-09-19

Phase 4 of the roadmap — a thirty-day pilot holding real value — **cannot be
executed from the environment this code was built in**: no chain egress, no
funds, no managed secret store, no human on call. What can be delivered is the
procedure a human follows to run it, written so that each step is a check with
a yes/no answer. Nothing below has been performed. Everything below is required
before anything of value is held.

## 0. What you are running

| Component | Where | Holds | Never holds |
|---|---|---|---|
| Authorization plane | `packages/api` (routes under `/api/v1/orgs/{orgId}/wallet`) | `WALLET_AUTHZ_PRIVATE_KEY` | any seed |
| Signer | `packages/signer` | the seed; the plane's **public** key | the plane's private key |
| Agent runtime | wherever the agent runs | an agent token with `wallet:propose` | seed, keys, policy |

The plane decides; the signer executes only what the plane signed; the agent
proposes. If any component holds something from its "never holds" column, stop.

## 1. Keys

- Generate the plane's Ed25519 pair once, outside the repository:
  `node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ed25519');console.log(k.privateKey.export({type:'pkcs8',format:'pem'}));console.log(k.publicKey.export({type:'spki',format:'pem'}))"`
- Private key → the plane's secret store as `WALLET_AUTHZ_PRIVATE_KEY`. In
  production the plane refuses to start without it (an ephemeral key would
  silently invalidate every authorization on restart).
- Public key → the signer's configuration. The signer also reads it from
  `GET …/wallet/authorizations` and should refuse to start if the two differ.
- **Check:** `git grep -n "BEGIN PRIVATE KEY"` returns only
  `docs/wallet/fixtures/test-signing-key.pem`, which is a test key that signs
  nothing real. Any other hit is an incident.

## 2. Custody tier

Choose deliberately, and write the choice down in the org's memory.

- **Tier 0 — development only.** `WDK_SEED` in the signer's environment.
  Testnet and CI. Not for value. The signer must be started with
  `WALLET_CUSTODY_TIER=0` to accept an environment seed, and must log that it
  is doing so on every start.
- **Tier 1 — operating accounts (the pilot).** Signer in its own service with
  no inbound internet. Seed from a managed secret store, injected at start and
  never written to disk. Each agent's on-chain authority bounded by an
  ERC-4337 session key whose limits the account contract enforces — this is
  the layer that holds when the plane is wrong, and the pilot does not start
  without it. *Phase 6 finding ([`testnet.md`](testnet.md)): WDK's ERC-4337
  module exposes no session keys or spending limits; this needs a Safe
  allowance/roles module outside WDK, or the pilot waits. Phase 12 built
  the Safe Allowance Module path this side of the chain —
  [`onchain-limit.md`](onchain-limit.md) has what a person does to close
  it.* The signer's nonce store must be `FileNonceStore` (or better), never
  the in-memory one.
- **Tier 2 — treasury.** Threshold signing or an HSM; on-chain multisig above
  a ceiling; on-chain allowlists. Not part of the pilot.

**Check before the pilot:** the signer host cannot be reached from the
internet; the seed does not appear in any log, environment dump or crash
report; the session-key limit on chain is at or below the envelope's
`dailyMax`.

## 3. Scopes and separation of duties

- Agents that spend hold `wallet:propose` (and `wallet:read` to collect
  approved authorizations). The signer's token holds `wallet:settle` and
  nothing else. `setAgentScopes` refuses a token holding both — do not work
  around it.
- Envelopes are set by an `OWNER`/`ADMIN` session. There is no agent path.
- **Check:** `SELECT "agentName", scopes FROM "AgentToken" WHERE 'wallet:propose' = ANY(scopes) AND 'wallet:settle' = ANY(scopes)` returns zero rows.

## 4. Envelopes for the pilot

Small, on purpose. Suggested first envelope for one operating agent:

| Field | Value |
|---|---|
| `kinds` | `["transfer"]` |
| `assets` | one stablecoin contract, exact address |
| `destinations` | two or three known vendor addresses, exact |
| `perTxMax` | $25 |
| `dailyMax` | $100 |
| `autoApproveMax` | $10 |
| `escalationImpact` | `MEDIUM` |

Treasury does not participate in the pilot.

## 5. Daily operation

- The nightly runs `expireStaleAuthorizations()`; confirm it is scheduled.
- Read `GET …/wallet/ledger` each morning. `remainingToday` should never be
  negative; a negative number is a bug and stops the pilot.
- Every `wallet/*` capture in the org's memory is a fact about money. The
  weekly review reads them. An `ANOMALY` in a `settled` capture (settlement
  after expiry or revocation) is an incident: find out why the signer was
  slow, and whether the gap between the plane's view and the chain's was
  exploitable.
- Signer `unreportedSettlements` non-empty → the plane did not hear about a
  spend. Retry the report; until it lands, the ledger over-reserves, which is
  the safe direction.

## 6. Pilot acceptance (the Phase 4 gate)

*Rehearse first, on a testnet, with the same gates:
[`pilot-testnet-rehearsal.md`](pilot-testnet-rehearsal.md). The real-value
pilot is a human decision this codebase cannot start (testnets only).*

Thirty consecutive days, real value, and every one of the following true on
every day:

1. Zero authorizations executed that a human would not have approved, judged
   by reading the week's `wallet/allow` captures — not by absence of
   complaint.
2. Every movement of funds explainable from the audit trail
   (`GET …/wallet/authorizations` + the org's memory) without asking an
   engineer.
3. Zero `ANOMALY` settlements, or each one investigated and written up.
4. Zero `MISMATCH` refusals at the signer — one means an agent, or something
   in its context, tried to redirect an authorized spend, and that is a
   security event whether or not it was refused.
5. `remainingToday` never negative.

If any day fails, the pilot restarts its thirty-day count after the cause is
fixed.

## 7. Stopping

- **Stop one agent:** `POST …/wallet/envelopes/revoke` — immediate; every
  subsequent proposal is `ENVELOPE_INACTIVE`; a pending escalation approved
  afterwards is not issued.
- **Stop one authorization:** `POST …/wallet/authorizations/{id}/revoke`.
- **Stop everything:** revoke the signer's `wallet:settle` token and stop the
  signer process. Issued authorizations then expire unspent within five
  minutes and their budget returns.

## 8. Things this runbook does not cover, deliberately

Regulatory scope (money transmission, VASP registration, travel rule) for
agent-initiated transfers on an organization's behalf. Scope it with counsel
before the pilot, not after. Nothing in this repository answers it.
