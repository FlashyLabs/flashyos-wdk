import { describe, it, expect } from 'vitest';
import { extractBridge, extractSwap, isProtocolCall } from './protocols';
import { extractOperation } from './index';
import { recordWithinAuthorization } from './evm';

const USDT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0x4200000000000000000000000000000000000006';
const VENDOR = '0x7f3c000000000000000000000000000000000001';
const TRON_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

describe('extractSwap', () => {
  it('a sell-side swap is "spend up to tokenInAmount of tokenIn", internal by default', () => {
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: USDT.toUpperCase().replace('0X', '0x'), tokenOut: WETH, tokenInAmount: 500_000_000n } })).toEqual({
      kind: 'swap', chain: 'evm:8453', asset: USDT, amount: '500000000', destination: null,
    });
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: 'native', tokenOut: USDT, tokenInAmount: '1000' } })?.asset).toBe('native');
  });

  it('a swap that delivers tokenOut elsewhere carries that address, so the envelope allowlist applies', () => {
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: 1, to: VENDOR.toUpperCase().replace('0X', '0x') } })?.destination).toBe(VENDOR);
  });

  it('refuses the buy side, bad amounts, bad tokens and bad recipients', () => {
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenOutAmount: 1n } })).toBeNull();
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: -1 } })).toBeNull();
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: 1.5 } })).toBeNull();
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH } })).toBeNull();
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: 'USDT', tokenOut: WETH, tokenInAmount: 1 } })).toBeNull();
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: 'WETH', tokenInAmount: 1 } })).toBeNull();
    expect(extractSwap('evm:8453', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: 1, to: 'vendor' } })).toBeNull();
    expect(extractSwap('solana:mainnet', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: 1 } })).toBeNull();
  });
});

describe('extractBridge', () => {
  it('binds the target chain and the recipient into the destination', () => {
    expect(extractBridge('evm:8453', { protocol: 'bridge', options: { targetChain: 'evm:42161', recipient: VENDOR.toUpperCase().replace('0X', '0x'), token: USDT, amount: '25000000' } })).toEqual({
      kind: 'bridge', chain: 'evm:8453', asset: USDT, amount: '25000000', destination: `evm:42161:${VENDOR}`,
    });
    // To TRON: the recipient keeps its case.
    expect(extractBridge('evm:8453', { protocol: 'bridge', options: { targetChain: 'tron:mainnet', recipient: TRON_ADDR, token: USDT, amount: 1n } })?.destination).toBe(`tron:mainnet:${TRON_ADDR}`);
  });

  it('refuses a bridge to the same chain, to an unknown family, or with a recipient wrong for the target', () => {
    const base = { token: USDT, amount: 1 };
    expect(extractBridge('evm:8453', { protocol: 'bridge', options: { ...base, targetChain: 'evm:8453', recipient: VENDOR } })).toBeNull();
    expect(extractBridge('evm:8453', { protocol: 'bridge', options: { ...base, targetChain: 'solana:mainnet', recipient: VENDOR } })).toBeNull();
    expect(extractBridge('evm:8453', { protocol: 'bridge', options: { ...base, targetChain: 'tron:mainnet', recipient: VENDOR } })).toBeNull();
    expect(extractBridge('evm:8453', { protocol: 'bridge', options: { ...base, targetChain: 'evm:42161', recipient: TRON_ADDR } })).toBeNull();
    expect(extractBridge('evm:8453', { protocol: 'bridge', options: { ...base, targetChain: 'arbitrum', recipient: VENDOR } })).toBeNull();
  });
});

describe('extractOperation dispatch', () => {
  it('routes by shape and family, and refuses what it cannot vouch for', () => {
    expect(isProtocolCall({ protocol: 'swap', options: {} })).toBe(true);
    expect(isProtocolCall({ to: VENDOR })).toBe(false);
    expect(extractOperation('evm:8453', { to: VENDOR, value: '5' })).toMatchObject({ kind: 'transfer', asset: 'native', amount: '5' });
    expect(extractOperation('tron:mainnet', { to: TRON_ADDR, value: 5 })).toMatchObject({ kind: 'transfer', chain: 'tron:mainnet', destination: TRON_ADDR });
    expect(extractOperation('evm:8453', { protocol: 'swap', options: { tokenIn: USDT, tokenOut: WETH, tokenInAmount: 1 } })).toMatchObject({ kind: 'swap' });
    expect(extractOperation('evm:8453', { protocol: 'bridge', options: { targetChain: 'tron:mainnet', recipient: TRON_ADDR, token: USDT, amount: 1 } })).toMatchObject({ kind: 'bridge' });
    expect(extractOperation('solana:mainnet', { to: 'x', value: 1 })).toBeNull();
    expect(extractOperation('evm:8453', null)).toBeNull();
    expect(extractOperation('evm:8453', 'transfer')).toBeNull();
    expect(extractOperation('evm', { to: VENDOR })).toBeNull();
  });
});

describe('recordWithinAuthorization across kinds and families', () => {
  it('a swap matches only the same tokenIn, within the ceiling, with the same destination', () => {
    const auth = { chain: 'evm:8453', kind: 'swap', asset: USDT, destination: null, maxAmount: '1000' };
    expect(recordWithinAuthorization({ kind: 'swap', chain: 'evm:8453', asset: USDT, amount: '1000', destination: null }, auth)).toBe(true);
    expect(recordWithinAuthorization({ kind: 'swap', chain: 'evm:8453', asset: USDT, amount: '1001', destination: null }, auth)).toBe(false);
    expect(recordWithinAuthorization({ kind: 'swap', chain: 'evm:8453', asset: WETH, amount: '1', destination: null }, auth)).toBe(false);
    expect(recordWithinAuthorization({ kind: 'swap', chain: 'evm:8453', asset: USDT, amount: '1', destination: VENDOR }, auth)).toBe(false);
    expect(recordWithinAuthorization({ kind: 'transfer', chain: 'evm:8453', asset: USDT, amount: '1', destination: null }, auth)).toBe(false);
  });

  it('a bridge matches target chain exactly and the recipient by the target\'s rule', () => {
    const toTron = { chain: 'evm:8453', kind: 'bridge', asset: USDT, destination: `tron:mainnet:${TRON_ADDR}`, maxAmount: '10' };
    expect(recordWithinAuthorization({ kind: 'bridge', chain: 'evm:8453', asset: USDT, amount: '10', destination: `tron:mainnet:${TRON_ADDR}` }, toTron)).toBe(true);
    expect(recordWithinAuthorization({ kind: 'bridge', chain: 'evm:8453', asset: USDT, amount: '10', destination: `tron:mainnet:${TRON_ADDR.toLowerCase()}` }, toTron)).toBe(false);
    expect(recordWithinAuthorization({ kind: 'bridge', chain: 'evm:8453', asset: USDT, amount: '10', destination: `tron:nile:${TRON_ADDR}` }, toTron)).toBe(false);
    const toArb = { ...toTron, destination: `evm:42161:${VENDOR}` };
    expect(recordWithinAuthorization({ kind: 'bridge', chain: 'evm:8453', asset: USDT, amount: '1', destination: `evm:42161:${VENDOR.toUpperCase().replace('0X', '0x')}` }, toArb)).toBe(true);
  });

  it('TRON addresses compare exactly; EVM addresses compare case-insensitively', () => {
    const tron = { chain: 'tron:mainnet', kind: 'transfer', asset: 'native', destination: TRON_ADDR, maxAmount: '1' };
    expect(recordWithinAuthorization({ kind: 'transfer', chain: 'tron:mainnet', asset: 'native', amount: '1', destination: TRON_ADDR }, tron)).toBe(true);
    expect(recordWithinAuthorization({ kind: 'transfer', chain: 'tron:mainnet', asset: 'native', amount: '1', destination: TRON_ADDR.toLowerCase() }, tron)).toBe(false);
    const evm = { chain: 'evm:8453', kind: 'transfer', asset: USDT, destination: VENDOR, maxAmount: '1' };
    expect(recordWithinAuthorization({ kind: 'transfer', chain: 'evm:8453', asset: USDT.toUpperCase().replace('0X', '0x'), amount: '1', destination: VENDOR.toUpperCase().replace('0X', '0x') }, evm)).toBe(true);
  });
});
