import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// `vendor-invariants.mjs` is a copy of spec-kit's `invariants/1` harness and a
// copy drifts the day its source moves. Compared against the canonical file
// when spec-kit is checked out beside this repository — the way every other
// vendored comparison in the estate finds its canon — and reported UNKNOWN,
// a skipped test carrying the reason, when it is not. Never a pass: a copy
// nobody could compare is not a copy that is up to date.

const PKG = resolve(__dirname, '..');
const LOCAL = resolve(PKG, 'vendor-invariants.mjs');
const CANON = resolve(PKG, '../../../spec-kit/vendor-invariants.mjs');
const present = existsSync(CANON);

describe('vendor-invariants.mjs', () => {
  it('is present beside this package and declares the kit it is a copy of', () => {
    expect(existsSync(LOCAL)).toBe(true);
    expect(readFileSync(LOCAL, 'utf8')).toContain("export const KIT = 'invariants/1'");
  });

  (present ? it : it.skip)(
    present ? 'is byte-identical to spec-kit/vendor-invariants.mjs' : 'UNKNOWN: spec-kit is not checked out beside this repository',
    () => {
      expect(readFileSync(LOCAL, 'utf8')).toBe(readFileSync(CANON, 'utf8'));
    },
  );
});
