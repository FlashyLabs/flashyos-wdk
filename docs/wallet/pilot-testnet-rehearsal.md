# The pilot, rehearsed on a testnet — and the mainnet pilot, recorded as not ours to start

Status: Phase 8 · procedure written; **nothing below has been performed** ·
2026-09-19

## The decision this document records

Phase 8 of the roadmap is the thirty-day pilot holding real value. It is
**out of scope for now, by decision: this codebase links to testnets
only.** Nothing in this repository can construct a mainnet chain backend
(`packages/signer/src/testnets.ts`), and this document does not describe
how to. Starting the mainnet pilot is a human decision that requires, in
order: counsel's scoping in [`runbook.md`](runbook.md) §8; a Tier 1 custody
setup including an on-chain limit that WDK's ERC-4337 module does not
provide ([`testnet.md`](testnet.md)); a reviewed pull request adding a
chain to `testnets.ts`; and this rehearsal, passed.

What Phase 8 delivers instead is the same thirty days, the same gates, on a
testnet with a test asset — so that when the humans decide, the procedure
has already been run once by the people who will run it.

## What the rehearsal proves, and what it cannot

| Proves | Cannot prove |
|---|---|
| The plane, signer and nightly run unattended for thirty days without an anomaly | That anyone would notice a loss, because there is nothing to lose |
| Every movement is explainable from the audit trail without an engineer | That the RPC provider and bundler behave under mainnet load |
| Zero `MISMATCH`, zero negative `remainingToday`, zero unexplained `ANOMALY` | Fee dynamics, MEV, or reorg depth on a busy chain |
| The operators know the runbook's stop procedures because they have used them | Regulatory exposure — that is counsel's, not a test's |

## Setup (once)

1. **Chain:** Base Sepolia (`evm:84532`). **Asset:** the native coin, so
   every amount is wei and faucet-funded. (A test ERC-20 works the same way
   if one is deployed; the envelope's `assets` then lists its address.)
2. **Seed:** a testnet-only phrase, Tier 0 (`WALLET_CUSTODY_TIER=0`,
   `WDK_SEED` in the signer's environment). It must never hold mainnet
   value. Fund `getAccount('evm', 0)` from a faucet with ~0.05 test ETH.
3. **Plane:** `packages/api` with Postgres, `WALLET_AUTHZ_PRIVATE_KEY` from
   a real pair (`runbook.md` §1), the nightly `expireStaleAuthorizations()`
   scheduled.
4. **Signer:** `packages/signer` as its own process, `FileNonceStore` on a
   persistent volume, `WdkChain` with `receipts.confirmations ≥ 2`, the
   settlement reporter holding the `wallet:settle` token and nothing else.
5. **Org and agents:** one org; two operating agents with `wallet:propose`
   and the runbook's suggested envelope scaled to wei
   (`perTxMax` 25 × 10⁶, `dailyMax` 100 × 10⁶, `autoApproveMax` 10 × 10⁶);
   a third agent with `wallet:read` and no envelope. Treasury does not
   participate — as in the real pilot.
6. **Traffic:** a scheduled job that proposes a realistic day's writes —
   the shape of the four-agent week's Monday and Thursday, at the wei scale
   — so the plane has something to govern every day. The point is
   unattended operation, not volume.

## The thirty days

Each morning, one person reads three things and writes one line in the
org's memory:

- `GET …/wallet/ledger` — `remainingToday` never negative.
- The previous day's `wallet/*` captures — every `allow` is one a human
  would have approved; every `deny` names a reason; any `ANOMALY` is an
  incident with a write-up.
- The signer's `pendingExecutions` and `unreportedSettlements` — both
  empty, or each entry reconciled on the explorer and retried.

Once a week, someone who is not the operator picks three settled
authorizations at random and explains each from the audit trail alone. If
they need an engineer, the day fails.

At least once during the thirty days, on purpose: revoke an envelope
mid-escalation and confirm the later approval is not issued; revoke the
signer's `wallet:settle` token and confirm issued authorizations expire
unspent within five minutes; restart the signer and confirm a replayed
authorization is `REPLAY`, not executed.

## Acceptance — `runbook.md` §6, unchanged

Thirty consecutive days with all five conditions true on every day. A
failed day restarts the count after its cause is fixed and written up.

## What passing does and does not mean

Passing means the procedure works and the operators can run it. It does not
mean the mainnet pilot may start; that needs the four items in the first
section, in order, and a human's decision at each. This document will not
be updated to say otherwise.
