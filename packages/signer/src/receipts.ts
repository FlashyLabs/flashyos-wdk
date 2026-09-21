// Receipt polling. A returned hash means the node accepted the transaction,
// not that the chain did; the outcome the plane records — CONFIRMED or
// REVERTED — is the receipt's status after the configured number of blocks.
//
// Plain JSON-RPC over fetch, on purpose: no wallet library in the loop, so
// this can be tested against a fake endpoint and reused for any EVM chain.

export type ReceiptOutcome = 'CONFIRMED' | 'REVERTED';

export interface Receipt {
  outcome: ReceiptOutcome;
  blockNumber: number;
  confirmations: number;
}

export interface ReceiptPollerOptions {
  rpcUrl: string;
  /** Blocks on top of the inclusion block before a receipt counts. Default 1. */
  confirmations?: number;
  pollMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The transaction was broadcast but no receipt arrived in time. Carries the hash so an operator can reconcile. */
export class ReceiptTimeout extends Error {
  readonly code = 'RECEIPT_TIMEOUT' as const;
  constructor(readonly txHash: string, readonly waitedMs: number) {
    super(`no receipt for ${txHash} after ${waitedMs}ms; the transaction may still confirm`);
    this.name = 'ReceiptTimeout';
  }
}

interface JsonRpcReceipt {
  status?: string;
  blockNumber?: string;
}

export class ReceiptPoller {
  private readonly confirmations: number;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextId = 1;

  constructor(private readonly options: ReceiptPollerOptions) {
    this.confirmations = options.confirmations ?? 1;
    this.pollMs = options.pollMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
    if (this.confirmations < 0) throw new Error('confirmations must be non-negative');
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message ?? 'rpc error'}`);
    return body.result as T;
  }

  async blockNumber(): Promise<number> {
    return Number(BigInt(await this.rpc<string>('eth_blockNumber', [])));
  }

  /** Resolves with the terminal outcome, or throws ReceiptTimeout. */
  async wait(txHash: string): Promise<Receipt> {
    const started = this.now();
    for (;;) {
      const receipt = await this.rpc<JsonRpcReceipt | null>('eth_getTransactionReceipt', [txHash]);
      if (receipt?.blockNumber) {
        const included = Number(BigInt(receipt.blockNumber));
        const head = await this.blockNumber();
        const confirmations = Math.max(0, head - included);
        if (confirmations >= this.confirmations) {
          return {
            outcome: receipt.status === '0x1' ? 'CONFIRMED' : 'REVERTED',
            blockNumber: included,
            confirmations,
          };
        }
      }
      const waited = this.now() - started;
      if (waited >= this.timeoutMs) throw new ReceiptTimeout(txHash, waited);
      await this.sleep(this.pollMs);
    }
  }
}
