# Network — the numbers, from the organizations that chose to count (Phase 21)

Status: built and tested · 2026-09-20

## What it is

One boolean per organization, set by its OWNER: whether its weekly wallet
metrics are summed into a public figure. `GET /api/v1/public/network/wallet`
answers with the sums over the last seven days and **how many organizations
contributed**. It is honest about zero: no contributors, no numbers, `null`
ratios. Nothing per-organization is ever public — only the sums — and an
organization that opts out leaves the next summary.

| Field | Meaning |
|---|---|
| `contributing` | organizations with the switch on |
| `writes`, `humanAsks`, `humanAsksPerHundredWrites` | summed writes; summed escalations; the ratio over the sums |
| `reasonedOutcomes`, `reasonCoverage` | summed; the ratio |
| `settlementsPaid { attempted, settled, reverted, refused, pending }`, `settlementsReceived` | summed |
| `settlementLatencySeconds { median, samples }` | the median of each contributor's median, with the pooled sample count — labelled as such |

## Routes, page, object

| | |
|---|---|
| `GET /orgs/{orgId}/wallet/sharing` | `{ share }` — members |
| `POST /orgs/{orgId}/wallet/sharing { share }` | OWNER only; ADMIN is `NOT_AUTHORIZED` |
| `GET /api/v1/public/network/wallet` | public, rate-limited, `Cache-Control: no-store` |
| `/network` in `apps/web` | the summary with the contributing badge; for a signed-in OWNER, one switch: *Count our numbers* / *Stop counting* |
| `org.network.share(bool)`, `org.network.summary()` | the object |

## Proof

- `packages/api/src/services/networkWalletService.integration.test.ts` (2) — two orgs with activity (allow / escalate / deny; allow / allow): none opted in → zeros and nulls; one → its exact `walletMetrics` (3 writes, 1 ask, 33.33 per hundred); both → 5 writes, 20 per hundred; opting out drops the count; an ADMIN is refused; the routes gate as stated; the public route needs nothing.
- `apps/web/src/app/(dashboard)/network/network.test.tsx` (2) — honest zeros rendered as words; the count and ratios rendered; an OWNER's click posts `{ share: true }` and the count moves; a non-owner sees `NOT_AUTHORIZED` in the API's words.
