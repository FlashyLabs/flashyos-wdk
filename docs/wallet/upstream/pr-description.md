# Upstream PR description — draft

Status: **draft, not opened** · 2026-09-21. Opening it is a human's
decision. Re-read PR #88 on the day; if the contract moved, the first
paragraph changes.

---

**Title:** Reference remote-authorization policy, extractor packs and a
threat model for LLM-driven callers

**Summary**

This adds, as a reference and not as a framework: a `TransactionPolicy`
that defers every write to an external authorizer over a network; extractor
packs that turn `sendTransaction`, `transfer`, `swap` and `bridge` calls
(EVM) and `sendTransaction`/`transfer` (TRON) into an `OperationRecord`;
and a written threat model for the case where the caller is a language
model with untrusted text in its context.

It is built against the draft `TransactionPolicy` contract in #88 and
carries its own copy of the types so the diff to the merged version is
obvious. It also includes an async *rule* for the policy engine as
shipped, with no dependency on #88, so the pattern is usable today.

**Two observations about the contract, which we think belong in its docs**

1. `abstain` is defined as "matched but unable to judge" and does not
   constitute a vote, so default-deny holds. That gives any policy that
   consults something remote fail-closed semantics for free: unreachable →
   `abstain` → `NO_APPLICABLE_RULE`. No timeout branch, no fail-open edge.
   `transactionPolicy.test.ts` demonstrates it against a reference engine
   implementing the documented semantics. We would suggest the contract's
   docs say this explicitly.
2. `commit`/`rollback` are the hooks a budget *ledger* needs, as opposed to
   a counter. A reservation held at `evaluate`, committed at `commit`,
   released at `rollback` is correct on both a revert and a double-submit.
   Our two-phase ledger is the worked example.

**Four things we verified against the engine that others may want to know**

- A registered protocol's `swap`/`bridge` is intercepted as its own
  operation on a governed account, so a rule can cover protocol methods
  without touching the account's `sendTransaction`.
- Deny-by-default on a governed account refuses `approve`, `transfer`,
  `signTypedData` and `delegate` with `NO_APPLICABLE_RULE` when a policy
  addresses only `sendTransaction` — the property that makes a single
  narrow ALLOW rule a useful second line.
- `waitForTransaction` is governed by default (`src/policy/constants.js`,
  beta.18) while `getTransaction` and `toReadOnlyAccount` are excluded, so a
  backend waiting for its own receipt is refused by its own rule. We use
  `policyExclusions`; a one-line change to the default list would fix it.
- The seed-derived EVM signer's `signTypedData` throws `NotImplementedError`
  (`wdk-wallet-evm` beta.19); only the private-key signer implements it. The
  HD node wallet it derives already can; an x402 buyer on a seed-derived
  account needs it.

**What this is not**

It is not a security boundary inside the WDK process. The contributor
guide documents the underscore bypass, and our threat model treats the
in-process engine as a second line behind an isolated signer that
re-derives every operation from the real call. We would rather the PR say
this than have a reader assume otherwise.

**Where should it live?**

We have no view we would defend. Under `tetherto/wdk` as a reference
policy, or as an ecosystem module under our name with a pointer from the
showcase — whichever the maintainers prefer.

**Tests**

117 in the adapter package, 91 in the signer, 34 in the agent object, all
against the installed `@tetherto/wdk` beta.18 engine where the engine is
involved. Coverage of
what the extractors accept and refuse is published as
`docs/wallet/schema/extractor-packs.json` and drift-checked.
