# Settlement as the thing organizations buy

Status: Phase 10 · built and tested · 2026-09-19

Phases 0–7 made it possible for an agent to move money under organizational
authority and for two organizations to settle with each other. This phase
makes that useful to the people who run the organizations: what did we pay
them for, what are we owed, what settles without asking, and how often did a
person have to be involved.

## What was built

| Capability | Where | Shape |
|---|---|---|
| **Receipts** | `receiptService.ts` · `GET …/wallet/receipts/{settlementId}` | A settled or reverted payment writes a page into **both** orgs' vaults at `receipts/<settlementId>`, RAW tier (the compiler never deletes it), with a `mind:<org>/receipts/<id>@<hash>` claim address a decision can cite. Idempotent; the hash changes only if the facts do. |
| **Receivables** | `listReceivables` · `GET …/wallet/receivables` | The payee's view: outstanding invoices, payments authorized or escalated on the payer's side, received (each with its receipt key), refused, reverted; totals per chain/asset; totals per payer. Members or a `wallet:read` agent — the revenue-collector pattern. |
| **Invoices** | `invoiceService.ts` · `POST/GET …/wallet/invoices`, `…/{id}/void` | The payee's claim for delivered work, attached to the broadcast. The payer settles *the invoice* (`POST …/wallet/settlements { invoiceId }`), so chain, asset and amount come from the payee's ledger, not the paying agent's context. Marked PAID when the chain confirms. Both memories record issue and receipt. |
| **Settlement auto-accept** | `settlementPolicyService.ts` · `…/wallet/settlement-policies` | The `AutoAcceptPolicy` pattern pointed at money: an OWNER/ADMIN says "this partner, this chain and asset, up to this ceiling, without asking". The plane still runs all five checks and the envelope still refuses first; the policy answers only the escalation — through the same `resolveDecision` a human uses, as the human who set the policy — so the decision log reads the same. If that person no longer holds the role, the escalation stands. |
| **Delegated authority** | `delegateEnvelope` · `POST …/wallet/envelopes/delegate` (`wallet:delegate`) | A human marks an envelope `delegable`; its agent may then carve sub-envelopes for other agents. **Monotonic on every axis**: kinds, assets and destinations are subsets; every cap at most the parent's; escalation at least as strict; children's daily caps are partitioned out of the parent's, whose own spendable daily shrinks by the same amount. The target must not hold a human-set envelope. Every delegation is a recorded LOW decision and a capture. Superseding or revoking the parent revokes the children, recursively. |
| **Weekly metrics** | `walletMetricsService.ts` · `GET …/wallet/metrics?days=` · `recordWeeklyWalletMetrics` | Human asks per hundred writes, reason coverage (should be 1), settlement latency from proposal to chain (mean, median, samples), plus the counts they are made of. `recordWeeklyWalletMetrics` writes a `wallet/metrics` capture once per ISO week for the brain's weekly review. |

## The delegation, precisely

```
human   ──sets──▶  treasury envelope   perTx 500 · daily 1000 · auto 100 · delegable
treasury ──carves─▶ procurement-1      perTx 200 · daily 600 · auto 50     (decision d1)
treasury ──carves─▶ procurement-2      perTx 200 · daily 400 · auto 50     (decision d2)
                    treasury's own spendable daily is now 1000 − 600 − 400 = 0
treasury ──carves─▶ procurement-3      daily 1                             REFUSED: DELEGATION_EXCEEDS_PARENT
human   ──revokes─▶ treasury envelope                                      procurement-1 and -2 revoked with it
```

Why the partition rather than a shared ledger: a shared ledger would let a
parent and its children race for the same budget, and the serializable
reservation would have to span every envelope in the tree on every
proposal. A static partition is checked once, at delegation, and makes
"parent + children ≤ what the human set" true by construction. The cost is
that a delegator gives up daily capacity it is not using; that is the
correct direction to be wrong in.

Why the target may not already hold a human-set envelope: an agent narrows
what it has; it never replaces what a person decided, even with something
narrower.

## New scope

`wallet:delegate`. Moves no money. Like `wallet:propose`, it never sits on
a token with `wallet:settle` (`SCOPE_CONFLICT` at grant time).

## Coverage

`walletProduct.integration.test.ts` (15 tests: every monotonicity axis,
the partition, replacement refused, cascade on supersede and revoke,
invoices end to end, the policy answering an escalation and standing down
above its ceiling, receipts in both vaults with stable addresses,
receivables, the three numbers computed from a scripted week) and
`wallet.product.routes.integration.test.ts` (who each route admits). The
network demo's numbers are unchanged: nothing here alters a verdict.

## What it does not do, and says so

- The metrics are per organization. A network-wide view (the §06 numbers
  in the boardroom brief) is a sum over orgs that nothing here computes.
- A settlement policy answers escalations only; it cannot widen an
  envelope, and it cannot pay an unlisted address.
- Receipts are pages, not proofs. The transaction hash on the page is what
  a reader verifies on the chain; the page is where they find it.
