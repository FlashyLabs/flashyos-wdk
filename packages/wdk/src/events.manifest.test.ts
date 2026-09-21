import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { FLASHY_EVENT_TYPES } from './events';

// The published list of events must be the code's. UPDATE_SCHEMAS=1 regenerates it.
const PUBLISHED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/wallet/schema/events.json');

describe('docs/wallet/schema/events.json', () => {
  it('is exactly the list of events the object emits', () => {
    const manifest = {
      $id: 'https://flashyos.com/schema/wallet/events.json',
      title: 'FlashyEvent types',
      description: 'Every event @flashyos/wdk emits, one per verb. Shape: { type, at, orgId, agentName?, data }.',
      types: [...FLASHY_EVENT_TYPES],
    };
    const expected = JSON.stringify(manifest, null, 2) + '\n';
    if (process.env.UPDATE_SCHEMAS === '1') {
      mkdirSync(path.dirname(PUBLISHED), { recursive: true });
      writeFileSync(PUBLISHED, expected);
    }
    expect(existsSync(PUBLISHED), `${PUBLISHED} is missing; run with UPDATE_SCHEMAS=1`).toBe(true);
    expect(readFileSync(PUBLISHED, 'utf8')).toBe(expected);
    expect(new Set(FLASHY_EVENT_TYPES).size).toBe(FLASHY_EVENT_TYPES.length);
  });
});
