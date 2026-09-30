// Every package.json here — the root and the three published workspaces —
// must point `repository.url` at THIS public mirror, github.com/FlashyLabs/
// flashyos-wdk, not the private `flashyos` monorepo it was extracted from. A
// published package whose repository link 404s for everyone outside the estate
// is worse than none: it invites a reader to a door they cannot open. The
// three workspace manifests carried the monorepo URL; this pins the fix so a
// re-mirror cannot quietly reintroduce it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const EXPECTED = 'https://github.com/FlashyLabs/flashyos-wdk'

const manifests = [
  'package.json',
  'packages/wdk/package.json',
  'packages/wallet-wdk/package.json',
  'packages/signer/package.json',
]

for (const rel of manifests) {
  test(`${rel} points repository.url at the public mirror`, () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    assert.ok(url, `${rel} declares no repository url`)
    assert.equal(url, EXPECTED, `${rel} repository.url is "${url}"`)
    // The private monorepo URL is a suffix trap: ".../flashyos" vs
    // ".../flashyos-wdk". Assert it is not the bare monorepo.
    assert.doesNotMatch(url, /FlashyLabs\/flashyos$/, `${rel} still points at the private monorepo`)
  })
}
