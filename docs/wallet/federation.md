# Federation — two planes, one network (Phases 23–27)

Status: built and tested · 2026-09-22 · testnets only

## What it is

Everything before this assumed one plane. Receipts verified under *the* key;
the network summed *this* deployment's organizations; an outside payee was
anyone not on this plane. Federation makes two planes one network: an
organization on one deployment invoices an organization on another, is paid
through *that* organization's plane, and holds a receipt it verifies against
a key it chose to trust — with both brains citing it. Every part existed;
what was missing was the plane's own identity, and the org's.

| Phase | What | Where |
|---|---|---|
| 23 | The plane says who it is; an org says whom it trusts | `planeIdentityService`, `trustedPlaneService`, `/.well-known/flashyos-plane.json`, `/wallet/trusted-planes` |
| 24 | The org's own key; invoices out to any payer; receipts in from any trusted plane | `orgSigningKeyService`, `outboundInvoiceService`, `/wallet/signing-keys`, `/wallet/outbound-invoices`, `/wallet/receivables/receipts` |
| 25 | x402 as a server: sell a request, file the facilitator's report | `x402ServerService`, `/wallet/x402/challenge`, `/wallet/x402/settlements` |
| 26 | The brief cites money: the money page rides the compile | `walletDigestService`, `compileRunService`, `/wallet/digest` |
| 27 | The federation run, pinned | `packages/api/src/lib/wallet/demo/federation.integration.test.ts` |

## Phase 23 — plane identity

`GET /.well-known/flashyos-plane.json` (public, never cached) is the
plane's `PlaneDocument`: `keys` (the active authorization key and every
retired one, each with `kid` = sha256 of its SPKI DER), `chains` the signer
reaches, the `$id` of every schema the plane enforces, and `generatedAt`.
**Rotation is an overlap, not a cut.** The new key goes into
`WALLET_AUTHZ_PRIVATE_KEY`; the old public half goes into
`WALLET_AUTHZ_RETIRED_PUBLIC_KEYS` (PEMs concatenated); every authorization
and receipt signed under the old key keeps verifying for as long as it is
listed. Nothing in the document can sign.

Per organization, a **trusted-plane registry** an OWNER edits, the same
shape as a receiving address: a name, a key, where it came from.
`POST /wallet/trusted-planes` takes one key or a whole plane document — each
key checked against its own fingerprint first, and only *active* keys
trusted, because a retired key is for verifying what was already signed.
Revocation stops new receipts under that key; receipts already accepted
were verified at the time and stay. **A plane trusts itself:** two orgs on
one plane settle with no registry entry.

`verifyReceipt(receipt, { trustedKeys })` in `@flashyos/wallet-wdk` takes the
registry's keys; `verifyPlaneDocument(doc)` checks a document's shape and
fingerprints; `keyFingerprint(pem)` is the kid.

## Phase 24 — invoices out, receipts in

Each org has an **Ed25519 key of its own**, created on first use, distinct
from the plane's. `POST /wallet/signing-keys/rotate` (OWNER) retires the old
key and keeps it listed. Custody is Tier 0: the plane holds the private
half in its database, as it holds the plane key in its environment; Tier 1
is the same KMS seam the runbook describes for the plane key.

`POST /wallet/outbound-invoices` issues a `SignedInvoice` — the Phase 18
schema, unchanged — under the org's key, with `payee.name` the org's name
and `destination` one of the org's **registered receiving addresses** on the
chain, chosen by name, never typed. A payer anywhere pays it through its
own plane exactly as it pays any outside payee (`agent.partners.pay`).

`POST /wallet/receivables/receipts` is where the payer's receipt comes
back. Any agent or member of the org may present it; it is trusted for what
it verifies as, never for who carried it. Accepted only if it verifies under
a key in the registry or one of this plane's own, names the invoice by
`invoiceHash`, and matches it in asset, destination and amount. Then the
invoice is PAID, a RAW page `receipts/inbound/<id>` holds the receipt JSON,
receivables count it, and the brain hears about it. Refused: a capture with
the code (`RECEIPT_WRONG_KEY` 403 · `RECEIPT_BAD_SIGNATURE` ·
`RECEIPT_MISMATCH` · `RECEIPT_UNKNOWN_INVOICE`), nothing filed.

## Phase 25 — x402 as a server

`GET /wallet/x402/challenge?chain&asset&amount&resource` is the 402 body an
org's paid endpoint answers with: `payTo` a registered receiving address,
the network a listed testnet, scheme `exact`. The buyer's side (Phase 18)
accepts what this side builds — asserted by test. When a facilitator
settles the buyer's EIP-3009 authorization it reports
`POST /wallet/x402/settlements` with **`wallet:settle`** — the reporting
scope, never the asking one. The report is checked against the org's own
addresses and filed as an `InboundPayment`, one per nonce, into receivables
and the brain. The buyer's plane already recorded its side at
`eip3009:<nonce>`; the two ledgers agree to the unit.

## Phase 26 — the brief cites money

`walletDigestPage(orgId, now, days)` is one DIGEST page, key `money`,
rewritten on every compile from the plane's own rows: paid to partners,
received from partners, paid to outside payees, invoiced, received by x402,
metered, refused with codes — every line with its transaction and the
**claim address** of the RAW receipt page it rests on — and the latest seal.
`recordCompileRun` appends it to the snapshot, so it is produced by the
compiler's run (and survives the compiler's rule that DIGEST holds only what
the run produced) while being computed by the plane. Deterministic: a re-run
with nothing new is `unchanged: 1`. `GET /wallet/digest` shows it ahead of
the compile.

## Phase 27 — the run, pinned

`federation.integration.test.ts`, from the run:

| Step | Result |
|---|---|
| A issues `A-2026-001` for 250 000 under its key | ISSUED · `payee.publicKey` is A's active key · destination A's registered address · a stranger destination `DESTINATION_NOT_OURS` · a chain with no address `NO_RECEIVING_ADDRESS` · a reused id `INVOICE_ID_TAKEN` |
| B pays it through its plane | ALLOW · executed · receipt signed by the plane |
| A presents the receipt | accepted under `this-plane` · PAID · page `receipts/inbound/…` with a `mind:wdk-fed-a/…` address · receivables received 250 000 · a second presentation is idempotent · unknown invoice 404 · altered amount `RECEIPT_BAD_SIGNATURE` |
| A receipt signed by a foreign plane key | `RECEIPT_WRONG_KEY` 403 · A trusts the foreign plane document (bad kid refused) · accepted under `registry` · revoked → the next one refused · re-trusting reactivates the same row · an ADMIN cannot edit the registry |
| A rotates its key | new active kid · old retired and listed · invoices under both verify |
| A sells a request | 402 pays to A's address · B answers it (Phase 18) · facilitator's report filed once per nonce · duplicate idempotent · other txHash `X402_CONFLICT` · to a stranger `X402_NOT_OURS` · received total 395 000 |
| The money page | B's cites the external settlement's receipt; A's cites the inbound receipts and the x402 payment; the compile produces it, `created: 1`, links resolved; a re-run `unchanged: 1` |

**Honestly scoped:** this is two organizations on one database with a
*distinct plane key* standing in for the second plane on the receipt path.
The verifier's side — a receipt from a key the org did not know, refused,
trusted, accepted, revoked — is exactly the code that runs across two
deployments. Two API processes with two databases is a person's run, and
the well-known route and the registry are what it needs.

## What it leaves out

The plane fetches nothing: a trusted plane's document is pasted by an OWNER,
not pulled from a URL, so no server-side request is ever made to an
address an agent chose. Org keys are held by the plane (Tier 0). The
network summary (Phase 21) still sums one deployment; summing across planes
would need the same trust registry at the network's edge, and is not built.
