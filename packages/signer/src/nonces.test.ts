import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileNonceStore, MemoryNonceStore } from './nonces';

describe('MemoryNonceStore', () => {
  it('remembers what it was given', async () => {
    const store = new MemoryNonceStore();
    expect(await store.has('a')).toBe(false);
    await store.add('a');
    expect(await store.has('a')).toBe(true);
  });
});

describe('FileNonceStore', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'nonces-'));

  it('survives a restart — the property MemoryNonceStore lacks', async () => {
    const path = join(dir(), 'spent', 'nonces.txt');
    const first = new FileNonceStore(path);
    await first.add('auth_1');
    await first.add('auth_2');

    const second = new FileNonceStore(path);
    expect(second.size).toBe(2);
    expect(await second.has('auth_1')).toBe(true);
    expect(await second.has('auth_3')).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('auth_1\nauth_2\n');
  });

  it('is idempotent and ignores blank lines on load', async () => {
    const path = join(dir(), 'nonces.txt');
    const store = new FileNonceStore(path);
    await store.add('x');
    await store.add('x');
    expect(readFileSync(path, 'utf8')).toBe('x\n');
    expect(new FileNonceStore(path).size).toBe(1);
  });

  it('refuses an id that would corrupt the file', async () => {
    const store = new FileNonceStore(join(dir(), 'nonces.txt'));
    await expect(store.add('a\nb')).rejects.toThrow(/newline/);
    expect(await store.has('a')).toBe(false);
  });
});
