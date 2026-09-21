import { describe, it, expect } from 'vitest';
import { PolicyAdapterError, defaultAdapterRegistry } from '../transactionPolicy';

// The AdapterRegistry packs, by method: the PR #88-shaped surface over the
// same extractors the signer uses.

const USDT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0x4200000000000000000000000000000000000006';
const VENDOR = '0x7f3c000000000000000000000000000000000001';
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_VENDOR = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9';

describe('default adapter registry', () => {
  const registry = defaultAdapterRegistry();
  const evm = (method: string, arg: unknown) => registry.toOperationRecord({ walletType: 'evm', method, args: [arg], chain: 'evm:8453' });
  const tron = (method: string, arg: unknown) => registry.toOperationRecord({ walletType: 'tron', method, args: [arg], chain: 'tron:mainnet' });

  it('evm: sendTransaction, transfer, swap, bridge', () => {
    expect(evm('transfer', { token: USDT, recipient: VENDOR, amount: 25_000_000n })).toMatchObject({ kind: 'transfer', asset: USDT, amount: '25000000', destination: VENDOR });
    expect(evm('swap', { tokenIn: USDT, tokenOut: WETH, tokenInAmount: '10' })).toMatchObject({ kind: 'swap', asset: USDT, amount: '10', destination: null });
    expect(evm('bridge', { targetChain: 'tron:mainnet', recipient: TRON_VENDOR, token: USDT, amount: 3 })).toMatchObject({ kind: 'bridge', destination: `tron:mainnet:${TRON_VENDOR}` });
    expect(evm('sendTransaction', { to: VENDOR, value: '1' })).toMatchObject({ kind: 'transfer', asset: 'native' });
    expect(evm('swap', { tokenIn: USDT, tokenOut: WETH, tokenInAmount: '10' }).raw).toMatchObject({ walletType: 'evm', method: 'swap' });
  });

  it('tron: sendTransaction and transfer', () => {
    expect(tron('sendTransaction', { to: TRON_VENDOR, value: 1_000_000 })).toMatchObject({ kind: 'transfer', chain: 'tron:mainnet', asset: 'native', destination: TRON_VENDOR });
    expect(tron('transfer', { token: USDT_TRON, recipient: TRON_VENDOR, amount: '5' })).toMatchObject({ kind: 'transfer', asset: USDT_TRON, amount: '5' });
  });

  it('fails closed for a method no pack knows, or one whose arguments do not re-derive', () => {
    expect(() => evm('approve', { spender: VENDOR, amount: 1 })).toThrow(PolicyAdapterError);
    expect(() => evm('transfer', { token: 'USDT', recipient: VENDOR, amount: 1 })).toThrow(PolicyAdapterError);
    expect(() => evm('swap', { tokenIn: USDT, tokenOut: WETH, tokenOutAmount: 1 })).toThrow(PolicyAdapterError);
    expect(() => tron('swap', {})).toThrow(PolicyAdapterError);
    expect(() => registry.toOperationRecord({ walletType: 'solana', method: 'sendTransaction', args: [{}], chain: 'solana:mainnet' })).toThrow(/no extractor/);
  });
});
