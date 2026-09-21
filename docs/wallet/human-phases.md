# The phases a person runs — 11, 13, 15, 16

Status: recorded, not performed · 2026-09-20

Four phases of the Rev D.1 roadmap need a person more than they need code.
Each has everything this repository can provide already in place; each has
a gate this repository cannot close. This page says, for each, what is
ready, what the person does, and what "done" looks like — so none of them
is mistaken for something an agent could finish.

## Phase 11 — the testnet week, run by a human, with hashes

**Ready:** `npm run wallet:testnet -- --chain evm:84532 --confirmations 2`
(EVM, native asset) and the rehearsal that pins its governance numbers;
`WdkTronChain` for `tron:nile` / `tron:shasta`; the network demo, which
takes the same backend. [`testnet.md`](testnet.md) has the prerequisites.

**The person:** generates a testnet-only seed, funds it from a faucet, runs
the week, records the transaction hashes in the org's memory, and links
them from the application draft's placeholder.

**Done:** fourteen confirmed transfers on Basescan; `pendingExecutions`
empty; the closing frame's governance numbers identical to the pinned
rehearsal. Not done from here: this environment has no RPC egress.

## Phase 13 — send what is drafted

**Ready:** [`upstream/partner-program-application.md`](upstream/partner-program-application.md)
(both tracks), [`upstream/pr-description.md`](upstream/pr-description.md),
the three findings for upstream (`abstain` semantics, `commit`/`rollback`
as ledger hooks, `waitForTransaction` governed by default), and the list of
sentences that must not appear.

**The person:** replaces or removes every placeholder, adds the Phase 11
hashes, re-reads PR #88 on the day, and sends. Says only what is true about
the relationship.

**Done:** a reply from an engineer on their side about the pattern or
about on-chain limits. Not a partnership; a conversation on engineering
terms. Not done from here: nothing is submitted externally without a
human's decision.

## Phase 15 — two organizations settle a month, on testnet

**Ready:** invoices, settlement policies, receipts in both brains,
receivables, the weekly `wallet/metrics` capture, the `/wallet` page, and
the object (`@flashyos/wdk`) for the agents on both sides. The network demo
is the rehearsal of the shape; the month is the shape lived.

**The person (two of them):** two real organizations on FlashyOS, each with
an OWNER, post work, claim it, invoice, settle under a policy, and read
their receivables and receipts for thirty days on Base Sepolia.

**Done:** neither side's finance function has reconciled anything by hand
and the weekly captures show it — reason coverage 100% every week,
receivables equal to the chain. This is also the first measurement of the
stickiness Rev D.1 §05 asserted; until it happens every sentence about
switching cost is a prediction.

## Phase 16 — enabling a chain

**Ready:** nothing, deliberately. `packages/signer/src/testnets.ts` is the
list; no mainnet is on it and no flag widens it.

**The person:** not before Phases 11, 12 and 15 have passed, counsel has
scoped the regulatory exposure ([`runbook.md`](runbook.md) §8), and Tier 1
custody exists with the on-chain limit from Phase 12
([`onchain-limit.md`](onchain-limit.md)). Then one pull request adds one
chain to the list — which will need a new name — and the thirty-day pilot
from the runbook begins with real value.

**Done:** runbook §6, on a chain that holds value. This document does not
describe how to do it sooner.
