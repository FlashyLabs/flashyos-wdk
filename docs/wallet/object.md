# The object — `@flashyos/wdk`

Status: Phase 14½ · built and tested · 2026-09-20

Rev D.1's §05 said the moat is not the wallet integration but the object
that carries an agent's identity, authority, history and partners through
every integration — and that we had all of its parts and none of its shape.
This is the shape.

## The seven verbs, on one interface

| Verb | Object | Method | Behind it |
|---|---|---|---|
| create | `FlashyOrganization` | `agents.create(name, scopes)` | `POST /agents` + `PUT /agents/{name}/scopes` (new route) |
| identity | `FlashyAgent` | `identity` | org, name, scopes — the token's claims |
| provision | `FlashyOrganization` | `authority.set(agent, envelope)` · `treasury.registerAddress` | envelopes, receiving addresses |
| permissions | both | `authority.set` (human) · `agent.authority.delegate` (agent, narrower only) · `treasury.setSettlementPolicy` | the five checks, delegation, policies |
| transact | `FlashyAgent` | `wallet.transact(chain, call)` · `wallet.complete(decisionId, chain, call)` · `wallet.execute(auth, call)` | re-derive → propose → (human) → signer |
| record | `FlashyAgent` | `memory.record(body)` | `POST /vault/captures`; every wallet verb also captures on its own |
| coordinate | `FlashyAgent` · `FlashyOrganization` | `partners.invoice` · `partners.settle` · `decisions.resolve` · `receivables()` · `receipt()` | invoices, settlement, both brains |

`transact` has five outcomes, each a value with a reason: `executed`,
`refused` (the signer), `escalated` (a human is needed; pass
`waitForDecision` to poll for the issued authorization), `denied` (the
plane), `unrecognised` (no extractor vouches for the call).

## One transport, two implementations

`Transport` is everything the object needs from FlashyOS, in one interface
(`packages/wdk/src/transport.ts`). `HttpTransport` is the agent runtime's:
the session token on human routes, the agent's token on agent routes, no
bearer on the signer. `InProcessTransport` (`packages/api/src/lib/wallet/object/`)
is the demos' and the API's own tests': it calls the services and serializes
every result to the wire shape, so the object sees the same JSON either way,
and turns a service's `AppError` into the same `TransportError` a route
would have produced.

## The gate, met

| Demo | Service-level original | Through the object | Frame |
|---|---|---|---|
| Four-agent week | `scenario.ts`, 382 lines | `week.object.ts`, 102 lines | identical: 22 proposals, 12/4/6, `MISMATCH`×2, 41 captures |
| Twenty-org network | `network.ts`, 465 lines | `network.object.ts`, 180 lines | identical: 176 attempts, 26.63 asks/100, 100% reasons, 0 unmatched, 655 captures |

`object.integration.test.ts` runs both and asserts the frames equal the
originals'. The originals stay as the reference implementation.

**A non-EVM chain through nothing but a pack and a backend.** `WdkTronChain`
(`packages/signer/src/tronChain.ts`) runs `@tetherto/wdk-wallet-tron` on
TRON Nile or Shasta — the two new entries in `testnets.ts` — with the same
second line: WDK's engine governs both TRON write surfaces
(`sendTransaction` for TRX, `transfer` for TRC-20) and the in-flight rule
covers both. The plane, the object and the signer's re-derivation did not
change; the Phase 7 TRON extractor pack did the rest. `tronChain.test.ts`
proves a TRC-20 call executes, a case-changed recipient is refused before
the backend, and the engine refuses anything not in flight — against the
installed engine.

## Two findings for upstream

- **`waitForTransaction` is governed by default.** On a governed account
  WDK's engine intercepts `waitForTransaction` — a read — and refuses it
  with `NO_APPLICABLE_RULE`, so a backend waiting for its own receipt is
  blocked by its own second line. `getTransaction` and
  `toReadOnlyAccount` are in `DEFAULT_POLICY_EXCLUSIONS`;
  `waitForTransaction` is not (verified in `src/policy/constants.js`,
  beta.18). The consumer-side remedy is `policyExclusions:
  ['waitForTransaction']`, which `WdkTronChain` uses. We would propose
  adding it to the default list.
- **Scopes had no HTTP surface.** FlashyOS's own finding, not WDK's: an
  agent's scopes could only be set from inside the API process. The object
  needed `PUT /orgs/{orgId}/agents/{agentName}/scopes`; it exists now, with
  the same conflict rules.

## What it does not do

- It does not hold a seed, sign, or decide. It composes.
- It does not add authority. Every method calls an existing route with an
  existing role; the agent's side of the object cannot widen anything.
- `HttpTransport` is tested against a recording `fetch`, not a live API —
  the routes it calls are each tested on their own side.
