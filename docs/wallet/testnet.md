# Testnet — the first real chain, and what stays off it

Status: Phase 6 · built and rehearsed; **not executed against a live network
from the environment this was built in** (no RPC egress) · 2026-09-19

Decision recorded here: **this codebase links to testnets only, for now.**
`packages/signer/src/testnets.ts` is the whole list — Base Sepolia, Ethereum
Sepolia, Arbitrum Sepolia, OP Sepolia — and `WdkChain` refuses to construct
for any other chain id with `MAINNET_NOT_ENABLED`. There is no environment
variable, option or flag that widens it. Adding a chain is a change to that
file, in a pull request, after the pilot gate in [`runbook.md`](runbook.md) §6
has been met.

## What Phase 6 built

| Item | Where | Verified by |
|---|---|---|
| `WdkChain` against `@tetherto/wdk` + `@tetherto/wdk-wallet-evm` (beta.18 / beta.19), testnets only | `packages/signer/src/chain.ts` | `chain.test.ts` — 20 tests, the real WDK policy engine, a fake wallet module |
| Receipt poller: `eth_getTransactionReceipt` + `eth_blockNumber`, N confirmations, timeout carrying the hash | `packages/signer/src/receipts.ts` | `receipts.test.ts` |
| WDK's policy engine as the **second line** inside the signer process | `WdkChain.account()` | `chain.test.ts` "the second line" |
| Persisted nonce store (append-only file, fsync per add) | `packages/signer/src/nonces.ts` `FileNonceStore` | `nonces.test.ts` |
| Signer keeps a failed execution as `EXECUTION_FAILED` + `pendingExecutions`, never a replay window | `packages/signer/src/signer.ts` | `signer.test.ts` |
| The MCP toolkit's confirmation, answered by the plane | `packages/wallet-wdk/src/toolkit.ts` | `toolkit.test.ts` — messages copied from the toolkit's source |
| The four-agent week on a testnet chain id, native asset | `packages/api/src/lib/wallet/demo/run-testnet.ts` | `testnet.integration.test.ts` (rehearsal over the mock) |

### The second line, precisely

WDK's engine (`@tetherto/wdk` `AGENTS.md`, verified in the installed
package) governs an account the moment any policy applies to it, and a
governed account is **deny-by-default**: an operation no rule addresses is
refused with `NO_APPLICABLE_RULE`; one a rule addresses but does not match is
refused with `GOVERNED_BUT_UNMATCHED`. `WdkChain` registers exactly one
rule — `sendTransaction`, `ALLOW`, on the condition that the transaction
re-derives to the record the signer is executing *right now* — so:

- the operation in flight passes;
- the same transaction replayed a moment later is refused;
- `approve`, `transfer`, `signTypedData`, `delegate` and every other write
  are refused without a rule naming them;
- reads (`getAddress`, `getBalance`) stay open.

A bug in the backend that built the wrong transaction would meet that proxy
and surface as `SecondLineRefusal` — which is a bug report, never a normal
outcome. `chain.test.ts` simulates exactly that bug and checks nothing was
sent.

This line is not the boundary (see [`threat-model.md`](threat-model.md) §4);
it is the thing that holds when the signer's own code is wrong.

### Two ways to run, and what governs each

| Path | Who holds the seed | Lines of defence | Use |
|---|---|---|---|
| **Signer path** — agent → plane → `@flashyos/signer` → `WdkChain` | the signer | plane verdict · signer re-derivation from the real call · WDK policy engine | FlashyOS agents; the demos; the pilot |
| **Toolkit path** — agent → `@tetherto/wdk-mcp-toolkit` → elicitation → plane | the toolkit process | plane verdict only | an operator already running Tether's MCP server who wants organizational policy in front of it |

In the toolkit path the elicitation carries the confirmation *message*, not
the transaction (`server.requestConfirmation(message, schema)` →
`elicitInput({ message, requestedSchema })`, verified in
`tetherto/wdk-mcp-toolkit` `src/server.js` and `src/tools/wallet/*.js`).
`parseToolkitConfirmation` reads the two formats the wallet tools produce
today — token transfer and native send — and `toPendingWrite` rebuilds the
call from the operator's chain/token mapping. The message and the broadcast
are built from the same tool arguments inside the toolkit, so they agree
unless the toolkit is compromised, and a compromised toolkit already has the
seed. Anything the parser does not recognise is a decline, and the toolkit
then reports "cancelled by user. No funds were spent."

## Running the week on Base Sepolia

Prerequisites, all outside this repository:

1. A **testnet-only** seed phrase. Generate one for this and nothing else:
   `node -e "import('@tetherto/wdk').then(m=>console.log(m.default.getRandomSeedPhrase()))"`.
   It must never hold mainnet value; treat it as Tier 0 in `runbook.md` §2.
2. Test ETH on the derived address (`getAccount('evm', 0)`), from a faucet in
   `TESTNETS[…].faucet`. The week moves ~1,200 "dollars" = 1.2 × 10⁹ wei in
   total, which is nothing; gas is the only cost.
3. An RPC endpoint you control or trust. The public one in `TESTNETS` is a
   default, not a recommendation.
4. A running plane (`packages/api`) with Postgres, `WALLET_AUTHZ_PRIVATE_KEY`
   set, and the demo org seeded by the run itself.

Then:

```
cd packages/api
DATABASE_URL=… npm run wallet:testnet -- --rehearse                 # no seed, no network: same wiring, mock chain
WDK_SEED="…" RPC_URL=https://… DATABASE_URL=… npm run wallet:testnet -- --chain evm:84532 --confirmations 2
```

What to expect from a live run, compared with the pinned mock week:

- Verdicts, escalations, denials and the signer's `MISMATCH` are identical —
  governance does not depend on the chain.
- Thursday's scripted revert does not happen (a real chain decides), so
  `executed` reads 13 confirmed / 0 reverted; the `DAILY_CAP` denial is
  unchanged, because 100 + 30 > 100 whether or not the first $25 came back.
  The rehearsal pins exactly this (`testnet.integration.test.ts`); the live
  run is not pinned, because a real chain may still revert something.
- The two honest swaps are authorized by the plane and **not executed**:
  `WdkChain` executes a swap only through a WDK swap protocol registered
  with `protocols.swap`, and the bare run registers none (there is no
  Tether-supported swap venue on Base Sepolia to register). The log says so
  on each, and the nightly expires them unspent. The tampered swap is
  refused by the signer before any backend is involved.
- Each confirmed transfer waits for `--confirmations` blocks (Base Sepolia:
  ~2 s each). The whole week takes a few minutes.
- The signer's `pendingExecutions` should be empty at the end. A
  `RECEIPT_TIMEOUT` entry means a transaction was broadcast and never
  confirmed inside the poller's window; reconcile it on the explorer before
  running again.

## What Phase 6 did not do, and why

**The on-chain session-key limit is not built.** The gate asked for "one
on-chain session-key limit refusing a spend the plane would have allowed."
`@tetherto/wdk-wallet-evm-erc-4337` (beta.20) is a Safe-based account through
`abstractionkit` with bundler and paymaster support, parallel nonce lanes,
and no session-key or spending-limit module in its surface (verified in the
installed package's type declarations and README). An on-chain limit would
need a Safe module — an allowance or roles module — deployed and configured
outside WDK. Rather than fake that gate with another in-process check, this
phase delivers WDK's policy engine as the second line and records the
on-chain limit as **open**, with the honest consequence for `runbook.md` §2:
Tier 1's "session key whose limits the account contract enforces" is not
available through WDK today and must come from a Safe module or wait.

**No live execution from here.** The container has no RPC egress (the proxy
returns 403 for `sepolia.base.org`). Everything above is tested against the
real WDK engine with a fake wallet module, and the wiring is rehearsed over
the mock; the first live run is a human's, using the commands above.

**One signer, one seed.** `FileNonceStore` is a file one process owns. Two
signers against one seed need a shared store; that is a deployment shape
this phase does not support and does not pretend to.
