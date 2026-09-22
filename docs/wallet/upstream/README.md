# Upstream materials — what we would contribute to `tetherto/wdk`

Status: prepared, **not submitted** · 2026-09-21 · the
application text is [`partner-program-application.md`](partner-program-application.md)
and the PR text is [`pr-description.md`](pr-description.md), both drafts

Nothing in this directory has been sent to Tether. It is the material the
brief said to have ready before any approach: a working reference
implementation, a written threat model, and a specific, small ask. Submitting
is a human's decision.

## 1. What exists

| Artifact | Where | Licence | State |
|---|---|---|---|
| `RemoteAuthorizationPolicy` — a `TransactionPolicy` that defers to an external authorizer | `packages/wallet-wdk/src/transactionPolicy.ts` | Apache-2.0 | implemented against PR #88's contract as read from the draft; 21 tests |
| `AdapterRegistry` + extractor packs: EVM (`sendTransaction`, `transfer`, `swap`, `bridge`) and TRON (`sendTransaction`, `transfer`) | same file; `packages/wallet-wdk/src/extractors/` | Apache-2.0 | 50 extractor tests; refuses `approve`, `transferFrom`, arbitrary calldata, the buy side of a swap; coverage published as `docs/wallet/schema/extractor-packs.json`, drift-checked |
| A reference engine implementing the documented verdict semantics | `evaluatePolicies()` in the same file | Apache-2.0 | proves abstain-is-not-a-vote and deny-wins by test |
| An async policy *rule* for shipped WDK (no #88 dependency), covering the four write operations | `packages/wallet-wdk/src/policy.ts` | Apache-2.0 | 9 tests |
| An MCP elicitation handler and a client for `@tetherto/wdk-mcp-toolkit`'s actual confirmation messages | `packages/wallet-wdk/src/elicitation.ts`, `toolkit.ts` | Apache-2.0 | 19 tests; every non-ALLOW path is a decline; message formats copied from the toolkit's source |
| A signer backend on WDK with its policy engine as a deny-by-default second line, testnets only | `packages/signer/src/chain.ts` | Apache-2.0 | 27 tests against the installed engine and protocol base classes |
| Threat model for LLM-driven callers | `docs/wallet/threat-model.md` | — | published for review |
| Signed invoices and receipts, x402 buyer and seller, EIP-3009 typed data through the signer's ladder | `packages/wallet-wdk/src/interop.ts`, `x402.ts`; `packages/signer/src/signer.ts` | Apache-2.0 | 28 tests; the seed signer's missing `signTypedData` reported, not worked around |
| The provenance verifier: a hash-chained export checked with the plane's public key alone | `packages/wallet-wdk/src/provenance.ts` | Apache-2.0 | 4 tests; the API's Merkle root equals the verifier's by test |
| The public mirror of all of the above | `scripts/build-wdk-mirror.sh` → `github.com/FlashyLabs/flashyos-wdk` | Apache-2.0 | installs and tests standalone on Node 22 |

## 2. The two observations we would put in the PR description

Neither is in PR #88's own description, and both are about its design rather
than ours.

**`abstain` gives a remote authorizer fail-closed semantics for free.** The
draft defines `abstain` as "matched but unable to judge" and specifies that it
does not constitute a vote, so the engine's default-deny holds. That is
exactly right for a policy that consults something over a network: when the
authorizer cannot be reached, return `abstain`, and the operation is refused
by the engine's own rules — no timeout branch, no fail-open edge case. Our
test `abstain is not a vote: an unreachable plane leaves the operation with
NO_APPLICABLE_RULE` demonstrates it against a reference engine implementing
the documented semantics. We would propose the PR text say this explicitly,
because it is the property that makes remote policies safe to write.

**`commit` / `rollback` are the hooks a budget *ledger* needs.** A daily cap
kept as a counter is wrong in both directions — incremented on submission,
reverts burn budget; on confirmation, there is a double-spend window. A
reservation held at `evaluate`, committed at `commit`, and released at
`rollback` is right in both. The draft has the hooks; we would propose a
sentence in the docs naming the pattern, and our implementation as the
example.

**`waitForTransaction` is governed by default** (found in Phase 14½). On a
governed account the engine intercepts `waitForTransaction` — a read — and
refuses it with `NO_APPLICABLE_RULE`; `getTransaction` and
`toReadOnlyAccount` are excluded by default, `waitForTransaction` is not
(`src/policy/constants.js`, beta.18). A backend that waits for its own
receipt is blocked by its own second line. We use the consumer-side
`policyExclusions` and would propose the default list include it.

**The seed signer does not sign typed data** (found in Phase 18). In
`@tetherto/wdk-wallet-evm` beta.19, `signers/seed-signer-evm.js`'s
`signTypedData` throws `NotImplementedError`; only the private-key signer
implements it. An x402 payment is an EIP-3009 `transferWithAuthorization`
signed off-chain, so a seed-derived account cannot answer a 402 today. Our
backend reports this honestly as `TYPED_DATA_UNSUPPORTED`; we would propose
`signTypedData` on the seed signer (the HD node wallet it derives already
can) and note that `signTypedData` *is* governed by the policy engine, which
is right — our second line admits it only for the in-flight record.

**The bridge protocol module names no testnet chain** (found building Flashy
Bridge, 2026-09-21). `@tetherto/wdk-protocol-bridge-usdt0-evm` beta.10 moves
USDT0 and XAUt0 across EVM chains through LayerZero's USDT0 standard, and
every chain its `config.js` names is a mainnet chain — no Sepolia, no
Arbitrum Sepolia, nothing. Every other WDK wallet module we checked (EVM,
TRON, BTC) ships a testnet entry; the bridge module is the one exception. Our
own bridge router (`BridgeRouter.execute()`, in the reference routing layer
we are open-sourcing separately) refuses to execute against any route on this
module, unconditionally, for exactly this reason — a wrapper around a bridge
that offers no testnet has nothing safe to test against, and we would rather
ship a routing layer that refuses correctly than one that quietly risks real
value to prove itself works. We would propose a `testnet` (or per-chain
`network`) field in the module's route/chain config, mirroring how the
wallet modules already distinguish mainnet and testnet chains.

## 3. What we would ask for

Not a partnership. Three things an engineer can answer in an afternoon:

1. A review of the remote-authorization pattern — is `abstain`-on-unreachable
   the intended use, and is an `OperationRecord` extractor pack the intended
   way to add chain coverage?
2. A view on where it should live: upstream under `tetherto/wdk` as a
   reference policy, or as an ecosystem module under our own name with a
   pointer from the WDK showcase.
3. Whether a testnet chain is planned for
   `wdk-protocol-bridge-usdt0-evm`, and if a config-shape proposal from us
   (§2, above) would be useful ahead of that.

## 4. What we would not claim

- That our policy is a security boundary inside the WDK process. It is not;
  WDK's own contributor guide documents the underscore bypass, and our threat
  model treats the in-process engine as a second line. The boundary is the
  network hop to the authorization plane and the isolated signer.
- That we have a partnership with Tether. "Supports Tether WDK" and
  "contributed X upstream" are the only two sentences that are true.
- That the toolkit path has the signer's re-derivation in it. It does not:
  the toolkit holds the seed and broadcasts, and the plane's verdict —
  answered from the confirmation *message*, whose formats we copied from
  the toolkit's source — is the only line there. `docs/wallet/testnet.md`
  says so.
- That anything has run on a live network from our side, or that anything
  runs on mainnet. Testnets only, by decision.

## 5. Before submitting

- Re-read PR #88 on the day. It was a draft when this was written; the
  contract may have moved. `transactionPolicy.ts` carries its own copy of the
  types precisely so the diff is obvious.
- Build and push the public mirror (`scripts/build-wdk-mirror.sh`), so
  every evidence link in the application resolves for someone without
  access to the private repository.
- Apply to the WDK Partner Program (Tech Contributor and Consulting &
  Implementation tracks) with links to the mirror. The application says a
  person's testnet run is the next step and does not claim one. The text is
  [`partner-program-application.md`](partner-program-application.md).
