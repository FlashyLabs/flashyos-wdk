import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { EXTRACTOR_MANIFEST } from './manifest';
import { evmExtractorPack, tronExtractorPack } from '../transactionPolicy';

// The published manifest must be the code's. UPDATE_SCHEMAS=1 regenerates it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLISHED = path.resolve(HERE, '../../../../docs/wallet/schema/extractor-packs.json');

describe('docs/wallet/schema/extractor-packs.json', () => {
  it('is exactly the manifest the packs declare', () => {
    const expected = JSON.stringify(EXTRACTOR_MANIFEST, null, 2) + '\n';
    if (process.env.UPDATE_SCHEMAS === '1') {
      mkdirSync(path.dirname(PUBLISHED), { recursive: true });
      writeFileSync(PUBLISHED, expected);
    }
    expect(existsSync(PUBLISHED), `${PUBLISHED} is missing; run with UPDATE_SCHEMAS=1`).toBe(true);
    expect(readFileSync(PUBLISHED, 'utf8')).toBe(expected);
  });

  it('names every method the packs actually implement, and nothing more', () => {
    const evm = EXTRACTOR_MANIFEST.families.find((f) => f.family === 'evm')!;
    const tron = EXTRACTOR_MANIFEST.families.find((f) => f.family === 'tron')!;
    expect(evm.methods.sort()).toEqual(Object.keys(evmExtractorPack).sort());
    expect(tron.methods.sort()).toEqual(Object.keys(tronExtractorPack).sort());
  });
});
