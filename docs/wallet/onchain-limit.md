# The on-chain limit — Safe Allowance Module as the third line

Status: Phase 12 · spike built and tested this side of the chain; **the
gate stays open** until a person deploys it on Base Sepolia · 2026-09-20

## The decision

Phase 6 found that `@tetherto/wdk-wallet-evm-erc-4337` exposes no session
keys or spending limits, so the layer that holds when the plane and the
signer are both wrong could not come from WDK. Rather than build around a
feature that does not exist, this phase picks the smallest thing that does:
the **Safe Allowance Module** (`safe-fndn/safe-modules`,
`modules/allowances`). A Safe's owners add a delegate and set, per delegate
and per token, an allowance amount and an optional reset window in minutes;
the delegate spends through `executeAllowanceTransfer`, and the module
reverts anything over. Verified against the contract source on `main`
(2026-09-20): `getTokenAllowance` returns `[amount, spent, resetTimeMin,
lastResetMin, nonce]`; `resetTimeMin = 0` means no automatic reset.

The shape, then, is a Safe that holds the org's funds, a delegate that is
the signer's WDK-derived EOA, and an allowance at or below each agent's
envelope `dailyMax` with a 1,440-minute window. The plane decides; the
signer re-derives; the Safe refuses what the other two should not have
allowed.

## What was built

| Piece | Where | Proven by |
|---|---|---|
| `extractEvmOperation` recognises `executeAllowanceTransfer` calldata as the ERC-20 transfer it is (token, to, amount), refusing a call that also pays the executor or carries native value | `packages/wallet-wdk/src/extractors/evm.ts` | `safeAllowance.test.ts`; `extractor-packs.json` v3 |
| `SafeAllowanceLimit`: reads the chain's allowance (`eth_call`, no library), applies the module's own reset arithmetic, checks a record, builds the `executeAllowanceTransfer` calldata, fetches the module's transfer hash with the module's nonce | `packages/signer/src/onchain/safeAllowance.ts` | 8 tests on a scripted `eth_call` |
| `Signer.onChainLimit` — the third line: before executing an ERC-20 transfer, read what the chain would say and refuse `ONCHAIN_LIMIT` in advance | `packages/signer/src/signer.ts` | "a spend the plane allowed is refused by the signer when the chain's allowance would refuse it" |

That last test is the *shape* of the Phase 6 gate — a spend the plane
allowed, refused by an on-chain limit — with the limit read from a scripted
chain. It is not the gate. The gate is the module's revert on a real Safe,
and that needs a person with a testnet Safe.

## What a person does to close the gate

1. **Deploy a Safe on Base Sepolia** (Safe{Wallet} supports it) with the
   org's humans as owners, threshold ≥ 2.
2. **Enable the Allowance Module.** Look up the module's Base Sepolia
   deployment address in `safe-modules`' deployments; *do not* take an
   address from a chat or a search result. Enable it as a Safe transaction.
3. **Add the delegate.** The signer's WDK account address
   (`getAccount('evm', 0).getAddress()` with the testnet-only seed) via
   `addDelegate`.
4. **Set an allowance** for the delegate on the test token: amount ≤ the
   agent's envelope `dailyMax`, `resetTimeMin = 1440`. Fund the Safe.
5. **Run the week** with `SafeAllowanceLimit` configured on the signer and
   the demo's transfer calls built through `transferCall(record,
   signature)`, where `signature` is the delegate's over `transferHash()`.
6. **The gate:** set the envelope's `dailyMax` *above* the on-chain
   allowance for one agent, propose a spend between the two, and watch the
   plane allow it, the signer's pre-flight refuse it (`ONCHAIN_LIMIT`), and
   — with the pre-flight disabled for the test — the module revert it.
   Three lines, each visible.

## What is deliberately not done

- **Signing the transfer hash inside WDK's governed account.** The module
  wants the delegate's signature over its own EIP-712 hash; on a governed
  WDK account that is `signTypedData` or `sign`, which the second line
  refuses unless a rule allows it. The rule is one line (allow `sign` when
  the digest equals the in-flight `transferHash`) and is left for the live
  run, where the exact method the TRON and EVM modules expose for a raw
  digest can be confirmed rather than assumed.
- **Any module address.** None is written here on purpose.
- **Zodiac Roles.** A richer module (per-function, per-parameter
  permissions) that could enforce the destination allowlist on chain too.
  Recorded as the next step if the allowance module's per-token amount
  proves too coarse.
