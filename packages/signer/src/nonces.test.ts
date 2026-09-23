import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync } from 'fs';
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

  it('does not mark a nonce spent when the write fails', async () => {
    // The invariant the Windows bug broke from the other side. `add` persists
    // and only then records in memory, so a store that could not write must
    // not believe it did — a nonce marked spent and never persisted allows,
    // one restart later, exactly the replay this class exists to stop.
    //
    // A directory standing where the file should be makes the write fail on
    // every platform, without touching permissions — which behave differently
    // per platform and would make this test its own portability problem. It
    // is created AFTER construction, so the store loads cleanly and fails at
    // exactly the step under test.
    const path = join(dir(), 'nonces.txt');
    const store = new FileNonceStore(path);
    mkdirSync(path, { recursive: true });

    await expect(store.add('auth_1')).rejects.toThrow();
    expect(await store.has('auth_1')).toBe(false);
    expect(store.size).toBe(0);
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
