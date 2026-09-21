import { describe, it, expect } from 'vitest';
import WDK from '@tetherto/wdk';
import { SecondLineRefusal, WdkChain, type WdkEvmAccount, type WdkEvmTransaction, type WdkModules } from './chain';
import { MainnetNotEnabled, TESTNETS } from './testnets';
import type { Receipt } from './receipts';

// WdkChain against the *real* @tetherto/wdk policy engine and a fake wallet
// module. The fake stands in for the network; the engine, the proxy and the
// deny-by-default behaviour are Tether's code, exercised as shipped.

const USDT = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'; // a Base Sepolia test token address shape
const VENDOR = '0x7f3c000000000000000000000000000000000001';
const STRANGER = '0x7f3c000000000000000000000000000000000099';
const SEED = 'test test test test test test test test test test test junk';

class FakeAccount implements WdkEvmAccount {
  readonly sent: WdkEvmTransaction[] = [];
  async getAddress() {
    return '0x00000000000000000000000000000000000000aa';
  }
  toReadOnlyAccount() {
    return { getAddress: async () => '0x00000000000000000000000000000000000000aa' };
  }
  async sendTransaction(tx: WdkEvmTransaction) {
    this.sent.push(tx);
    return { hash: `0xhash${this.sent.length}`, fee: 21_000n };
  }
  async approve() {
    return { hash: '0xapprove', fee: 1n };
  }
  async transfer() {
    return { hash: '0xtransfer', fee: 1n };
  }
  dispose() {}
}

class FakeManager {
  static last: FakeManager | null = null;
  readonly account = new FakeAccount();
  constructor(readonly seed: string, readonly config: { provider: string; chainId: number }) {
    FakeManager.last = this;
  }
  async getAccount() {
    return this.account;
  }
  async getAccountByPath() {
    return this.account;
  }
  dispose() {}
}

const modules = async (): Promise<WdkModules> => ({ WDK: WDK as unknown as WdkModules['WDK'], WalletManagerEvm: FakeManager });

function poller(outcomes: Receipt['outcome'][] = ['CONFIRMED']) {
  let i = 0;
  return { wait: async () => ({ outcome: outcomes[Math.min(i++, outcomes.length - 1)], blockNumber: 100, confirmations: 1 }) };
}

function chain(overrides: Partial<ConstructorParameters<typeof WdkChain>[0]> = {}) {
  return new WdkChain({ chain: 'evm:84532', seedPhrase: SEED, modules, poller: poller(), ...overrides });
}

describe('WdkChain — testnets only', () => {
  it.each(['evm:8453', 'evm:1', 'evm:42161', 'tron:mainnet', 'evm:'])('refuses to construct for %s', (mainnet) => {
    expect(() => new WdkChain({ chain: mainnet, seedPhrase: SEED, modules })).toThrow(MainnetNotEnabled);
  });

  it('is the EVM backend: a TRON testnet is refused with a pointer to the right one', () => {
    expect(() => new WdkChain({ chain: 'tron:nile', seedPhrase: SEED, modules })).toThrow(/tron testnet; this backend is for evm/);
  });

  it.each(TESTNETS.filter((t) => t.family === 'evm').map((t) => t.chain))('constructs for %s and passes the numeric chain id to the wallet module', async (testnet) => {
    const c = new WdkChain({ chain: testnet, seedPhrase: SEED, modules, poller: poller() });
    await c.account();
    expect(FakeManager.last?.config.chainId).toBe(Number(testnet.split(':')[1]));
    expect(FakeManager.last?.config.provider).toMatch(/^https:\/\//);
  });

  it('has no override: the option bag accepts nothing that widens the list', () => {
    const options = { chain: 'evm:8453', seedPhrase: SEED, modules, allowMainnet: true, WALLET_ALLOW_MAINNET: '1' };
    expect(() => new WdkChain(options as never)).toThrow(MainnetNotEnabled);
  });
});

describe('WdkChain.execute', () => {
  it('sends an ERC-20 transfer as calldata and reports the receipt outcome', async () => {
    const c = chain();
    const result = await c.execute({ kind: 'transfer', chain: 'evm:84532', asset: USDT, amount: '25000000', destination: VENDOR });
    expect(result).toEqual({ txHash: '0xhash1', outcome: 'CONFIRMED' });
    const [tx] = FakeManager.last!.account.sent;
    expect(tx.to).toBe(USDT);
    expect(tx.value).toBe(0n);
    expect(tx.data).toBe('0xa9059cbb' + VENDOR.slice(2).padStart(64, '0') + (25_000_000n).toString(16).padStart(64, '0'));
  });

  it('sends a native transfer as value', async () => {
    const c = chain();
    await c.execute({ kind: 'transfer', chain: 'evm:84532', asset: 'native', amount: '12', destination: VENDOR });
    expect(FakeManager.last!.account.sent[0]).toEqual({ to: VENDOR, value: 12n });
  });

  it('a reverted receipt is REVERTED, not an error', async () => {
    const c = chain({ poller: poller(['REVERTED']) });
    const result = await c.execute({ kind: 'transfer', chain: 'evm:84532', asset: 'native', amount: '1', destination: VENDOR });
    expect(result.outcome).toBe('REVERTED');
  });

  it('refuses a record for another chain and anything but a transfer', async () => {
    const c = chain();
    await expect(c.execute({ kind: 'transfer', chain: 'evm:11155111', asset: 'native', amount: '1', destination: VENDOR })).rejects.toThrow(/handed a record for evm:11155111/);
    await expect(c.execute({ kind: 'swap', chain: 'evm:84532', asset: USDT, amount: '1', destination: null })).rejects.toThrow(/swap needs its protocol call/);
  });

  it('a receipt timeout propagates with the hash for the operator', async () => {
    const { ReceiptTimeout } = await import('./receipts');
    const c = chain({ poller: { wait: async (h) => { throw new ReceiptTimeout(h, 5); } } });
    await expect(c.execute({ kind: 'transfer', chain: 'evm:84532', asset: 'native', amount: '1', destination: VENDOR })).rejects.toMatchObject({ code: 'RECEIPT_TIMEOUT', txHash: '0xhash1' });
  });
});

describe('the second line — WDK policy engine on the governed account', () => {
  it('refuses a sendTransaction that is not the operation in flight, with WDK\'s own denial code', async () => {
    const c = chain();
    const account = await c.account();
    await expect(account.sendTransaction({ to: STRANGER, value: 1n })).rejects.toMatchObject({ name: 'PolicyViolationError', code: 'GOVERNED_BUT_UNMATCHED' });
    expect(FakeManager.last!.account.sent).toHaveLength(0);
  });

  it('refuses every other write on the governed account — deny by default', async () => {
    const c = chain();
    const account = (await c.account()) as unknown as { approve: () => Promise<unknown>; transfer: () => Promise<unknown> };
    await expect(account.approve()).rejects.toMatchObject({ code: 'NO_APPLICABLE_RULE' });
    await expect(account.transfer()).rejects.toMatchObject({ code: 'NO_APPLICABLE_RULE' });
  });

  it('allows exactly the in-flight operation, then nothing again', async () => {
    const c = chain();
    await c.execute({ kind: 'transfer', chain: 'evm:84532', asset: 'native', amount: '7', destination: VENDOR });
    const account = await c.account();
    // The same transaction, replayed after execute() returned, is no longer in flight.
    await expect(account.sendTransaction({ to: VENDOR, value: 7n })).rejects.toMatchObject({ code: 'GOVERNED_BUT_UNMATCHED' });
    expect(FakeManager.last!.account.sent).toHaveLength(1);
  });

  it('reads stay open: the second line governs writes only', async () => {
    const c = chain();
    const account = await c.account();
    await expect(account.getAddress()).resolves.toMatch(/^0x/);
  });

  it('a backend bug that sent something else would surface as SecondLineRefusal', async () => {
    // Simulate the bug: patch transactionFor to build the wrong destination.
    const original = WdkChain.transactionFor;
    WdkChain.transactionFor = () => ({ to: STRANGER, value: 1n });
    try {
      const c = chain();
      await expect(c.execute({ kind: 'transfer', chain: 'evm:84532', asset: 'native', amount: '1', destination: VENDOR })).rejects.toBeInstanceOf(SecondLineRefusal);
      expect(FakeManager.last!.account.sent).toHaveLength(0);
    } finally {
      WdkChain.transactionFor = original;
    }
  });
});

describe('WdkChain — per-agent accounts and typed data (Phases 17–18)', () => {
  class IndexedManager {
    static last: IndexedManager | null = null;
    readonly accounts = new Map<number, FakeAccount & { index: number }>();
    constructor(readonly seed: string, readonly config: { provider: string; chainId: number }) { IndexedManager.last = this; }
    async getAccount(index = 0) {
      let a = this.accounts.get(index);
      if (!a) {
        a = Object.assign(new FakeAccount(), { index, getAddress: async () => `0x${index.toString(16).padStart(40, '0')}` });
        this.accounts.set(index, a);
      }
      return a;
    }
    async getAccountByPath() { return this.getAccount(0); }
    dispose() {}
  }
  const indexed = async (): Promise<WdkModules> => ({ WDK: WDK as unknown as WdkModules['WDK'], WalletManagerEvm: IndexedManager });

  it('derives one address per index and executes with the index it is handed', async () => {
    const c = new WdkChain({ chain: 'evm:84532', seedPhrase: SEED, modules: indexed, poller: poller() });
    expect(await c.address(3)).toBe('0x0000000000000000000000000000000000000003');
    expect(await c.address(0)).toBe('0x0000000000000000000000000000000000000000');
    await c.execute({ kind: 'transfer', chain: 'evm:84532', asset: 'native', amount: '1', destination: VENDOR }, undefined, { accountIndex: 3 });
    expect(IndexedManager.last!.accounts.get(3)!.sent).toHaveLength(1);
    expect(IndexedManager.last!.accounts.get(0)!.sent).toHaveLength(0);
  });

  it('signs matching typed data through the governed account, and the second line refuses any other typed data', async () => {
    const { eip3009TypedData } = await import('@flashyos/wallet-wdk');
    const signing = async (): Promise<WdkModules> => {
      class SigningManager extends IndexedManager {
        async getAccount(index = 0) {
          const a = await super.getAccount(index);
          return Object.assign(a, { signTypedData: async () => `0xsig-from-${index}` });
        }
      }
      return { WDK: WDK as unknown as WdkModules['WDK'], WalletManagerEvm: SigningManager };
    };
    const c = new WdkChain({ chain: 'evm:84532', seedPhrase: SEED, modules: signing, poller: poller() });
    const accept = { scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000', payTo: VENDOR, asset: USDT, extra: { name: 'USDC', version: '2' } };
    const td = eip3009TypedData(accept, '0x0000000000000000000000000000000000000002', { nonce: '0x' + '11'.repeat(32) });
    const signed = await c.signTypedData(td, { accountIndex: 2 });
    expect(signed).toEqual({ signature: '0xsig-from-2', address: '0x0000000000000000000000000000000000000002' });
    // Outside signTypedData(), the same account's signTypedData is governed and unmatched.
    const account = (await c.account(2)) as unknown as { signTypedData: (t: unknown) => Promise<string> };
    await expect(account.signTypedData(td)).rejects.toMatchObject({ name: 'PolicyViolationError', code: 'GOVERNED_BUT_UNMATCHED' });
  });

  it('reports TypedDataUnsupported when the WDK account throws NotImplementedError (the seed signer in beta.19 does)', async () => {
    const { TypedDataUnsupported } = await import('./chain');
    const { eip3009TypedData } = await import('@flashyos/wallet-wdk');
    const notImplemented = async (): Promise<WdkModules> => {
      class NIManager extends IndexedManager {
        async getAccount(index = 0) {
          const a = await super.getAccount(index);
          return Object.assign(a, { signTypedData: async () => { const e = new Error('signTypedData(typedData) is not implemented'); e.name = 'NotImplementedError'; throw e; } });
        }
      }
      return { WDK: WDK as unknown as WdkModules['WDK'], WalletManagerEvm: NIManager };
    };
    const c = new WdkChain({ chain: 'evm:84532', seedPhrase: SEED, modules: notImplemented, poller: poller() });
    const accept = { scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '1', payTo: VENDOR, asset: USDT };
    const td = eip3009TypedData(accept, '0x0000000000000000000000000000000000000000', { nonce: '0x' + '22'.repeat(32) });
    await expect(c.signTypedData(td)).rejects.toBeInstanceOf(TypedDataUnsupported);
  });
});
