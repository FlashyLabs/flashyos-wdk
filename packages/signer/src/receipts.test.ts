import { describe, it, expect } from 'vitest';
import { ReceiptPoller, ReceiptTimeout } from './receipts';

// The poller against a scripted JSON-RPC endpoint. Time is injected, so the
// tests run in milliseconds and the timeout math is exact.

type Script = { receipt: { status: string; blockNumber: string } | null; head: string }[];

function endpoint(script: Script) {
  let call = 0;
  let step = script[0];
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: number };
    calls.push(body.method);
    let result: unknown;
    if (body.method === 'eth_getTransactionReceipt') {
      // Each receipt query consumes a step; the head query that may follow reads the same step.
      step = script[Math.min(call, script.length - 1)];
      call += 1;
      result = step.receipt;
    } else if (body.method === 'eth_blockNumber') result = step.head;
    else return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: `unknown ${body.method}` } }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('ReceiptPoller', () => {
  it('confirms once the receipt has enough blocks on top', async () => {
    const { fetchImpl, calls } = endpoint([
      { receipt: null, head: '0x64' },
      { receipt: { status: '0x1', blockNumber: '0x65' }, head: '0x65' }, // included, 0 confirmations
      { receipt: { status: '0x1', blockNumber: '0x65' }, head: '0x67' }, // 2 confirmations
    ]);
    const { now, sleep } = clock();
    const poller = new ReceiptPoller({ rpcUrl: 'http://rpc', confirmations: 2, pollMs: 1000, timeoutMs: 60_000, fetch: fetchImpl, now, sleep });
    const receipt = await poller.wait('0xabc');
    expect(receipt).toEqual({ outcome: 'CONFIRMED', blockNumber: 101, confirmations: 2 });
    expect(calls.filter((m) => m === 'eth_getTransactionReceipt')).toHaveLength(3);
  });

  it('a status of 0x0 is REVERTED', async () => {
    const { fetchImpl } = endpoint([{ receipt: { status: '0x0', blockNumber: '0x10' }, head: '0x11' }]);
    const poller = new ReceiptPoller({ rpcUrl: 'http://rpc', fetch: fetchImpl, ...clock() });
    expect((await poller.wait('0xabc')).outcome).toBe('REVERTED');
  });

  it('zero confirmations accepts the inclusion block itself', async () => {
    const { fetchImpl } = endpoint([{ receipt: { status: '0x1', blockNumber: '0x10' }, head: '0x10' }]);
    const poller = new ReceiptPoller({ rpcUrl: 'http://rpc', confirmations: 0, fetch: fetchImpl, ...clock() });
    expect((await poller.wait('0xabc')).confirmations).toBe(0);
  });

  it('times out with the hash attached when no receipt arrives', async () => {
    const { fetchImpl, calls } = endpoint([{ receipt: null, head: '0x10' }]);
    const poller = new ReceiptPoller({ rpcUrl: 'http://rpc', pollMs: 1000, timeoutMs: 3500, fetch: fetchImpl, ...clock() });
    await expect(poller.wait('0xabc')).rejects.toMatchObject({ code: 'RECEIPT_TIMEOUT', txHash: '0xabc', waitedMs: 4000 });
    await expect(poller.wait('0xabc')).rejects.toBeInstanceOf(ReceiptTimeout);
    expect(calls.filter((m) => m === 'eth_getTransactionReceipt').length).toBeGreaterThanOrEqual(4);
  });

  it('surfaces an rpc error rather than treating it as "no receipt yet"', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }))) as unknown as typeof fetch;
    const poller = new ReceiptPoller({ rpcUrl: 'http://rpc', fetch: fetchImpl, ...clock() });
    await expect(poller.wait('0xabc')).rejects.toThrow(/rate limited/);
  });

  it('surfaces an HTTP failure', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const poller = new ReceiptPoller({ rpcUrl: 'http://rpc', fetch: fetchImpl, ...clock() });
    await expect(poller.wait('0xabc')).rejects.toThrow(/HTTP 503/);
  });
});
