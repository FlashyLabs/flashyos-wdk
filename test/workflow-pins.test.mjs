// Every third-party action this repo's workflows call is pinned to a full
// commit SHA, never a floating tag or branch — a tag can be retargeted
// upstream (by the action's own maintainer, or by an attacker who
// compromises their account) and CI would silently start running whatever
// that tag now points to. A commit SHA can't move.
//
// Line-based, not a real YAML parser — a `uses:` line is simple enough not
// to need one. It would miss a `uses:` hidden inside a multi-line YAML
// string, which none of these workflows have.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows')

const SHA_PIN = /^[0-9a-f]{40}$/

function findUsesLines(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line: line.trim(), number: i + 1 }))
    .filter(({ line }) => line.startsWith('- uses:') || line.startsWith('uses:'))
}

test('every workflow file in .github/workflows is pinned to a commit SHA, never a tag or branch', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  assert.ok(files.length > 0, 'expected at least one workflow file to check')

  for (const file of files) {
    const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8')
    const usesLines = findUsesLines(text)
    assert.ok(usesLines.length > 0, `${file}: expected at least one "uses:" line`)

    for (const { line, number } of usesLines) {
      const match = line.match(/uses:\s*([^\s#]+)/)
      assert.ok(match, `${file}:${number}: couldn't parse a "uses:" reference from "${line}"`)
      const ref = match[1]
      const at = ref.lastIndexOf('@')
      assert.ok(at !== -1, `${file}:${number}: "${ref}" has no @<ref> at all`)
      const pin = ref.slice(at + 1)
      assert.match(pin, SHA_PIN,
        `${file}:${number}: "${ref}" is pinned to "${pin}", which is not a 40-character commit SHA — ` +
        'a tag or branch name can be retargeted upstream; pin to the commit SHA instead, ' +
        'with the version as a trailing "# vX.Y.Z" comment')
    }
  }
})

test('every "uses:" line names a version in a trailing comment, so a reader can tell what SHA means without looking it up', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  for (const file of files) {
    const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8')
    for (const { line, number } of findUsesLines(text)) {
      assert.match(line, /#\s*v?\d/, `${file}:${number}: "${line}" has no version comment after the SHA`)
    }
  }
})
