# FlashyOS on Tether WDK — the public mirror

Governed economic agency for autonomous agent organizations, built on
[Tether WDK](https://github.com/tetherto/wdk). This repository is the
public mirror of the Apache-2.0 part of [FlashyOS](https://flashyos.com):
three packages and the documents, extracted unchanged from the monorepo.

| Package | What it is |
|---|---|
| `packages/wallet-wdk` | The AAO `WalletCapability`; a `TransactionPolicy` that defers to a remote authorization plane (against tetherto/wdk PR #88's contract); an async policy rule for shipped WDK; extractor packs for EVM, TRON, swaps and bridges with a drift-checked manifest; an MCP elicitation handler and a client for `@tetherto/wdk-mcp-toolkit`; signed invoices and receipts; x402 (buyer and seller); the provenance verifier |
| `packages/signer` | The isolated signer: verify → refuse a seen nonce → re-derive the operation from the real call → refuse any mismatch → execute through WDK → report. WDK's policy engine as a deny-by-default second line; the Safe Allowance Module as a third; one derived account per agent; EIP-712 typed data through the same ladder. **Testnets only, by decision, with no flag that widens the list.** |
| `packages/wdk` | The agent object — `FlashyOrganization` and `FlashyAgent` on one transport interface with one event stream — and `flashyos-run` |
| `docs/wallet` | Threat model, spec, architecture, runbook, the per-phase documents, the published JSON Schemas, the OpenAPI fragment, the upstream materials |

```
npm install && npm run typecheck && npm test
```

**What is here and what is not.** Everything that runs against WDK is here
and tested against the installed `@tetherto/wdk` engine. The authorization
plane itself — the five checks, the ledger, the decision ladder, the routes,
the organizational memory, the demos that run against Postgres — lives in
the FlashyOS monorepo and is described in `docs/wallet/`, with every number
there pinned by a test in that repository. Nothing here holds a seed in a
test, nothing here reaches a live network, and nothing here claims a
partnership with anyone.

**Findings about WDK, offered upstream:** see `docs/wallet/upstream/README.md`.

Apache-2.0.
