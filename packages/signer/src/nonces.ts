// Spent-nonce store. An authorization id is used at most once, and the
// signer records it as used *before* broadcasting — a crash between the two
// leaves an authorization that was never spent marked as spent, which is the
// safe direction. The plane's own SPENT status is the second copy of this
// fact; this store is the one the signer consults without a network hop.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'fs';
import { dirname } from 'path';

export interface NonceStore {
  has(id: string): Promise<boolean>;
  add(id: string): Promise<void>;
  /**
   * Mark `id` spent and say whether THIS call did it: true the first time,
   * false if it was already spent. `has` then `add` is two steps, and two
   * requests carrying one authorization that interleave between them both
   * pass — reproduced against the mock backend 2026-10-10, and in the npm
   * release. At-most-once needs the check and the record to be one step, which
   * is what `spend` is; the signer consumes an authorization through it.
   */
  spend(id: string): Promise<boolean>;
}

export class MemoryNonceStore implements NonceStore {
  private readonly spent = new Set<string>();
  async has(id: string): Promise<boolean> {
    return this.spent.has(id);
  }
  async add(id: string): Promise<void> {
    this.spent.add(id);
  }
  // Synchronous check-and-set on the Set: no await between the two, so no
  // other caller can slip in. The async signature is the interface's.
  async spend(id: string): Promise<boolean> {
    if (this.spent.has(id)) return false;
    this.spent.add(id);
    return true;
  }
}

/**
 * One id per line, append-only, fsync'd on every add. Survives a restart,
 * which MemoryNonceStore does not: a signer that forgets what it spent
 * accepts a replay of every authorization still inside its window.
 *
 * Deliberately not a database. The signer runs alone, holds a seed, and
 * should have as few dependencies as it can; a file it owns is enough for one
 * process. Running two signers against one seed needs a shared store and is
 * out of scope — see docs/wallet/testnet.md.
 */
export class FileNonceStore implements NonceStore {
  private readonly spent = new Set<string>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const id = line.trim();
        if (id) this.spent.add(id);
      }
    }
  }

  get size(): number {
    return this.spent.size;
  }

  async has(id: string): Promise<boolean> {
    return this.spent.has(id);
  }

  async add(id: string): Promise<void> {
    if (id.includes('\n')) throw new Error('authorization id must not contain a newline');
    if (this.spent.has(id)) return;

    // Durable before the caller continues to broadcast, through ONE descriptor.
    //
    // This appended with `appendFileSync` and then reopened the file `'r'` to
    // fsync it. On Linux that works, because fsync flushes the file rather
    // than the handle. On Windows it does not: FlushFileBuffers needs a handle
    // with write access, so fsync on a read-only descriptor fails `EPERM`
    // (errno -4048) — and `add` threw before recording the nonce.
    //
    // That is worse than a portability bug in a nonce store. A signer's replay
    // protection is exactly the thing that must not fail open, and on Windows
    // every `add` raised. Found 2026-09-23 by the first CI run that included a
    // windows-latest cell, on code that had been green on ubuntu throughout.
    //
    // Writing and syncing through the same append handle is both portable and
    // a stronger guarantee: the flush applies to the descriptor that did the
    // write, rather than to whatever a second open happened to return.
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, `${id}\n`, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // Only after the bytes are durable. If the write throws, the id stays
    // unspent in memory too — a store that marked it spent and failed to
    // persist would allow the replay it exists to stop, one restart later.
    this.spent.add(id);
  }
  /**
   * Check-and-set in one synchronous step on the in-memory set — the file
   * append below it is what makes the spend survive a restart. Nothing awaits
   * between the check and the record, so two concurrent spends of one id
   * cannot both see it unspent.
   */
  async spend(id: string): Promise<boolean> {
    if (this.spent.has(id)) return false;
    await this.add(id);
    return true;
  }

}
