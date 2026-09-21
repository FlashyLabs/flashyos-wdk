import { describe, it, expect } from 'vitest';
import WDK from '@tetherto/wdk';
import { SwapProtocol, BridgeProtocol } from '@tetherto/wdk-wallet/protocols';
import { SecondLineRefusal, WdkChain, type WdkEvmAccount, type WdkEvmTransaction, type WdkModules } from './chain';
import { Signer } from './signer';
import { generateKeyPairSync, sign } from 'crypto';
import { canonicalize } from './verify';
import type { SignedSpendAuthorization } from '@flashyos/wallet-wdk';

// Swaps and bridges through WdkChain: executed from the call's options,
// through a registered WDK protocol, with WDK's engine intercepting the
// protocol method as its own operation — so the second line covers them too.
// Real @tetherto/wdk engine and protocol base classes; fake wallet module.

const USDT = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const WETH = '0x4200000000000000000000000000000000000006';
const VENDOR = '0x7f3c000000000000000000000000000000000001';
const TRON_VENDOR = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9';
const SEED = 'test test test test test test test test test test test junk';

class FakeAccount implements WdkEvmAccount {
  readonly sent: WdkEvmTransaction[] = [];
  async getAddress() { return '0x00000000000000000000000000000000000000aa'; }
  toReadOnlyAccount() { return { getAddress: async () => '0x00000000000000000000000000000000000000aa' }; }
  async sendTransaction(tx: WdkEvmTransaction) { this.sent.push(tx); return { hash: `0xhash${this.sent.length}`, fee: 1n }; }
  dispose() {}
}
class FakeManager {
  static last: FakeManager | null = null;
  readonly account = new FakeAccount();
  constructor() { FakeManager.last = this; }
  async getAccount() { return this.account; }
  async getAccountByPath() { return this.account; }
  dispose() {}
}
/** A swap protocol that, like the real ones, executes through the account it was given. */
class FakeSwap extends SwapProtocol {
  static calls: unknown[] = [];
  async swap(options: { tokenIn: string; tokenOut: string; tokenInAmount?: bigint | string | number }) {
    FakeSwap.calls.push(options);
    const r = await (this._account as unknown as FakeAccount).sendTransaction({ to: '0x00000000000000000000000000000000000r0ute', value: 0n, data: '0xswap' });
    return { hash: r.hash, fee: 1n, tokenInAmount: BigInt(options.tokenInAmount ?? 0), tokenOutAmount: 1n };
  }
  async quoteSwap() { return { fee: 1n, tokenInAmount: 1n, tokenOutAmount: 1n }; }
}
class FakeBridge extends BridgeProtocol {
  static calls: unknown[] = [];
  async bridge(options: object) { FakeBridge.calls.push(options); return { hash: '0xbridged', fee: 1n, bridgeFee: 1n }; }
  async quoteBridge() { return { fee: 1n, bridgeFee: 1n }; }
}

const modules = async (): Promise<WdkModules> => ({ WDK: WDK as unknown as WdkModules['WDK'], WalletManagerEvm: FakeManager });
const poller = { wait: async () => ({ outcome: 'CONFIRMED' as const, blockNumber: 1, confirmations: 1 }) };
const chain = () =>
  new WdkChain({
    chain: 'evm:84532', seedPhrase: SEED, modules, poller,
    protocols: { swap: { label: 'fake-swap', Protocol: FakeSwap, config: {} }, bridge: { label: 'fake-bridge', Protocol: FakeBridge, config: {} } },
  });

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const planePublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
function issue(patch: Partial<SignedSpendAuthorization>): SignedSpendAuthorization {
  const payload = {
    id: `auth_${Math.random().toString(36).slice(2)}`, orgId: 'org_1', agentName: 'market-ops', chain: 'evm:84532', kind: 'swap' as const,
    asset: USDT, maxAmount: '1000', destination: null, reservationId: 'rsv', decisionId: 'dec',
    issuedAt: '2026-09-19T11:00:00.000Z', expiresAt: '2026-09-19T11:05:00.000Z', ...patch,
  };
  return { ...payload, sig: sign(null, canonicalize({ ...payload, sig: '' }), privateKey).toString('base64url') };
}
const NOW = () => new Date('2026-09-19T11:02:00Z');

describe('WdkChain swaps and bridges', () => {
  it('executes a swap through the registered protocol, from the call\'s options, and the second line lets exactly that through', async () => {
    const c = chain();
    const call = { protocol: 'swap' as const, options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: '500', minAmountOut: '1' } };
    const result = await c.execute({ kind: 'swap', chain: 'evm:84532', asset: USDT, amount: '500', destination: null }, call);
    expect(result).toEqual({ txHash: '0xhash1', outcome: 'CONFIRMED' });
    expect(FakeSwap.calls.at(-1)).toEqual(call.options);
  });

  it('a swap without its protocol call, or a bridge without a registered protocol, is refused without touching the account', async () => {
    const c = chain();
    await expect(c.execute({ kind: 'swap', chain: 'evm:84532', asset: USDT, amount: '500', destination: null })).rejects.toThrow(/needs its protocol call/);
    const bare = new WdkChain({ chain: 'evm:84532', seedPhrase: SEED, modules, poller });
    await expect(bare.execute({ kind: 'bridge', chain: 'evm:84532', asset: USDT, amount: '1', destination: `evm:421614:${VENDOR}` }, { protocol: 'bridge', options: { targetChain: 'evm:421614', recipient: VENDOR, token: USDT, amount: '1' } })).rejects.toThrow(/no bridge protocol/);
    expect(FakeManager.last!.account.sent).toHaveLength(0);
  });

  it('the second line refuses a swap on the governed account that is not in flight — WDK intercepts the protocol method itself', async () => {
    const c = chain();
    const account = await c.account();
    await expect(account.getSwapProtocol!('fake-swap').swap({ tokenIn: USDT, tokenOut: WETH, tokenInAmount: 5n })).rejects.toMatchObject({ name: 'PolicyViolationError', code: 'GOVERNED_BUT_UNMATCHED' });
    await expect(account.getBridgeProtocol!('fake-bridge').bridge({ targetChain: 'evm:421614', recipient: VENDOR, token: USDT, amount: 1n })).rejects.toMatchObject({ code: 'GOVERNED_BUT_UNMATCHED' });
  });

  it('a backend bug that swapped more than the record would meet the second line', async () => {
    const c = chain();
    // The record says 500; the "bug" hands the protocol 900.
    const call = { protocol: 'swap' as const, options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: '900' } };
    await expect(c.execute({ kind: 'swap', chain: 'evm:84532', asset: USDT, amount: '500', destination: null }, call)).rejects.toBeInstanceOf(SecondLineRefusal);
  });

  it('a bridge binds the target chain and recipient; the engine allows exactly that', async () => {
    const c = chain();
    const call = { protocol: 'bridge' as const, options: { targetChain: 'tron:mainnet', recipient: TRON_VENDOR, token: USDT, amount: '25' } };
    const result = await c.execute({ kind: 'bridge', chain: 'evm:84532', asset: USDT, amount: '25', destination: `tron:mainnet:${TRON_VENDOR}` }, call);
    expect(result.txHash).toBe('0xbridged');
    expect(FakeBridge.calls.at(-1)).toEqual(call.options);
  });
});

describe('Signer with swaps — the Phase 7 gate', () => {
  it('a swap goes through the signer\'s re-derivation, and a mismatched swap is refused the way a mismatched transfer is', async () => {
    const backend = chain();
    const signer = new Signer({ planePublicKeyPem, chains: [backend], now: NOW });
    const auth = issue({ maxAmount: '1000' });

    const ok = await signer.execute({ authorization: auth, call: { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: '1000' } } });
    expect(ok).toMatchObject({ ok: true, outcome: 'CONFIRMED' });

    const over = await signer.execute({ authorization: issue({ maxAmount: '1000' }), call: { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: '1001' } } });
    expect(over).toMatchObject({ ok: false, code: 'MISMATCH' });

    const wrongToken = await signer.execute({ authorization: issue({ maxAmount: '1000' }), call: { protocol: 'swap', options: { tokenIn: WETH, tokenOut: USDT, tokenInAmount: '1' } } });
    expect(wrongToken).toMatchObject({ ok: false, code: 'MISMATCH' });

    const sendsOut = await signer.execute({ authorization: issue({ maxAmount: '1000' }), call: { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: '1', to: VENDOR } } });
    expect(sendsOut).toMatchObject({ ok: false, code: 'MISMATCH' }); // authorized as internal; the call delivers elsewhere

    const buySide = await signer.execute({ authorization: issue({ maxAmount: '1000' }), call: { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenOutAmount: '1' } } });
    expect(buySide).toMatchObject({ ok: false, code: 'UNRECOGNISED_CALL' });

    const kindSwap = await signer.execute({ authorization: issue({ kind: 'transfer', destination: VENDOR }), call: { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: '1' } } });
    expect(kindSwap).toMatchObject({ ok: false, code: 'MISMATCH' });
  });

  it('a TRON transfer is re-derived and matched exactly', async () => {
    const tronBackend = { chain: 'tron:nile', execute: async () => ({ txHash: 'tron-hash', outcome: 'CONFIRMED' as const }) };
    const signer = new Signer({ planePublicKeyPem, chains: [tronBackend], now: NOW });
    const auth = issue({ chain: 'tron:nile', kind: 'transfer', asset: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', destination: TRON_VENDOR, maxAmount: '5' });
    expect(await signer.execute({ authorization: auth, call: { token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', recipient: TRON_VENDOR, amount: '5' } })).toMatchObject({ ok: true });
    expect(await signer.execute({ authorization: issue({ ...auth, id: 'other' }), call: { token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', recipient: TRON_VENDOR.toLowerCase(), amount: '5' } })).toMatchObject({ ok: false, code: 'UNRECOGNISED_CALL' });
  });
});
