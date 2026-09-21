# Run — `flashyos-run agent.mjs` (Phase 22)

Status: built and tested · 2026-09-20

## What it is

The object, pre-wired from the environment, handed to a module's default
export. A whole agent is a file with one function:

```js
export default async function (agent, org) {
  const result = await agent.wallet.transact('evm:84532', call, { waitForDecision: { timeoutMs: 600_000, pollMs: 5_000 } });
  await agent.memory.record(`September data licence: ${result.status}`, 'notes/procurement');
  return result.status;
}
```

```
FLASHYOS_API_URL=https://api.flashyos.com FLASHYOS_ORG_ID=org_… \
FLASHYOS_AGENT_NAME=procurement FLASHYOS_AGENT_TOKEN=… FLASHYOS_SIGNER_URL=http://signer.internal:8787 \
npx flashyos-run examples/procurement.mjs
```

Every event the run emits is one JSON line on stdout, so the run is its own
log; the plane's captures are the rest of the record. Nothing in the runner
holds authority: a missing token means the verbs that need it throw
`NO_CREDENTIAL` before any request, and the plane decides everything else.

## Environment

| Variable | Used for |
|---|---|
| `FLASHYOS_API_URL`, `FLASHYOS_ORG_ID`, `FLASHYOS_AGENT_NAME` | required |
| `FLASHYOS_AGENT_TOKEN` | the named agent's token — agent verbs |
| `FLASHYOS_SESSION_TOKEN` | optional — a human's session for human verbs (envelopes, decisions, seals) |
| `FLASHYOS_SIGNER_URL` | optional — execution and typed-data signing |
| `FLASHYOS_AGENT_TOKENS` | optional — `name=token,name=token` for more agents |
| `FLASHYOS_EVENTS=silent` | optional — no event lines |

`configFromEnv` names the first missing or malformed variable
(`RunConfigError`). A module may `export const agentName` to run as another
agent whose token the environment holds. A TypeScript module runs under a
loader (`node --import tsx`) or compiled.

## Where

| | |
|---|---|
| `configFromEnv`, `runAgentModule` | `packages/wdk/src/run.ts` (exported from `@flashyos/wdk`) |
| the bin | `packages/wdk/src/cli.ts` → `dist/cli.js`, `"bin": { "flashyos-run" }` |
| the example | `packages/wdk/examples/procurement.mjs` |

## Proof

`packages/wdk/src/run.test.ts` (5) — the variables read, including the
optional ones; the first missing one named; the module gets the agent it
names and the org; every event is a JSON line with the org, agent and data;
silent runs write nothing; a module without a default export is refused;
without a transport the HTTP one is built and a human verb without a
session is `NO_CREDENTIAL` with zero requests made.
