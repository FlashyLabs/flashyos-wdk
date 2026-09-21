import { describe, it, expect } from 'vitest';
import { extractTronOperation } from './tron';
import { isAddress, normalizeAddress, sameDestination } from './address';

const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const VENDOR = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9';

describe('extractTronOperation', () => {
  it('a TRX transfer is { to, value }', () => {
    expect(extractTronOperation('mainnet', { to: VENDOR, value: 1_000_000 })).toEqual({ kind: 'transfer', chain: 'tron:mainnet', asset: 'native', amount: '1000000', destination: VENDOR });
  });

  it('a TRC-20 transfer is { token, recipient, amount }', () => {
    expect(extractTronOperation('nile', { token: USDT_TRON, recipient: VENDOR, amount: '25000000' })).toEqual({ kind: 'transfer', chain: 'tron:nile', asset: USDT_TRON, amount: '25000000', destination: VENDOR });
  });

  it('refuses anything else: bad addresses, bad amounts, unknown shapes', () => {
    expect(extractTronOperation('mainnet', { to: VENDOR.toLowerCase(), value: 1 })).toBeNull();
    expect(extractTronOperation('mainnet', { to: '0x7f3c000000000000000000000000000000000001', value: 1 })).toBeNull();
    expect(extractTronOperation('mainnet', { to: VENDOR, value: -1 })).toBeNull();
    expect(extractTronOperation('mainnet', { to: VENDOR, value: '1.5' })).toBeNull();
    expect(extractTronOperation('mainnet', { token: 'USDT', recipient: VENDOR, amount: 1 })).toBeNull();
    expect(extractTronOperation('mainnet', { token: USDT_TRON, recipient: 'vendor', amount: 1 })).toBeNull();
    expect(extractTronOperation('mainnet', {} as never)).toBeNull();
    expect(extractTronOperation('', { to: VENDOR, value: 1 })).toBeNull();
  });
});

describe('address rules', () => {
  it('EVM folds case; TRON never does', () => {
    expect(isAddress('evm', '0x7f3C000000000000000000000000000000000001')).toBe(true);
    expect(normalizeAddress('evm', '0x7f3C000000000000000000000000000000000001')).toBe('0x7f3c000000000000000000000000000000000001');
    expect(isAddress('tron', VENDOR)).toBe(true);
    expect(isAddress('tron', VENDOR.toLowerCase())).toBe(false);
    expect(isAddress('tron', 'T' + '0'.repeat(33))).toBe(false); // 0 is not base58
    expect(normalizeAddress('tron', VENDOR)).toBe(VENDOR);
    expect(isAddress('solana', 'anything')).toBe(false);
  });

  it('sameDestination never equates two different TRON addresses by case', () => {
    expect(sameDestination('tron:mainnet', VENDOR, VENDOR)).toBe(true);
    expect(sameDestination('tron:mainnet', VENDOR, VENDOR.toLowerCase())).toBe(false);
    expect(sameDestination('evm:8453', null, null)).toBe(true);
    expect(sameDestination('evm:8453', null, VENDOR)).toBe(false);
  });
});
