// The lint is real, not prose. MESH.md's `conformance` role says this repo
// "runs the tests, the typecheck and the lint"; for that sentence to be true a
// `lint` script has to exist, CI has to run it, and it has to actually reject a
// broken module. This asserts all three — including that the linter fails on a
// genuine syntax error, because a lint that can only pass is the check that goes
// green for having looked at nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectModules, lint } from '../tools/lint.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('package.json declares a lint script that runs the linter', () => {
  assert.equal(typeof pkg.scripts.lint, 'string', 'no lint script declared')
  assert.match(pkg.scripts.lint, /tools\/lint\.mjs/, `lint script does not run the linter: ${pkg.scripts.lint}`)
})

test('CI runs the lint', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /npm run lint/, 'ci.yml does not run "npm run lint"')
})

test('the linter finds the repo modules and the whole tree passes today', () => {
  // Normalise to forward slashes: collectModules builds paths with path.join,
  // which uses "\" on Windows, so an endsWith('tools/lint.mjs') check is false
  // there even though the file is present — the real windows-latest CI break.
  const files = collectModules().map((f) => f.replace(/\\/g, '/'))
  assert.ok(files.length >= 5, `expected the linter to find several .mjs modules, found ${files.length}`)
  assert.ok(files.some((f) => f.endsWith('tools/lint.mjs')), 'the linter does not include itself')
  assert.ok(files.some((f) => f.endsWith('.test.mjs')), 'the linter does not include the root test files')
  const failures = lint(files)
  assert.deepEqual(failures, [], `lint failed on:\n${failures.map((f) => f.file).join('\n')}`)
})

test('the linter rejects a module with a syntax error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdk-lint-'))
  try {
    const bad = join(dir, 'broken.mjs')
    writeFileSync(bad, 'const x = ;\n') // deliberate parse error
    const failures = lint([bad])
    assert.equal(failures.length, 1, 'the linter did not report the broken module')
    assert.match(failures[0].file, /broken\.mjs$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a syntactically valid module passes the linter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wdk-lint-'))
  try {
    const good = join(dir, 'fine.mjs')
    writeFileSync(good, 'export const answer = 42\n')
    assert.deepEqual(lint([good]), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
