# The plane gets a face — `/wallet` in `apps/web`

Status: Phase 14 · built and tested · 2026-09-20

Every capability of the plane was a route. The people who set envelopes,
answer escalations, mark an envelope delegable and read a receipt are
humans with a browser. This is their page.

## What is on it

| Panel | Reads | Acts | Route |
|---|---|---|---|
| **This week** | writes, human asks per hundred, reason coverage, median settlement latency, paid / received | — | `GET …/wallet/metrics?days=7` |
| **Asking a human** | wallet decisions only (`Spend:` / `Delegate:`; the org's other decisions stay on the dashboard), pending first | Approve · Reject | `GET …/decisions` · `POST /api/v1/decisions/{id}/resolve` |
| **What each agent may spend** | active envelopes as a tree — delegated envelopes indented under their parent with `via <delegator>` | Set envelope (form, incl. *always ask a human* and *may delegate narrower envelopes*) · Revoke | `GET/POST …/wallet/envelopes` · `POST …/wallet/envelopes/revoke` |
| **Today** | the ledger: daily cap (after delegations), reserved, committed, remaining; negative remaining in red | — | `GET …/wallet/ledger` |
| **Money in** | totals per chain/asset (received · expected · invoiced), then every settlement with its status and hash | Receipt — opens the page from this org's vault with its `mind:` address | `GET …/wallet/receivables` · `GET …/wallet/receipts/{id}` |

No new authority anywhere: every button calls a route a member with that
role could already call with `curl`, and the API's refusals are shown in
the API's own words (`ENVELOPE_INVALID_CAPS: perTxMax cannot exceed
dailyMax`). Amounts are shown as money for six-decimal assets and as base
units otherwise; the form takes base units and says so.

## The gate, and how it was recorded

*An OWNER sets an envelope, approves an escalation, and reads the receipt
for the payment it produced without opening a terminal — recorded as a
browser test.*

`src/app/(dashboard)/wallet/wallet.test.tsx` renders the five panels over
the real `useWallet` hook in jsdom, with a recording `fetch` that answers in
the shapes the routes return, and drives exactly that path: the form is
filled and submitted (the API's refusal is shown, then the corrected
envelope appears in the table and the ledger), *Approve* is clicked (the
resolve route is called with `approve: true` and the row leaves the queue),
*Receipt* is clicked (the receipt's claim address and transaction hash are
on screen). Five tests; `npm test` in `apps/web`.

**What that is and is not.** jsdom is a DOM, not Chromium, and the API is
a recording double. It proves the screen calls the right route with the
right body and shows what comes back; it does not prove the page renders
pixel-correctly or that the real API answers — the routes have their own
tests for that. A Playwright run against a live API, Postgres and Next
server is the stronger recording and is the natural next step once a
person runs the stack.

## Running it

```
cd packages/api && DATABASE_URL=… npm run dev     # :3001
cd apps/web && npm run dev                         # :3000 → /wallet
```

`NEXT_PUBLIC_FLASHYOS_API_URL` points the page at the API (default
`http://localhost:3001`). Sign in as an OWNER or ADMIN; a member sees the
panels and cannot set or resolve anything, because the routes refuse.
