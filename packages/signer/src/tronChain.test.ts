import { describe, it, expect } from 'vitest';
import WDK from '@tetherto/wdk';
import { generateKeyPairSync, sign } from 'crypto';
import { WdkTronChain, type WdkTronAccount, type WdkTronModules } from './tronChain';
import { SecondLineRefusal } from './chain';
import { MainnetNotEnabled } from './testnets';
import { Signer } from './signer';
import { canonicalize } from './verify';
import type { SignedSpendAuthorization } from '@flashyos/wallet-wdk';

// A second chain family through the same signer: nothing above the backend
// changed. Real @tetherto/wdk engine, fake TRON wallet module.

const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const VENDOR = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9';
const STRANGER = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
const SEED = 'test test test test test test test test test test test junk';

class FakeTronAccount implements WdkTronAccount {
  readonly sent: unknown[] = [];
  async getAddress() { return 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'; }
  toReadOnlyAccount() { return { getAddress: async () => 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' }; }
  async sendTransaction(tx: { to: string; value: bigint | number | string }) { this.sent.push({ sendTransaction: tx }); return { hash: `trx${this.sent.length}` }; }
  async transfer(o: { token: string; recipient: string; amount: bigint | number | string }) { this.sent.push({ transfer: o }); return { hash: `trc${this.sent.length}` }; }
  async approve() { return { hash: 'approve' }; }
  async waitForTransaction() { return { success: true }; }
  dispose() {}
}
class FakeTronManager {
  static last: FakeTronManager | null = null;
  readonly account = new FakeTronAccount();
  constructor(readonly seed: string, readonly config: { provider: string }) { FakeTronManager.last = this; }
  async getAccount() { return this.account; }
  async getAccountByPath() { return this.account; }
  dispose() {}
}
const modules = async (): Promise<WdkTronModules> => ({ WDK: WDK as unknown as WdkTronModules['WDK'], WalletManagerTron: FakeTronManager });
const chain = (extra: Partial<ConstructorParameters<typeof WdkTronChain>[0]> = {}) => new WdkTronChain({ chain: 'tron:nile', seedPhrase: SEED, modules, ...extra });

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const planePublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
function issue(patch: Partial<SignedSpendAuthorization>): SignedSpendAuthorization {
  const payload = {
    id: `auth_${Math.random().toString(36).slice(2)}`, orgId: 'org_1', agentName: 'ops', chain: 'tron:nile', kind: 'transfer' as const, asset: USDT_TRON,
    maxAmount: '5000000', destination: VENDOR, reservationId: 'r', decisionId: 'd', issuedAt: '2026-09-20T11:00:00.000Z', expiresAt: '2026-09-20T11:05:00.000Z', ...patch,
  };
  return { ...payload, sig: sign(null, canonicalize({ ...payload, sig: '' }), privateKey).toString('base64url') };
}
const NOW = () => new Date('2026-09-20T11:02:00Z');

describe('WdkTronChain — testnets only', () => {
  it('constructs for TRON testnets and refuses mainnet and EVM ids', async () => {
    const c = chain();
    await c.account();
    expect(FakeTronManager.last?.config.provider).toBe('https://nile.trongrid.io');
    expect(() => new WdkTronChain({ chain: 'tron:mainnet', seedPhrase: SEED, modules })).toThrow(MainnetNotEnabled);
    expect(() => new WdkTronChain({ chain: 'evm:84532', seedPhrase: SEED, modules })).toThrow(/is a evm testnet; this backend is for tron/);
  });

  it('executes a TRC-20 transfer through transfer() and TRX through sendTransaction(), and reports the account\'s receipt', async () => {
    const c = chain();
    expect(await c.execute({ kind: 'transfer', chain: 'tron:nile', asset: USDT_TRON, amount: '5000000', destination: VENDOR })).toEqual({ txHash: 'trc1', outcome: 'CONFIRMED' });
    expect(await c.execute({ kind: 'transfer', chain: 'tron:nile', asset: 'native', amount: '7', destination: VENDOR })).toEqual({ txHash: 'trx2', outcome: 'CONFIRMED' });
    expect(FakeTronManager.last!.account.sent).toEqual([{ transfer: { token: USDT_TRON, recipient: VENDOR, amount: 5_000_000n } }, { sendTransaction: { to: VENDOR, value: 7n } }]);
    const reverted = chain({ confirm: async () => 'REVERTED' });
    expect((await reverted.execute({ kind: 'transfer', chain: 'tron:nile', asset: 'native', amount: '1', destination: VENDOR })).outcome).toBe('REVERTED');
  });

  it('the second line governs both TRON write surfaces: nothing not in flight, and nothing else at all', async () => {
    const c = chain();
    const account = await c.account();
    await expect(account.transfer({ token: USDT_TRON, recipient: STRANGER, amount: 1n })).rejects.toMatchObject({ name: 'PolicyViolationError', code: 'GOVERNED_BUT_UNMATCHED' });
    await expect(account.sendTransaction({ to: VENDOR, value: 1n })).rejects.toMatchObject({ code: 'GOVERNED_BUT_UNMATCHED' });
    await expect((account as unknown as { approve: () => Promise<unknown> }).approve()).rejects.toMatchObject({ code: 'NO_APPLICABLE_RULE' });
    expect(FakeTronManager.last!.account.sent).toHaveLength(0);
  });

  it('a backend bug sending the wrong recipient meets the second line', async () => {
    const c = chain();
    const account = await c.account();
    const real = account.transfer.bind(account);
    // Simulate: the backend calls transfer with a different recipient than the record.
    (c as unknown as { inFlight: unknown }).inFlight = { kind: 'transfer', chain: 'tron:nile', asset: USDT_TRON, amount: '1', destination: VENDOR };
    await expect(real({ token: USDT_TRON, recipient: STRANGER, amount: 1n })).rejects.toMatchObject({ code: 'GOVERNED_BUT_UNMATCHED' });
    (c as unknown as { inFlight: unknown }).inFlight = null;
    expect(SecondLineRefusal).toBeDefined();
  });
});

describe('Signer on TRON — the gate: a new chain through nothing but a pack and a backend', () => {
  it('a matching TRC-20 call executes; a case-changed recipient and a wrong token are refused before the backend', async () => {
    const backend = chain();
    const signer = new Signer({ planePublicKeyPem, chains: [backend], now: NOW });
    const ok = await signer.execute({ authorization: issue({}), call: { token: USDT_TRON, recipient: VENDOR, amount: '5000000' } });
    expect(ok).toMatchObject({ ok: true, txHash: 'trc1', outcome: 'CONFIRMED' });
    expect(await signer.execute({ authorization: issue({}), call: { token: USDT_TRON, recipient: VENDOR.toLowerCase(), amount: '5000000' } })).toMatchObject({ ok: false, code: 'UNRECOGNISED_CALL' });
    expect(await signer.execute({ authorization: issue({}), call: { token: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', recipient: VENDOR, amount: '1' } })).toMatchObject({ ok: false, code: 'MISMATCH' });
    expect(await signer.execute({ authorization: issue({}), call: { token: USDT_TRON, recipient: STRANGER, amount: '1' } })).toMatchObject({ ok: false, code: 'MISMATCH' });
    expect(await signer.execute({ authorization: issue({ asset: 'native', maxAmount: '10' }), call: { to: VENDOR, value: '10' } })).toMatchObject({ ok: true, txHash: 'trx2' });
    expect(FakeTronManager.last!.account.sent).toHaveLength(2);
  });
});
