# WDK Partner Program — application

Status: **ready to submit** · 2026-09-21 · submitting is a human's
decision. The evidence links point at the public mirror
`github.com/FlashyLabs/flashyos-wdk` (built by `scripts/build-wdk-mirror.sh`);
create it and push it before sending, or replace the links.

Two tracks, applied for together, because the work is both: we extend WDK
(a policy pattern, extractor packs, a threat model for LLM-driven callers,
four findings from running the shipped engine) and we distribute it (every
FlashyOS organization that turns on economic agency does so on WDK). The
Project Partner track is reported to exist and is not confirmed in anything
we could read; if it does, the same text applies.

Every sentence below is true today. Nothing may be added that is not.

---

## Tech Contributor track

**Who we are.** Flashy Labs builds FlashyOS, an operating system for
autonomous agent organizations: organizations whose members are agents with
identity, roles, a shared memory and a decision log, working with each
other across organizational boundaries.

**What we built on WDK.** An authorization plane that sits between an
agent's proposal to move money and a signer that holds WDK. An agent
proposes an operation; the plane checks identity, authority, a per-agent
spending envelope, a two-phase daily budget, and grades the result — allow,
escalate to a named human, or refuse with a coded reason. Allowed
operations become a short-lived, single-use, Ed25519-signed authorization;
an isolated signer re-derives the operation from the actual WDK call,
refuses any mismatch, executes through WDK's EVM or TRON module, and
reports settlement. WDK's own policy engine runs inside the signer as a
deny-by-default second line that admits only the operation in flight. Every
outcome, refusals included, is written into the organization's memory with
its reason.

On that plane: settlement between organizations with receipts in both
memories; per-agent derived accounts mirrored into a Safe Allowance Module
plan; metered spend under one decision; signed invoices to and from payees
outside FlashyOS, with receipts anyone verifies against the plane's public
key; x402 as buyer and as seller; a hash-chained export of every wallet
fact sealed by a signed Merkle root; and federation between planes through
a well-known key document and a per-organization trust registry.

**Where it runs.** Testnets only — Base Sepolia, Ethereum Sepolia, Arbitrum
Sepolia, OP Sepolia, TRON Nile and Shasta — by decision, with no flag in the
code that widens the list. No live network has been touched from our side;
every live run is rehearsed against scripted chains with the same gates,
and pinned by test.

**What we would contribute** (Apache-2.0, in the public mirror's
`packages/wallet-wdk` and `packages/signer`, prepared as an upstream PR from
`docs/wallet/upstream/`):

1. A `TransactionPolicy` implementation against PR #88's draft contract
   that defers to an external authorizer, with two observations about the
   contract — `abstain` gives remote policies fail-closed semantics for
   free; `commit`/`rollback` are exactly the hooks a budget ledger needs.
2. An async policy rule for shipped WDK (no #88 dependency) that covers
   `sendTransaction`, `transfer`, `swap`, `bridge` and `signTypedData`,
   verified against the engine's actual interception of protocol methods.
3. Extractor packs — EVM (native, ERC-20, Safe Allowance Module transfers,
   EIP-3009 typed data, swap, bridge) and TRON (TRX, TRC-20) — with a
   published, drift-checked manifest of what they vouch for and refuse.
4. A client for `@tetherto/wdk-mcp-toolkit`'s elicitation that answers the
   confirmation with a policy verdict instead of a click, parsed from the
   toolkit's actual confirmation messages.
5. A threat model for LLM-driven callers, written against WDK's own
   contributor guide.

**Four findings from running the shipped engine**, offered as feedback:

1. `waitForTransaction` is governed by default on a governed account
   (`src/policy/constants.js`, beta.18): a backend waiting for its own
   receipt is refused by its own second line. Consumer remedy
   `policyExclusions`; we would propose the default list include it.
2. The seed-derived EVM signer's `signTypedData` throws `NotImplementedError`
   (`wdk-wallet-evm` beta.19); only the private-key signer implements it, so
   a seed-derived account cannot answer an x402 402 today. We report it as
   `TYPED_DATA_UNSUPPORTED` rather than work around it.
3. The ERC-4337 module has no session-key or spending-limit surface; an
   on-chain limit needs a Safe module outside WDK today. We built the
   Safe Allowance Module as the signer's third line and a plan generator
   that mirrors the envelope tree.
4. The MCP toolkit's elicitation carries the confirmation text rather than
   the transaction; a structured field alongside the message would let a
   policy client re-derive without parsing prose.

The policy engine's deny-by-default on governed accounts, and its
interception of protocol methods and typed-data signing, are exactly right
for a second line — we rely on all three.

**Evidence.** The public mirror `github.com/FlashyLabs/flashyos-wdk`:
`npm install && npm run typecheck && npm test` runs 242 tests across the
three packages, against the installed `@tetherto/wdk` engine where the
engine is involved, on Node 22. The documents under `docs/wallet/` describe
the plane, the demos (a four-agent week and a twenty-organization network,
frames pinned by test in the FlashyOS repository), the testnet rehearsal,
the runbook, and the published JSON Schemas and OpenAPI fragment. A testnet
run performed by a person, with transaction hashes on Base Sepolia, is the
next step and is not claimed here.

**The ask.** A review of the remote-authorization pattern by an engineer
on the WDK side — is `abstain`-on-unreachable the intended use, and is an
`OperationRecord` extractor pack the intended way to add chain coverage —
and a view on where it should live: upstream as a reference policy, or as
an ecosystem module with a pointer from the showcase.

## Consulting & Implementation track

**What we would offer.** For an organization that wants agents holding
governed economic agency on WDK: the authorization plane as the piece
between their agents and their keys — envelopes, escalation to their own
people, a settlement layer between organizations with verifiable receipts,
metered spend, and an audit trail in which every payment carries a reason
and the whole history exports as a sealed hash chain. Custody stays theirs;
WDK stays the wallet.

**What we would not offer.** Custody. Regulatory advice. Anything
described as a security boundary that runs inside the WDK process.

## Numbers

Every number is from a test run in the repository, on 2026-09-21.

- tests: 1,345 across seven workspaces in FlashyOS; 242 in the public
  mirror's three packages
- wallet routes in the OpenAPI fragment: 42 paths, drift-checked against
  the route files
- published schemas: 8, generated from the enforced validators, refused on
  drift
- testnets: 6, two chain families
- organizations with economic agency enabled in production: **none yet**;
  this is a testnet-only build by decision

## Sentences that must not appear

- "one of the largest WDK projects" — we cannot know that
- "nobody has given agents WDK capabilities" — the toolkit did, and the
  hackathon projects did
- "partnered with Tether", "in partnership with", "backed by" — none is
  true
- "production", "mainnet", "real value" — testnets only, by decision
