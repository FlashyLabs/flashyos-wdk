# Spend authorization — specification

Status: implementable · Phase 0 · 2026-09-19
Machine-readable companions: `docs/wallet/schema/*.json`, `docs/wallet/openapi.wallet.json`

This is the contract between three parties that never share a process:

- the **agent** (untrusted), which proposes economic actions;
- the **authorization plane** (deterministic, inside `packages/api`), which
  decides and records;
- the **signer** (isolated, holds the seed, runs WDK), which executes only
  what the plane has signed.

## 1. Vocabulary — `OperationRecord`

The operation vocabulary is deliberately Tether's, not ours: the shape of
`OperationRecord` from `tetherto/wdk` PR #88 (draft), so that the same record
an agent proposes is the record a `TransactionPolicy` later evaluates.

```jsonc
{
  "kind": "transfer",          // "transfer" | "swap" | "bridge"
  "chain": "evm:8453",         // "<family>:<chainId>" — evm, tron, ton, solana, btc
  "asset": "0xa0b8…",          // exact contract address, or "native"
  "amount": "25000000",        // non-negative integer in base units, as a string
  "destination": "0x7f3c…",    // exact address; null only for kind = "swap"
  "raw": { }                   // optional: the originating call, opaque to the plane
}
```

Rules:
- `amount` is a decimal string parsed with `BigInt`; negative, fractional or
  non-numeric values are rejected before evaluation (`INVALID_AMOUNT`).
- `asset` and `destination` are compared **byte-exact after lowercasing** for
  EVM and byte-exact otherwise. A symbol is never an asset.
- `kind = "swap"` with `destination = null` means "within the org's own
  accounts". A swap with a destination is a transfer for policy purposes.

## 2. Scopes

| Scope | Holder | Grants |
|---|---|---|
| `wallet:read` | agents | balance and authorization *views* for the agent's own envelope |
| `wallet:propose` | agents | `POST …/wallet/proposals` |
| `wallet:settle` | the signer only | `POST …/wallet/authorizations/{id}/settle` |

No token may hold both `wallet:propose` and `wallet:settle`; `setAgentScopes`
refuses the combination (`SCOPE_CONFLICT`). Separation of duties is enforced
at grant time, not hoped for at call time.

## 3. `SpendEnvelope`

One row per `(orgId, agentName, chain)`. The envelope is *what this agent may
do on this chain*; an agent with no envelope for a chain may do nothing there.

| Field | Type | Meaning |
|---|---|---|
| `kinds` | string[] | permitted `OperationRecord.kind`s |
| `assets` | string[] | exact asset addresses (or `native`) |
| `destinations` | string[] | exact addresses; empty = no external destination permitted |
| `perTxMax` | bigint string | ceiling per authorization |
| `dailyMax` | bigint string | ceiling on reserved+committed amount per UTC day |
| `autoApproveMax` | bigint string | at or below → impact `LOW` → `AUTO_APPROVED` |
| `alwaysEscalate` | boolean | every proposal escalates regardless of amount |
| `escalationImpact` | `MEDIUM` \| `HIGH` \| `CRITICAL` | impact assigned when escalating |
| `active` | boolean | inactive envelopes refuse everything (`ENVELOPE_INACTIVE`) |

Only an `OWNER` or `ADMIN` of the org may create or change an envelope. A
change is a new row version; the previous row is retained (`supersededAt`).

## 4. The five checks, in order

Order is load-bearing: cheap and identity-shaped checks run before anything
that touches the ledger, and nothing is reserved for a proposal that will be
refused.

1. **Identity** — bearer token → `AgentToken` → `(orgId, agentName)`; the
   token's org must equal the route's org.
2. **Authority** — token holds `wallet:propose` (exact match; default deny).
3. **Envelope** — an active envelope exists for `(org, agent, chain)`; `kind`,
   `asset` and `destination` are each on their list; `amount ≤ perTxMax`.
4. **Budget** — inside a serializable transaction: today's reserved+committed
   total plus `amount` ≤ `dailyMax`; if so, a `BudgetReservation` is created.
5. **Grading** — if `alwaysEscalate` or `amount > autoApproveMax`, a
   `Decision` is created with `escalationImpact` and status `PENDING`, the
   reservation stays held, and the verdict is `ESCALATE`. Otherwise impact is
   `LOW`, the decision is `AUTO_APPROVED`, and a `SpendAuthorization` is issued.

## 5. Verdicts and codes

| Verdict | Meaning |
|---|---|
| `ALLOW` | authorization issued; body carries it |
| `ESCALATE` | reservation held; a `Decision` awaits an `OWNER`/`ADMIN`; body carries `decisionId` |
| `DENY` | refused; body carries `code` and `reason`; nothing reserved |

Denial codes (ours; deliberately parallel to WDK's three so an operator who
knows one vocabulary can read the other):

`SCOPE_MISSING` · `NO_ENVELOPE` · `ENVELOPE_INACTIVE` · `KIND_NOT_PERMITTED` ·
`ASSET_NOT_PERMITTED` · `DESTINATION_NOT_PERMITTED` · `PER_TX_CAP` ·
`DAILY_CAP` · `INVALID_AMOUNT` · `INVALID_RECORD`

Every verdict — including every `DENY` — is captured into the org's memory
(`recordCapture`, `authorKind: "agent"`, `sourcePath: "wallet/…"`,
`dedupeKey` = proposal id). Refusals are evidence too.

## 6. `SpendAuthorization`

```jsonc
{
  "id":            "auth_…",        // the nonce; single use
  "orgId":         "org_…",
  "agentName":     "research-ops",
  "chain":         "evm:8453",
  "kind":          "transfer",
  "asset":         "0xa0b8…",
  "maxAmount":     "25000000",      // inclusive ceiling; signer may spend ≤
  "destination":   "0x7f3c…",
  "reservationId": "rsv_…",
  "decisionId":    "dec_…",         // always present; AUTO_APPROVED for LOW
  "issuedAt":      "2026-09-19T11:00:00Z",
  "expiresAt":     "2026-09-19T11:05:00Z",
  "sig":           "base64url(ed25519(canonical))"
}
```

- **Canonicalization**: JSON with keys sorted lexicographically, no
  whitespace, `sig` omitted, UTF-8. Implemented once (`canonicalize()`) and
  shared by plane and signer.
- **Signature**: Ed25519 over the canonical bytes. The plane holds the private
  key (`WALLET_AUTHZ_PRIVATE_KEY`, PEM); the signer holds only the public key
  (`WALLET_AUTHZ_PUBLIC_KEY`). The signer can never mint an authorization.
- **TTL**: default 300 s. A stolen authorization is worthless in minutes.
- **Status**: `ISSUED → SPENT | EXPIRED | REVOKED`. The signer refuses any
  status other than `ISSUED`, and marks `SPENT` before broadcasting.

The signer, on every call, **re-derives an `OperationRecord` from the actual
call arguments** (not from the authorization) and refuses on any mismatch of
`chain`, `kind`, `asset`, `destination`, or `amount > maxAmount`. The
authorization says what *may* happen; the call says what *is* happening; they
must agree.

## 7. Two-phase ledger

| Event | Reservation | Effect on today's total |
|---|---|---|
| authorized (`ALLOW`) or escalated | `RESERVED` | counts |
| chain confirmed (`settle: CONFIRMED`) | `COMMITTED` | counts |
| chain reverted (`settle: REVERTED`) | `RELEASED` | no longer counts |
| authorization expired unspent | `RELEASED` | no longer counts |
| decision `REJECTED` | `RELEASED` | no longer counts |

"Today" is the UTC calendar day of `createdAt`. The budget check and the
reservation insert run in one `SERIALIZABLE` transaction, retried on
serialization failure; two proposals racing for the last of a daily cap
cannot both win.

## 8. What lives on-chain (out of scope for `packages/api`, in scope for the design)

Tier 1 deployments issue each agent an ERC-4337 session key whose spend limit
is enforced by the account contract. Tier 2 requires a multisig above a
ceiling. Neither is implemented in this repository; both are the layers that
must hold when the authorization plane is wrong, and the runbook
(`docs/wallet/runbook.md`) makes them a precondition of holding real value.

## 8½. The product layer (Phase 10)

Invoices, settlement auto-accept policies, receipts, receivables, delegated
authority and the weekly metrics are specified in [`product.md`](product.md)
and in the OpenAPI fragment. Two additions to the contract above:

- **Scope** `wallet:delegate` (§2): carve a sub-envelope for another agent
  out of one's own *delegable* envelope. Never on a token with
  `wallet:settle`.
- **Envelope field** `delegable: boolean` (§3, default false), set only by
  a human. A delegation is monotonic on every axis and children's daily
  caps partition the parent's; check 4 uses the parent's *effective* daily
  cap (its `dailyMax` minus its active delegations).

## 9. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/orgs/{orgId}/wallet/envelopes` | member session, OWNER/ADMIN | create or supersede an envelope |
| `GET` | `/api/v1/orgs/{orgId}/wallet/envelopes` | member session | list current envelopes |
| `POST` | `/api/v1/orgs/{orgId}/wallet/proposals` | agent token, `wallet:propose` | run the five checks |
| `GET` | `/api/v1/orgs/{orgId}/wallet/authorizations` | member session, or agent `wallet:read` (own only) | audit surface |
| `POST` | `/api/v1/orgs/{orgId}/wallet/authorizations/{id}/settle` | agent token, `wallet:settle` | commit or release |
| `GET` | `/api/v1/orgs/{orgId}/wallet/ledger` | member session | today's totals per envelope |

Decision resolution reuses `POST /api/v1/decisions/{id}/resolve`: approving a
wallet decision issues the held authorization; rejecting releases the
reservation. The wallet never grows a second approval path.
