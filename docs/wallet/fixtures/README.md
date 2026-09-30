# Wallet authorization test fixtures

These files exist to pin the **cross-package canonicalization contract** for a
`SpendAuthorization`: the authorization plane signs one, and the isolated
`packages/signer` verifies it with the public key alone. If either side's
canonicalization drifts, `packages/signer/src/verify.test.ts` fails.

| File | What it is |
|---|---|
| `test-signing-key.pem` | A **throwaway, test-only Ed25519 private key.** See the warning below. |
| `test-signing-key.pub.pem` | Its public half — the only half any code in this repository loads. |
| `authorization.json` | A `SpendAuthorization` signed by the private key above, used as the conformance fixture. |

## `test-signing-key.pem` is a throwaway test key, committed on purpose

> **This is not a secret.** `test-signing-key.pem` is a generated,
> **throwaway** Ed25519 private key that exists only to sign the committed test
> fixture `authorization.json`. It signs nothing real, guards nothing, and is
> **never used in production**. Publishing it is safe and intentional — a
> committed test key is how the two independent implementations of the
> signature format are held to the same bytes without a live signing service in
> CI.
>
> The production authorization key is generated **outside any repository** and
> lives only in a secret store (`WALLET_AUTHZ_PRIVATE_KEY`); see
> `../runbook.md` §1. The runbook's own check is that
> `git grep -n "BEGIN PRIVATE KEY"` returns **only this file** — any other hit
> is an incident.

## How it is used, exactly

- **In this public mirror:** nothing loads the private key. Only
  `test-signing-key.pub.pem` and `authorization.json` are read, by
  `packages/signer/src/verify.test.ts`, to verify the fixture with the public
  key alone.
- **In the FlashyOS monorepo (canonical source):** the private key signs
  `authorization.json` in `packages/api/src/lib/wallet/fixtures.test.ts`,
  regenerated only under `UPDATE_FIXTURES=1`. The signer then verifies it —
  which is the whole point of committing a fixed key.

These three files are **byte-identical copies of the canonical fixtures** in
the monorepo; do not hand-edit or regenerate them here, or the two copies
silently disagree about the exact bytes a signature covers. Regenerate at the
canonical source (`UPDATE_FIXTURES=1`) and re-mirror.
