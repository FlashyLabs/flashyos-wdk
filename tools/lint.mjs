// Dependency-free lint: syntax-check every JavaScript module the repo ships.
//
// The workspaces' TypeScript is type-checked by `tsc --noEmit` (the `typecheck`
// script). Nothing, though, checked the repo's `.mjs` files — the root test
// suite and the package examples — so a syntax error in one of them surfaced
// only when that file happened to be executed, and an example that nothing runs
// could rot silently. `node --check` parses a module without running it, which
// is exactly the guarantee a lint gives here without adding a dependency to a
// tree whose governance record (MESH.md, the `conformance` role) already
// claims a lint exists.
//
// No eslint: this repo ships no eslint config and no eslint binary, and
// inventing one would be a dependency and a ruleset nobody agreed to. The
// honest lint is the one that runs with what is installed.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKIP = new Set(['node_modules', '.git', 'dist'])

/** Every `.mjs` file under `dir`, recursively, skipping generated/vendored trees. */
export function collectModules(dir = ROOT) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      out.push(...collectModules(join(dir, entry.name)))
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/** Runs `node --check` on each file; returns the list of files that failed. */
export function lint(files = collectModules()) {
  const failures = []
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status !== 0) {
      failures.push({ file: relative(ROOT, file), message: (result.stderr || result.stdout || '').trim() })
    }
  }
  return failures
}

// Run only when invoked directly, so the collectors above can be imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = collectModules()
  const failures = lint(files)
  if (failures.length > 0) {
    for (const { file, message } of failures) {
      console.error(`lint: ${file}\n${message}\n`)
    }
    console.error(`lint: ${failures.length} of ${files.length} module(s) failed`)
    process.exit(1)
  }
  console.log(`lint: ${files.length} module(s) OK`)
}
