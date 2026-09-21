# The network demo — twenty organizations, three hundred agents

Status: runs · `npm run wallet:network` in `packages/api` · pinned by
`src/lib/wallet/demo/network.integration.test.ts` · 2026-09-19

The [four-agent week](demo.md) shows one organization governing its agents.
This shows what a wallet SDK cannot do on its own: independent organizations,
each with agents holding machine-readable authority, paying each other for
delivered work through partnerships their humans chose — with a reason on
both sides of every payment, every refusal recorded, and humans asked only
where an envelope says so.

Everything is generated from a seed, so the closing frame is a test, not a
screenshot. Real plane, real two-phase ledger, real Decision ladder, real
signer with signature and re-derivation checks; a mock chain.

## The network

| | Default | Flag |
|---|---|---|
| organizations | **20** (`wdk-net-01` … `wdk-net-20`, ENTERPRISE tier) | `--orgs` |
| agents per org | **15**: `revenue` (read only, no envelope) · `treasury` (always escalates, CRITICAL) · `signer` (`wallet:settle` only) · 12 × `procurement-n` | `--agents` |
| partnerships | a ring plus 2 seeded extras per org → **52** | `--extra-partners` |
| settlements per partnership | **3**, payer → payee, plus one treasury payment per org | `--settlements` |
| seed | `20260921` | `--seed` |

Procurement envelope, whole dollars: per-transaction **$200**, daily
**$1,000**, auto-approve **≤ $50**, destinations = exactly the registered
receiving addresses of the partners this org's humans chose to pay.

Each attempted settlement is drawn from a weighted shape: routine (62%),
large enough to ask a human (22%), over the per-transaction cap (8%), to an
organization nobody partnered with (4%), or tampered — a valid authorization
for the partner, a call to a different payee (4%). Five percent of chain
executions revert.

## The closing frame (default seed)

```
organizations: 20   agents: 300   partnerships: 52
settlements attempted: 176   reached the plane: 169   settled on chain: 128
verdicts — allow: 106   escalate: 45   deny: 18
refusals: NO_ACTIVE_PARTNERSHIP×7, DESTINATION_NOT_PERMITTED×3, PER_TX_CAP×15
humans asked: 45 — 26.63 per hundred writes   (approved 34, rejected 11)
executed on chain: 128 confirmed, 4 reverted
signer refusals: MISMATCH×8   expired unspent: 8
memory: 655 captures across 20 brains
reason coverage: 100%   settlements unmatched between payer and payee memories: 0
```

Three of the numbers are the point:

- **26.63 humans asked per hundred writes.** Twenty of the forty-five are the
  treasuries, which always ask. Under per-write elicitation the number is 100.
- **Reason coverage 100%.** Every one of the 176 attempts — allowed,
  escalated, refused before the plane, refused by the plane, refused by the
  signer, reverted, expired — carries a reason a person can read.
- **Zero unmatched settlements.** Every settlement row the payer wrote is in
  the payee's memory, refusals included; every confirmed one is there twice.

One refusal deserves a note. `DESTINATION_NOT_PERMITTED ×3` are payments to
an organization that has an *active partnership* with the payer — because it
pays the payer — but whose address the payer's humans never allowlisted. The
partnership graph says "these two work together"; the envelope says "and we
pay them". They are different decisions, and the plane keeps them different.

## What it does not show, and says so

- The chain is a mock. See [Phase 6](testnet.md) for the testnet backend.
- Every settlement here is a transfer; swaps and bridges do not cross
  organizations in this scenario.
- Partnerships are seeded ACTIVE. The proposal/accept flow exists in
  FlashyOS and is not exercised here.

## Running it

```
cd packages/api
DATABASE_URL=postgresql://… npm run wallet:network            # the closing frame
DATABASE_URL=postgresql://… npm run wallet:network -- --log   # every attempt, one line each
DATABASE_URL=postgresql://… npm run wallet:network -- --json  # the frame as JSON, for machines
DATABASE_URL=postgresql://… npm run wallet:network -- --orgs 50 --agents 10 --seed 7
```

The default run takes about ten seconds against a local Postgres. Re-running
resets the `wdk-net-*` organizations and nothing else.
