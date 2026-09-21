# Wallet authorization plane — documents

The layer between an agent's proposal and a signer that holds the keys, built
so that FlashyOS agents can hold governed economic agency on Tether WDK.

| Read this for | File |
|---|---|
| Why an in-process policy or a per-write human click is not enough for an organization | [`threat-model.md`](threat-model.md) |
| The contract: vocabulary, scopes, envelopes, the five checks, verdicts, the signed authorization, the two-phase ledger, endpoints | [`spec.md`](spec.md) |
| What was built, where, and what it deliberately leaves out | [`architecture.md`](architecture.md) |
| The four-agent week, its pinned closing frame, and how to run it | [`demo.md`](demo.md) |
| The network demo — twenty organizations, three hundred agents, settling with each other; pinned | [`network-demo.md`](network-demo.md) |
| Testnets only: `WdkChain`, the receipt poller, WDK's policy engine as the second line, the toolkit seam, how to run the week on Base Sepolia, and what is still open | [`testnet.md`](testnet.md) |
| Operating it: keys, custody tiers, separation of duties, the pilot's acceptance gate, how to stop | [`runbook.md`](runbook.md) |
| The thirty-day pilot rehearsed on a testnet with the same gates, and the mainnet pilot recorded as a human decision this codebase cannot start | [`pilot-testnet-rehearsal.md`](pilot-testnet-rehearsal.md) |
| Settlement as a product: receipts in both brains, receivables, invoices, settlement auto-accept, delegated authority (monotonic), weekly metrics | [`product.md`](product.md) |
| The on-chain limit: the Safe Allowance Module as the signer's third line — extractor, reader, pre-flight refusal — and the steps a person takes to close the gate | [`onchain-limit.md`](onchain-limit.md) |
| The plane's face: the `/wallet` page — envelopes as a tree, the ledger, the escalation queue, money in with receipts, the week's numbers — and the browser test that records the OWNER path | [`screens.md`](screens.md) |
| The phases a person runs — the testnet week, sending the drafts, the settled month, enabling a chain — what is ready, what they do, what done looks like | [`human-phases.md`](human-phases.md) |
| The object — `@flashyos/wdk`: the seven verbs on one interface, one transport with two implementations, one event system; both demos re-run through it with identical frames; TRON through a pack and a backend | [`object.md`](object.md) · [`packages/wdk/README.md`](../../packages/wdk/README.md) |
| Identify — one WDK account index per agent; the envelope tree as a Safe Allowance Module plan a person executes | [`identity.md`](identity.md) |
| Interoperate — signed invoices from payees outside FlashyOS, plane-signed receipts verified offline with the public key, x402 challenges answered as bounded records signed off-chain | [`interop.md`](interop.md) |
| Meter — a cap under one decision, ticks without one, a close reconciled against the provider's count | [`meter.md`](meter.md) |
| Prove — the hash-chained export, the signed Merkle seal, the verifier in `@flashyos/wallet-wdk`, metrics re-derived from the export | [`provenance.md`](provenance.md) |
| Network — the weekly numbers summed over the organizations that opted in, with the count; the `/network` page | [`network.md`](network.md) |
| Run — `flashyos-run agent.mjs`: the object pre-wired from the environment; a whole agent in one function | [`run.md`](run.md) |
| Federation — the plane's identity document and key rotation, the trusted-plane registry, the org's own key and invoices out to any payer, receipts in from any trusted plane, x402 as a server, the money page in the digest, the federation run pinned | [`federation.md`](federation.md) |
| What we would contribute to `tetherto/wdk`, and the observations we would put in the PR | [`upstream/README.md`](upstream/README.md) |
| Draft Partner Program application and draft PR description — neither submitted | [`upstream/partner-program-application.md`](upstream/partner-program-application.md) · [`upstream/pr-description.md`](upstream/pr-description.md) |
| Machine-readable: JSON Schemas (generated from the enforced validators; drift-checked by test) | [`schema/`](schema/) |
| Machine-readable: what the extractor packs vouch for, per chain family and protocol, and what they refuse (generated from the packs; drift-checked by test) | [`schema/extractor-packs.json`](schema/extractor-packs.json) |
| Machine-readable: OpenAPI fragment for the wallet routes (route ↔ spec drift-checked by test) | [`openapi.wallet.json`](openapi.wallet.json) |
| Cross-package conformance fixture (an API-signed authorization the signer verifies) | [`fixtures/`](fixtures/) |

Regenerate the generated files with `npm run wallet:schemas` in `packages/api`.
