// The root test script names every test file, and globs none of them.
//
// `node --test test/*.test.mjs` asks the SHELL to expand the glob; cmd.exe
// does not, and Node only expands one itself from 21. The workspace suites are
// vitest, which does its own globbing and is unaffected — this is the root
// suite only, and it failed on Windows before a single case ran.
//
// Naming files has one failure mode: a test file nothing runs, which looks
// exactly like a test file that passes. That is what this guards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const script = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.test

const named = (script.match(/test\/[\w.-]+\.test\.mjs/g) ?? []).sort()
const onDisk = readdirSync(join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => `test/${f}`)
  .sort()

test('the root test script names files rather than globbing them', () => {
  assert.ok(!script.includes('test/*'), `the root test script globs: ${script}`)
  assert.ok(named.length > 0, `no test files named in the script: ${script}`)
})

test('every root test file is in the script', () => {
  assert.ok(onDisk.length > 0, 'no test files found on disk')
  assert.deepEqual(named, onDisk, 'the root test script and test/ disagree')
})
