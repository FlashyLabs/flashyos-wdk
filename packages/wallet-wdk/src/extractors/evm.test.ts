import { describe, it, expect } from 'vitest';
import { extractEvmOperation, recordWithinAuthorization } from './evm';

const USDT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const VENDOR = '0x7f3c000000000000000000000000000000000001';

// transfer(0x7f3c…0001, 25_000_000)
const TRANSFER_DATA =
  '0xa9059cbb' +
  '0000000000000000000000007f3c000000000000000000000000000000000001' +
  '00000000000000000000000000000000000000000000000000000000017d7840';

describe('extractEvmOperation', () => {
  it('reads a native transfer from a value with empty data', () => {
    expect(extractEvmOperation(8453, { to: VENDOR, value: '1000' })).toEqual({
      kind: 'transfer',
      chain: 'evm:8453',
      asset: 'native',
      amount: '1000',
      destination: VENDOR,
    });
    expect(extractEvmOperation(8453, { to: VENDOR, value: 5n, data: '0x' })?.amount).toBe('5');
  });

  it('decodes an ERC-20 transfer: the token is the asset, the recipient is the destination', () => {
    expect(extractEvmOperation('8453', { to: USDT, data: TRANSFER_DATA })).toEqual({
      kind: 'transfer',
      chain: 'evm:8453',
      asset: USDT,
      amount: '25000000',
      destination: VENDOR,
    });
  });

  it('lowercases addresses so the plane compares byte-exact', () => {
    const record = extractEvmOperation(8453, { to: USDT.toUpperCase().replace('0X', '0x'), data: TRANSFER_DATA });
    expect(record?.asset).toBe(USDT);
  });

  it.each([
    ['a non-address recipient', { to: 'vendor', value: '1' }],
    ['a negative value', { to: VENDOR, value: '-1' }],
    ['an unparseable value', { to: VENDOR, value: 'lots' }],
    ['an ERC-20 transfer that also sends value', { to: USDT, value: '1', data: TRANSFER_DATA }],
    ['truncated calldata', { to: USDT, data: TRANSFER_DATA.slice(0, -2) }],
    ['a recipient word with non-zero padding', { to: USDT, data: TRANSFER_DATA.replace('0000000000000000000000007f3c', '0100000000000000000000007f3c') }],
    ['approve()', { to: USDT, data: '0x095ea7b3' + '0'.repeat(128) }],
    ['transferFrom()', { to: USDT, data: '0x23b872dd' + '0'.repeat(192) }],
    ['arbitrary calldata', { to: USDT, data: '0xdeadbeef' }],
  ])('refuses %s by returning null', (_label, call) => {
    expect(extractEvmOperation(8453, call)).toBeNull();
  });
});

describe('recordWithinAuthorization', () => {
  const auth = { chain: 'evm:8453', kind: 'transfer', asset: USDT, destination: VENDOR, maxAmount: '25000000' };
  const record = extractEvmOperation(8453, { to: USDT, data: TRANSFER_DATA })!;

  it('accepts the exact authorized operation and any smaller amount', () => {
    expect(recordWithinAuthorization(record, auth)).toBe(true);
    expect(recordWithinAuthorization({ ...record, amount: '1' }, auth)).toBe(true);
  });

  it.each([
    ['a larger amount', { amount: '25000001' }],
    ['a different destination', { destination: '0x7f3c000000000000000000000000000000000099' }],
    ['a different asset', { asset: 'native' }],
    ['a different chain', { chain: 'evm:1' }],
    ['a different kind', { kind: 'bridge' as const }],
  ])('refuses %s', (_label, patch) => {
    expect(recordWithinAuthorization({ ...record, ...patch }, auth)).toBe(false);
  });
});
