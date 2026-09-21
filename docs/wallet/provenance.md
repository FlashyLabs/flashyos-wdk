# Prove — the export, the seal, the verifier (Phase 20)

Status: built and tested · 2026-09-20

## What it is

An organization's wallet history leaves the plane as a **hash chain**: one
JSON entry per fact — wallet decisions, wallet and settlement captures,
authorizations, settlements on both sides, external settlements, meters —
in time order, each carrying the hash of the entry before it and its own
hash over everything but the hash. A **seal** is a Merkle root over the
export, signed by the plane's authorization key with a sequence number; its
32 bytes are calldata a person may anchor on any chain they choose.

The **verifier** needs the export, the seal and the public key, and
nothing else — not FlashyOS, not the database. One altered character
anywhere is a refusal that names the entry. And the weekly metrics the
plane reports re-derive from the export to the same numbers, so what the
plane says about itself is what a counterparty can recompute.

## Shapes

`ProvenanceEntry`: `{ seq, at, kind, id, data, prev, hash }` with
`hash = sha256(canonical({ seq, at, kind, id, data, prev }))`, `prev` the
previous hash (64 zeros first). `kind ∈ decision · capture · authorization ·
settlement · settlement-in · external-settlement · meter`.

`Seal`: `{ version: 1, org, seq, entries, through, root, sig, anchorCalldata }`
with `sig = ed25519(canonical({ version, org, seq, entries, through, root }))`
under the plane's key and `root` the Merkle root over leaves
`<kind>:<id> → hash` — the brain's construction (`packages/api/src/lib/mind/merkle.ts`):
leaf and node prefixes for domain separation, leaves sorted by key, an odd
node promoted. Both are in `openapi.wallet.json` components.

## Routes and verbs

| | |
|---|---|
| `GET /wallet/provenance` (`?format=jsonl`) | the export — members and `wallet:read` |
| `POST /wallet/provenance/seal` | a new seal — OWNER/ADMIN; `EXPORT_EMPTY` when there is nothing to seal |
| `GET /wallet/provenance/seals` | every seal, newest first |
| `org.provenance.export() / seal() / seals()` | the object; `seal` emits `provenance.sealed` |
| `verifyExport(input, { root, publicKey })` | `@flashyos/wallet-wdk` — JSONL or entries; `HASH_MISMATCH · CHAIN_BROKEN · SEQ_GAP · NOT_ORDERED · ROOT_MISMATCH · BAD_SIGNATURE`, each with the `seq` it names |
| `metricsFromExport(entries, { since, until })` | the plane's `walletMetrics` arithmetic over the export |
| `anchorCalldata(root)` | `0x<root>` — for a person to send as the data of any transaction |

## Proof

- `packages/wallet-wdk/src/provenance.test.ts` (4) — chain, JSONL round trip, stable root; the altered entry named for a data change, a hash change, a dropped entry, a seq gap; the sealed root and its signature checked, the wrong key refused, a shortened export `ROOT_MISMATCH`; metrics derived to the pinned numbers.
- `packages/api/src/services/provenanceService.integration.test.ts` (2) — an org with an executed spend, a denial, an escalation and a meter: the export verifies; the API's `buildMerkleTree` root equals the verifier's `exportRoot`; seal 1 verifies under the public key from JSON and JSONL; one byte altered in the escalated decision's summary is `HASH_MISMATCH` at its seq; seal 2 covers more entries; a MEMBER cannot seal. And: the four-agent demo week's metrics re-derived from its export **equal** `walletMetrics` field for field.

## What it leaves out

Anchoring is a person's act with their own key on a chain of their choosing;
the plane emits the bytes and records nothing about whether they were sent.
The export is what the plane wrote; an agent's free-text memory is not in it
except the plane's own capture lines. Roots were not published before this
phase shipped, so the clock starts now — which is the whole point of
starting it.
