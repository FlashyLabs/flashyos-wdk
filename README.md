# FlashyOS on Tether WDK — the public mirror

```
        ██
       ██
      ██████
        ██
       ██
      ██
```

Governed economic agency for autonomous agent organizations, built on
[Tether WDK](https://github.com/tetherto/wdk). This repository is the
public mirror of the Apache-2.0 part of [FlashyOS](https://flashyos.com):
three packages and the documents, extracted unchanged from the monorepo.

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

Built by [Flashy Labs](https://flashyos.com). Two smaller, standalone packages sit in front of a wallet like this one — [`@flashylabs/wdk-policy-guard`](https://github.com/FlashyLabs/wdk-policy-guard) and [`@flashylabs/wdk-staking-kit`](https://github.com/FlashyLabs/wdk-staking-kit) — if you want the spending-policy or staking piece without the rest of the plane.

## What's here

| Package | What it is |
|---|---|
| `packages/wallet-wdk` | The AAO `WalletCapability`; a `TransactionPolicy` that defers to a remote authorization plane (against tetherto/wdk PR #88's contract); an async policy rule for shipped WDK; extractor packs for EVM, TRON, swaps and bridges with a drift-checked manifest; an MCP elicitation handler and a client for `@tetherto/wdk-mcp-toolkit`; signed invoices and receipts; x402 (buyer and seller); the provenance verifier |
| `packages/signer` | The isolated signer: verify → refuse a seen nonce → re-derive the operation from the real call → refuse any mismatch → execute through WDK → report. WDK's policy engine as a deny-by-default second line; the Safe Allowance Module as a third; one derived account per agent; EIP-712 typed data through the same ladder. **Testnets only, by decision, with no flag that widens the list.** |
| `packages/wdk` | The agent object — `FlashyOrganization` and `FlashyAgent` on one transport interface with one event stream — and `flashyos-run` |
| `docs/wallet` | Threat model, spec, architecture, runbook, the per-phase documents, the published JSON Schemas, the OpenAPI fragment, the upstream materials |

## Install and check

```bash
npm install
npm run typecheck
npm test
```

## What this repo is not

- **Not the authorization plane itself.** The five checks, the ledger, the decision ladder, the routes, the organizational memory, and the demos that run against Postgres live in the FlashyOS monorepo and are described in `docs/wallet/`, with every number there pinned by a test in that repository. What's here is everything that runs *against* WDK, tested against the installed `@tetherto/wdk` engine.
- **Not connected to a mainnet.** `packages/signer`'s chain table is testnets only, and no flag or environment variable here widens it.
- **Not a partnership with Tether.** This repository integrates Tether's open-source WDK toolkit the way it would integrate any open-source library. Nothing here holds a seed in a test, nothing here reaches a live network, and nothing here claims a partnership with anyone.

## Findings about WDK, offered upstream

`docs/wallet/upstream/README.md` — what we'd contribute to `tetherto/wdk`, including a testnet-gap finding on the bridge module (`wdk-protocol-bridge-usdt0-evm` names mainnet chains only). Draft materials; submission is a person's decision, not this repository's.

## ⚡ The Strike

This README commits to a secret, the same way the signer commits to only ever re-deriving what actually happened:

```
sha256: ef4032a23ff44273cd1dd15177fd3f86887273f5d5bf84c124e261d6ab4fb5c2
```

The preimage is already on this page — one exact sentence from "What this repo is not," above. Recover it, hash it yourself (never trust, verify — that includes us), and open an issue titled `⚡ STRIKE` containing the sentence. First verified striker per release gets their name in [`STRIKERS.md`](STRIKERS.md).

No prize, no token. Just proof somebody read past the package table.

## License

Apache-2.0.

---

Built by [Flashy Labs](https://flashyos.com), the mesh platform for organisations' agents. If something here is broken, unclear, or just interesting, [open an issue](https://github.com/FlashyLabs/flashyos-wdk/issues) — we read them.
