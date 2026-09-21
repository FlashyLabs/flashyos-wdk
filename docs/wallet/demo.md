# The demo — one AAO, four agents, four kinds of authority

Status: runs · `npm run wallet:demo` in `packages/api` · pinned by
`src/lib/wallet/demo/scenario.integration.test.ts` · 2026-09-19

Not a wallet integration: an autonomous organization with differentiated
economic agency, end to end through the real authorization plane, the real
Decision ladder, the real signer with signature and re-derivation checks, and
a mock chain. Every number below is asserted by a test, so a change to the
plane shows up as a change here.

## The org

| Agent | Envelope (chain `evm:8453`, asset USD₮) | What it proves |
|---|---|---|
| `revenue-collector` | `wallet:read` only. **No envelope.** | An address that accrues with zero spend surface. |
| `research-ops` | 3 vendor addresses · per-tx $100 · daily $100 · auto-approve ≤ $25 · escalates at MEDIUM | Graded autonomy: a human is asked a few times a week, not forty times a day. |
| `market-ops` | kind `swap` only · destinations **none** · $5,000 per swap | Capability-shaped authority: may rebalance internally, may never send out, at any amount. |
| `treasury` | 3 vendor addresses · per-tx $1M · **always escalates at CRITICAL** | The human stays in the loop exactly where they belong. |

One correction made under contact with code: the brief said research-ops has
"$25 per transaction; $25–100 escalates", which is not a consistent envelope.
`perTxMax 100 / autoApproveMax 25` is what the brief meant.

## The week (22 proposals)

```
day 1  research-ops → transfer $12 USD₮ to dataCo        ALLOW (auto-approved at LOW)
day 1  research-ops → transfer $8 USD₮ to computeCo      ALLOW
day 1  market-ops   → swap $500 USD₮                     ALLOW
day 1  revenue-collector → transfer $1                   DENY NO_ENVELOPE
day 2  research-ops → transfer $60 to researchCo         ESCALATE at MEDIUM → owner APPROVED → issued, confirmed
day 2  research-ops → transfer $15 to a stranger         DENY DESTINATION_NOT_PERMITTED
day 2  market-ops   → transfer $50 to dataCo             DENY KIND_NOT_PERMITTED
day 3  treasury     → transfer $40,000 to researchCo     ESCALATE at CRITICAL → owner APPROVED → confirmed
day 3  treasury     → transfer $250,000 to a stranger    DENY DESTINATION_NOT_PERMITTED  (never reaches a human)
day 3  research-ops → transfer $20 to dataCo             ALLOW
day 4  research-ops → transfer $25 to computeCo          ALLOW → chain REVERTED → budget released
day 4  research-ops → transfer $25 ×3                    ALLOW ×3 (fits only because the revert released $25)
day 4  research-ops → transfer $30 to dataCo             DENY DAILY_CAP  (75 + 30 > 100; refused before grading)
day 5  research-ops → transfer $90 to dataCo             ESCALATE → owner REJECTED → budget released
day 5  research-ops → transfer $20 to dataCo             ALLOW → signer handed a call to a STRANGER → REFUSED MISMATCH
day 5  treasury     → transfer $5,000 to computeCo       ESCALATE at CRITICAL → owner APPROVED → confirmed
day 5  market-ops   → swap $1,200 USD₮                   ALLOW → through the signer, confirmed
day 5  market-ops   → swap $800 USD₮                     ALLOW → signer handed a $4,000 swap → REFUSED MISMATCH
day 6  research-ops → transfer $5 to dataCo              ALLOW
day 6  research-ops → transfer $5 in the wrong asset     DENY ASSET_NOT_PERMITTED
day 7  nightly: 2 unspent authorizations expired (the tampered ones), budget returned
```

## The closing frame

| | |
|---|---|
| proposals | **22** |
| allowed / escalated / refused | **12 / 4 / 6** |
| humans asked | **4** (approved 3, rejected 1) — out of 22 writes |
| refusals, by reason | `NO_ENVELOPE` 1 · `DESTINATION_NOT_PERMITTED` 2 · `KIND_NOT_PERMITTED` 1 · `DAILY_CAP` 1 · `ASSET_NOT_PERMITTED` 1 |
| executed on chain | **12 confirmed, 1 reverted** |
| signer refusals | **2** — `MISMATCH` twice: a valid transfer authorization with a call to the wrong payee, and a valid $800 swap authorization with a call that swaps $4,000 |
| memory captures | **41** — allow 12 · escalate 4 · approved 3 · rejected 1 · deny 6 · settled 12 · reverted 1 · expired 2 |

Every one of the 41, including each refusal, carries a recorded reason.

Under per-write elicitation the same week would have asked a human **22
times** and recorded nothing about why any of them said yes.

## What it does not show, and says so

- Swaps go through the signer's re-derivation from WDK's swap options
  (Phase 7): the mock chain executes them, and `WdkChain` executes them
  through a registered WDK swap protocol — which a bare testnet run does not
  have, so `wallet:testnet` authorizes them and records "not executed".
- The chain is a mock. `WdkChain` is built and tested against the real WDK
  policy engine (see [`testnet.md`](testnet.md)), but nothing in this
  repository has reached a live network.

## Running it

```
cd packages/api
DATABASE_URL=postgresql://… npm run wallet:demo
```
