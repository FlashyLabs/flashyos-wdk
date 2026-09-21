# Threat model — LLM-driven agents as callers of Tether WDK

Status: published for review · Phase 0 of `docs/wallet/roadmap` · 2026-09-19

This document exists because Tether's Wallet Development Kit ships two controls
for constraining what a caller may do, and both are correct for the case they
were designed for and wrong for an organization running autonomous agents. It
names the attacker, the four paths, and what defeats each. It is written to be
argued with; a threat model that survives nobody trying to break it is a wish.

## 1. What WDK provides today (verified from source)

- **Core policy engine** (`@tetherto/wdk`): deny-by-default at a JavaScript
  Proxy surface, rules of `{ operation, action, conditions }`, three denial
  codes (`RULE_DENIED`, `NO_APPLICABLE_RULE`, `GOVERNED_BUT_UNMATCHED`).
  WDK's own contributor guide states that enforcement applies to the proxy
  surface only and that underscore-prefixed fields reach the raw account and
  bypass enforcement *by design* — private by convention.
- **MCP toolkit** (`@tetherto/wdk-mcp-toolkit`): exposes wallets to agents as
  tools. Seed is read from the environment (`WDK_SEED`, `WDK_SEED_COMMAND`,
  `WDK_SEED_FILE`). Every write is gated by an MCP elicitation requiring a
  human to approve before broadcast. Its documentation mentions no spending
  limits, policies or organizational controls.

Neither is a defect. Both assume the process running WDK is trusted.

## 2. The attacker

The attacker is **whoever can influence the text a language model reads**.
That includes a web page the agent fetches, a tool result, a document in the
org's own memory that was captured from outside, and a counterparty's message
in a cross-org negotiation. The agent runtime — model, tool loop, MCP client —
is therefore an **untrusted process**. Everything it can reach, the attacker
can reach.

This is the assumption that breaks both of WDK's controls:

| Control | Assumes | Breaks because |
|---|---|---|
| In-process policy engine | the process has no adversary inside it | the process *is* the adversary's foothold; the documented bypass is one underscore away |
| Per-write human elicitation | one human, one wallet, attention to spare | an organization's agents make more writes than a human can judge, so the control degrades into rubber-stamping — a record that looks like oversight |

## 3. Four paths

### P1 — Prompt injection to a legitimate-looking transfer
Untrusted text persuades the agent to propose a transfer that is well-formed,
plausibly justified, and to an attacker-controlled destination. Under
per-write elicitation, a fatigued approver clicks yes.

**Defeated by:** a destination allowlist enforced *outside* the agent process,
and an exact-asset envelope. The agent may propose anything; the plane refuses
anything not on the list. Approval fatigue is removed by grading: only
proposals above threshold reach a human, so the ones that do are rare enough
to be read.

### P2 — In-process bypass
Code executing in the agent's process reaches past the Proxy to the raw
account, or reads the seed from the environment. No policy defeats this,
because the policy lives in the same process.

**Defeated by:** the seed never being in the agent's process. The signer is a
separate service; the agent holds a bearer token that can only *propose*. A
fully compromised agent can produce an unlimited number of proposals and
cannot sign one of them.

### P3 — Budget exhaustion
Many individually-permitted operations drain an account no single rule would
refuse. A per-transaction cap does not prevent this; a daily counter enforced
at submission is wrong (reverts burn budget) and at confirmation is wrong
(double-spend window).

**Defeated by:** a two-phase budget ledger. Amount is *reserved* at
authorization under a serializable transaction, *committed* on chain
confirmation, *released* on revert or expiry. Concurrency against one envelope
is a test, not a hope (see `spendEnvelopeService.integration.test.ts`).

### P4 — Silent authority accrual
An agent's permissions grow over time and nobody notices, because nothing
records what it was allowed to do last month or why a change was made.

**Defeated by:** envelopes as first-class rows with history, every verdict
(including refusals) captured into the org's memory with its evidence, and
the whole log under a published Merkle root. "Why did this agent spend $4,000
on the 12th" is answerable with citations.

## 4. What this design does NOT claim

- It does not make the policy engine inside the signer a security boundary.
  WDK's policy engine is used there as a **second line** — defence in depth
  against our own bugs — never as the line.
- It does not protect against a compromised **authorization plane**. That is
  the job of the on-chain layer (ERC-4337 session-key limits, multisig above a
  ceiling), which must hold when FlashyOS is wrong. See `spec.md` §8.
- It does not solve regulatory exposure. Agent-initiated transfers on behalf
  of an organization raise money-transmission and travel-rule questions that
  architecture cannot answer.

## 5. Invariants the tests enforce

1. A `SpendAuthorization` whose payload has been altered after signing is
   refused by the signer.
2. Two concurrent proposals against one envelope whose combined amount exceeds
   the daily cap cannot both be authorized.
3. When the authorization plane is unreachable, the outcome is refusal — never
   a spend, never a hang that resolves to a spend.
4. An agent token holding only `wallet:propose` cannot report settlement, and
   one holding only `wallet:settle` cannot propose.
5. An authorization names an exact asset contract and exact destination; a
   symbol or a prefix is not an address.
