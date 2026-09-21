# Interoperate — signed invoices, signed receipts, x402 (Phase 18)

Status: built and tested · 2026-09-20 · testnets only

## What it is

Three documents that cross an organization boundary without FlashyOS on
both sides:

| Document | Who signs | Who verifies, with what |
|---|---|---|
| **SignedInvoice** — what a payee wants, where | the payee, with any Ed25519 key it holds | the plane: signature under the key *in* the invoice, window, shape |
| **SignedReceipt** — what the plane settled, for which invoice | the plane, with its authorization key | the payee: `verifyReceipt()` with the plane's public key, offline |
| **x402 payment** — an EIP-3009 `transferWithAuthorization` answering an HTTP 402 | the agent's account, through the signer | the facilitator, on chain |

The trust is where it always was. An invoice's signature proves *who is
asking*; whether that key may be paid is the paying agent's allowlist —
the invoice's `destination` must already be on the envelope, or the plane
refuses `DESTINATION_NOT_PERMITTED`. A receipt is the plane's word under the
same key every authorization carries; a verifier compares the embedded key
to the one it already trusts (`WRONG_KEY` otherwise — a document cannot
vouch for itself).

## Schemas

Published, drift-checked: [`schema/signed-invoice.json`](schema/signed-invoice.json),
[`schema/signed-receipt.json`](schema/signed-receipt.json). Canonical form for
both signatures: the signed fields only, keys sorted, no whitespace, `sig`
omitted — implemented once, in `packages/wallet-wdk/src/interop.ts`, used by
the plane and by counterparties. `invoiceHash` is sha256 of the canonical
invoice; the receipt names the invoice by it.

## The flows

**A payee outside FlashyOS is paid.**
`agent.partners.pay(invoice)` → `POST /wallet/external/invoices { invoice }` →
verify (`INVOICE_INVALID` · `INVOICE_BAD_SIGNATURE` · `INVOICE_EXPIRED` ·
`INVOICE_NOT_YET_VALID`, all before the plane is asked) → `propose()` on the
transfer the invoice describes → 201 ALLOW / 202 ESCALATE / 200 DENY, recorded
as an `ExternalSettlement` (one per org and invoice id; a repeat is
`INVOICE_ALREADY_SETTLED`). The agent executes the authorization through the
signer as any transfer. On the chain's answer the plane signs the receipt,
stores it, writes a RAW-tier receipt page (`receipts/external/<id>`) with the
receipt JSON inline, and captures the event. `agent.partners.receipt(invoiceId)`
returns the signed receipt; `GET /wallet/public-key` (public, no credential)
returns the key; the payee runs `verifyReceipt(receipt, { expectedPayerKey, invoice })`.

**An HTTP 402 is answered.**
`agent.wallet.pay402(challenge, from)` → `parseX402Challenge` (JSON body or
base64 `PAYMENT-REQUIRED` header) → `x402Record`: the first `exact` option on
a network listed as a **testnet** becomes a bounded transfer (`amount` =
`maxAmountRequired`, `destination` = `payTo`); a mainnet network is
`MAINNET_NOT_ENABLED` before the plane is asked and no flag widens the list →
`propose()` → the signer's `signTypedData`: the EIP-3009 typed data
re-derives to a record (chain from the domain, asset from the verifying
contract, amount and destination from the message) that must sit within the
authorization; the nonce is spent before signing; the plane is told the
authorization was consumed with reference `eip3009:<nonce>` → the
`X-PAYMENT` header to retry the request with.

The plane's ledger commits the authorization when the signature is produced,
not when the facilitator submits it: a signed EIP-3009 authorization is a
payment the holder can submit once, which is why it is treated exactly like
a broadcast. The on-chain transfer itself is the facilitator's.

## What was built

| Piece | Where |
|---|---|
| `signInvoice`, `verifyInvoice`, `signReceipt`, `verifyReceipt`, `invoiceHash` | `packages/wallet-wdk/src/interop.ts` |
| `parseX402Challenge`, `x402Record`, `eip3009TypedData`, `extractEip3009Operation`, `x402PaymentHeader`, `X402_NETWORKS` | `packages/wallet-wdk/src/x402.ts` |
| `ExternalSettlement` row; `settleExternalInvoice`, receipt signing on settle | `packages/api/src/services/externalSettlementService.ts` |
| `Signer.signTypedData()`; `ChainBackend.signTypedData?`; `POST /sign-typed-data` on the signer | `packages/signer/src/signer.ts`, `chain.ts`, `server.ts` |
| WDK second line extended: `signTypedData` is governed and admitted only for the in-flight record | `packages/signer/src/chain.ts` |
| Routes: `POST/GET /wallet/external/invoices`, `GET /wallet/external/invoices/{id}/receipt`, `GET /wallet/public-key` | `openapi.wallet.json` |
| Object: `agent.partners.pay / receipt`, `agent.wallet.pay402`, `org.publicKey()`, `org.externalSettlements()` | `packages/wdk` |

## Proof

- `packages/wallet-wdk/src/interop.test.ts` (6) — verifies under the carried key; any signed field altered fails; key order irrelevant; expiry, not-yet-valid, malformed never throw; `WRONG_KEY` on a self-consistent impostor receipt.
- `packages/wallet-wdk/src/x402.test.ts` (11) — header and body parsing; the bounded record; mainnet refused; typed data re-derives to the same record and within an authorization for it; the `X-PAYMENT` encoding.
- `packages/signer/src/signer.typedData.test.ts` (7) — the ladder for typed data: MISMATCH on destination, amount, asset; REPLAY across both paths (a signed authorization cannot then be broadcast); TYPED_DATA_UNSUPPORTED; unreported settlements kept.
- `packages/api/src/lib/wallet/demo/phases17-19.integration.test.ts` — an invoice paid, its receipt verified by the payee with the public key alone; tampered, expired, malformed refused before the plane; a stranger's valid invoice refused by the plane; an escalated invoice approved; a 402 answered, signed by account index 1, the ledger committed at `eip3009:<nonce>`.

## Upstream finding

`@tetherto/wdk-wallet-evm` beta.19: the seed-derived signer's
`signTypedData` throws `NotImplementedError` (`signers/seed-signer-evm.js`);
only the private-key signer implements it. On a live testnet the x402 path
therefore returns `TYPED_DATA_UNSUPPORTED` from `WdkChain` today, honestly,
and works against `MockChain` and any account that signs typed data. Recorded
in [`upstream/README.md`](upstream/README.md).
