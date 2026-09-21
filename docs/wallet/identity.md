# Identify — one address per agent (Phase 17)

Status: built and tested · 2026-09-20 · testnets only

## What it is

WDK derives one account per index from one seed. The plane now assigns each
agent its own index per chain family, so an agent's on-chain address is its
own, stable, and never shared with another agent. Index 0 is the treasury —
the address a person funds — and agents start at 1. An index is assigned once
and never reused: a revoked agent's index stays retired.

The family, not the chain id, is the key: `getAccount('evm', 3)` is the same
address on every EVM chain, so `research-ops` has one EVM address and one
TRON address.

## Why

The Safe Allowance Module ([`onchain-limit.md`](onchain-limit.md)) limits
*addresses*. With one address per agent, the allowance a Safe's owners set is
the envelope's mirror agent by agent, and the third line finally says the same
thing as the first.

## What was built

| Piece | Where |
|---|---|
| `AgentChainIdentity` — (org, agent, family) → index, address | `packages/api/prisma/schema.prisma` |
| `assignAgentIdentity`, `recordAgentAddress`, `accountIndexFor`, `allowancePlan` | `packages/api/src/services/agentIdentityService.ts` |
| Per-index accounts in the EVM and TRON backends; `address(index)`; `execute(record, call, { accountIndex })` | `packages/signer/src/chain.ts`, `tronChain.ts` |
| `SignerOptions.accountIndexFor(authorization)` — the signer asks the registry which account acts | `packages/signer/src/signer.ts` |
| `safeAllowancePlan()` — the envelope tree as `addDelegate` / `setAllowance` (and `deleteAllowance` / `removeDelegate` for retired agents) | `packages/signer/src/onchain/safeAllowancePlan.ts` |
| Routes: `GET/POST /wallet/identities`, `POST /wallet/identities/address`, `GET /wallet/identities/plan` | `docs/wallet/openapi.wallet.json` |
| Object: `org.identities.assign / list / plan` | `packages/wdk` |

## The flow

1. An OWNER/ADMIN assigns: `POST /wallet/identities { agentName, family }` → `{ accountIndex: 1, address: null }`.
2. The signer (the party holding the seed, `wallet:settle`) derives the address for that index and reports it once: `POST /wallet/identities/address`. A different address for a recorded index is `ADDRESS_CONFLICT` — an index derives one address, ever.
3. Every authorization the signer executes for that agent now runs from that account: `accountIndexFor` reads the registry, the backend selects the account.
4. A member asks for the plan: `GET /wallet/identities/plan?safe=&module=&token=&chain=evm:84532`. The response is a JSON document — `version`, the Safe and module addresses, the token, and one `addDelegate` + `setAllowance` pair per agent at its **effective** daily max (after delegations), each with calldata and a one-line summary — plus `missingAddress` for agents the plan cannot name yet. Deterministic: the same envelopes produce the same document.
5. A person executes the plan in the Safe. Nothing in this codebase signs a Safe transaction.

Selectors are computed from the ABI signatures, not recalled:
`addDelegate(address)` `0xe71bdf41` · `setAllowance(address,address,uint96,uint16,uint32)` `0xbeaeb388` ·
`removeDelegate(address,bool)` `0xdd43a79f` · `deleteAllowance(address,address)` `0x885133e3`.

## Proof

- `packages/api/src/lib/wallet/demo/phases17-19.integration.test.ts` — indices 1, 2, 1 for two agents and a repeat; TRON separately at 1; plan empty until an address is recorded, then `addDelegate` + `setAllowance` at the effective daily max; `ADDRESS_CONFLICT` on a second address.
- `packages/signer/src/chain.test.ts` — one address per index; `execute(…, { accountIndex: 3 })` sends from account 3 and not from 0.
- `packages/signer/src/onchain/safeAllowancePlan.test.ts` — encoding, ordering, retirement, the four selectors, the refusals.

## What it leaves out

The address is reported, not derived, by the plane: the plane never holds a seed. Until the signer reports, the plan says `missingAddress`. The plan is a document; whether the Safe's owners execute it is their decision, and the third line stays a read until they do.
