## What this changes

<!-- One or two sentences, and which package(s): wallet-wdk, signer, wdk. -->

## Why

<!-- The real scenario this was written against. -->

## Checklist

- [ ] `npm run typecheck` passes across all workspaces
- [ ] `npm test` passes across all workspaces (`npm run test --workspaces`)
- [ ] Nothing here holds a seed in a test, reaches a live network, or widens the signer's testnet-only chain table
- [ ] If this originated in the FlashyOS monorepo, the corresponding change has landed there first — this mirror should never diverge from it
- [ ] README / `docs/wallet/` updated if this changes documented behaviour
