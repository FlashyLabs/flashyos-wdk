# Meter — paying by the unit under one decision (Phase 19)

Status: built and tested · 2026-09-20

## What it is

A per-transaction envelope is the wrong shape for a thousand tiny payments
to an inference or compute provider. A meter is the right one:

| Step | What happens | Who decides |
|---|---|---|
| **open** | the plane reserves a cap for one provider and grades it once — the same checks as a spend of the cap, the same decision ladder (`kind: meter` must be on the envelope; the provider on the allowlist; cap ≤ perTxMax; cap within today's budget; over autoApproveMax escalates) | the plane, or a human |
| **tick** | the agent records units and their cost against the cap — no plane round-trip, no decision; refused only past the cap (`METER_CAP`) | nobody: the cap was the decision |
| **close** | the provider's own count is reconciled against the agent's; within `toleranceBps` of `used`, one transfer authorization is issued for `min(providerAmount, min(used + tolerance, cap))` and the rest of the cap is released; otherwise `METER_DISAGREE` (or `METER_EMPTY`), the cap released, the difference recorded | arithmetic |

Below the plane nothing knows what a meter is: the close is a transfer the
signer re-derives like any other. `meter` exists as an operation kind only
at the plane (the published `operation-record.json` names it).

## What was built

| Piece | Where |
|---|---|
| `Meter`, `MeterTick`, `MeterStatus` (PENDING · OPEN · CLOSED · REFUSED · REJECTED) | `packages/api/prisma/schema.prisma` |
| `openMeter`, `tick`, `closeMeter`, `onMeterDecisionResolved`, `onMeterSettled` (writes `receipts/meter/<id>`) | `packages/api/src/services/meterService.ts` |
| `issueTransferForReservation` — a transfer authorization against a reservation held as `meter`, the reservation lowered to what is paid | `packages/api/src/services/spendAuthorizationService.ts` |
| Routes: `POST/GET /wallet/meters`, `GET /wallet/meters/{id}`, `POST /wallet/meters/{id}/tick`, `POST /wallet/meters/{id}/close` | `openapi.wallet.json` |
| Object: `agent.wallet.meter.open / tick / close`, `org.meters()`; events `meter.opened / ticked / closed / refused` | `packages/wdk` |

Status codes carry the verdict as on `/proposals`: open is 201 ALLOW, 202
ESCALATE, 200 DENY; close is 201 closed with the authorization, 200 refused
with the code. A refusal is an answer, not an error.

## Proof

`packages/api/src/lib/wallet/demo/phases17-19.integration.test.ts`, from the run:

| Case | Result |
|---|---|
| open cap 400 000 at autoApproveMax 500 000 | ALLOW, OPEN, ledger reserves 400 000 |
| five ticks of 60 000; sixth of 200 000 | used 300 000, units 5 000, ticks 5; sixth `METER_CAP` 409; decisions unchanged |
| close with provider 5 010 units / 302 000 (tolerance 1 %) | CLOSED; authorization for 302 000; ledger holds 302 000 (98 000 released) |
| execute the authorization | executed; receipt page `receipts/meter/<id>` in RAW: "5000 token counted by the agent; 5010 by the provider", "Paid 302000 of a cap of 400000" |
| provider 90 000 against 50 000 used | `METER_DISAGREE`, REFUSED, difference 40 000, ledger 0 |
| nothing used, provider 0 | `METER_EMPTY`, cap released |
| cap 800 000 > autoApproveMax | ESCALATE, PENDING; tick refused `METER_NOT_OPEN`; rejection → REJECTED, ledger 0; approval → OPEN |
| provider not on the allowlist | DENY `DESTINATION_NOT_PERMITTED` |
| another agent ticks | `NOT_METER_AGENT` |

The object-level tests (`packages/wdk/src/agent.test.ts`) pin which
transport call each verb makes and which event it emits.

## What it leaves out

The provider's count is what the agent hands to `close`; the plane has no
channel to the provider. That is deliberate: a provider that disagrees has
an invoice to argue, and the difference is on the record either way.
