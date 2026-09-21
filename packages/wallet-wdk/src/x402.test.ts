import { describe, it, expect } from 'vitest';
import { eip3009TypedData, extractEip3009Operation, parseX402Challenge, x402PaymentHeader, x402Record, X402Refused } from './x402';
import { recordWithinAuthorization } from './extractors/evm';

const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO = '0x7F3C000000000000000000000000000000000009';
const accept = { scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '10000', resource: 'https://api.example/report', payTo: PAY_TO, maxTimeoutSeconds: 60, asset: USDC_BASE_SEPOLIA, extra: { name: 'USDC', version: '2' } };
const challenge = { x402Version: 1, error: 'payment required', accepts: [accept] };

describe('parseX402Challenge', () => {
  it('reads a JSON body, a JSON string, and a base64 header', () => {
    expect(parseX402Challenge({ body: challenge }).accepts[0].payTo).toBe(PAY_TO);
    expect(parseX402Challenge({ body: JSON.stringify(challenge) }).accepts).toHaveLength(1);
    expect(parseX402Challenge({ header: Buffer.from(JSON.stringify(challenge)).toString('base64') }).x402Version).toBe(1);
  });
  it('refuses a malformed challenge with a code', () => {
    expect(() => parseX402Challenge({ body: { x402Version: 1, accepts: [] } })).toThrow(X402Refused);
    expect(() => parseX402Challenge({ header: '%%%' })).toThrow(/base64/);
    expect(() => parseX402Challenge({ body: { x402Version: 1, accepts: [{ scheme: 'exact' }] } })).toThrow(/each accepts entry/);
  });
});

describe('x402Record', () => {
  it('turns the first acceptable option into a bounded transfer on the testnet', () => {
    const { record } = x402Record(challenge);
    expect(record).toEqual({
      kind: 'transfer', chain: 'evm:84532', asset: USDC_BASE_SEPOLIA.toLowerCase(), amount: '10000', destination: PAY_TO.toLowerCase(),
      raw: { via: 'x402', scheme: 'exact', network: 'base-sepolia', resource: 'https://api.example/report' },
    });
  });
  it('refuses a mainnet network with MAINNET_NOT_ENABLED and an unknown one with UNKNOWN_NETWORK', () => {
    expect(() => x402Record({ ...challenge, accepts: [{ ...accept, network: 'base' }] })).toThrow(expect.objectContaining({ code: 'MAINNET_NOT_ENABLED' }));
    expect(() => x402Record({ ...challenge, accepts: [{ ...accept, network: 'moonbase' }] })).toThrow(expect.objectContaining({ code: 'UNKNOWN_NETWORK' }));
  });
  it('skips options it cannot take and picks the first it can', () => {
    const { accept: chosen } = x402Record({ ...challenge, accepts: [{ ...accept, network: 'base' }, { ...accept, scheme: 'upto' }, accept] });
    expect(chosen).toBe(accept);
  });
  it('refuses bad addresses and non-integer amounts', () => {
    expect(() => x402Record({ ...challenge, accepts: [{ ...accept, payTo: 'bob' }] })).toThrow(expect.objectContaining({ code: 'BAD_ADDRESS' }));
    expect(() => x402Record({ ...challenge, accepts: [{ ...accept, maxAmountRequired: '1.5' }] })).toThrow(expect.objectContaining({ code: 'BAD_AMOUNT' }));
  });
});

describe('EIP-3009 typed data', () => {
  const from = '0x1111111111111111111111111111111111111111';
  const nonce = '0x' + 'ab'.repeat(32);
  const now = new Date('2026-09-20T10:00:00Z');

  it('builds the domain from the network and asset and the message from the challenge', () => {
    const t = eip3009TypedData(accept, from, { nonce, now });
    expect(t.domain).toEqual({ name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA });
    expect(t.message).toEqual({ from, to: PAY_TO, value: '10000', validAfter: '0', validBefore: String(Math.floor(now.getTime() / 1000) + 60), nonce });
    expect(t.primaryType).toBe('TransferWithAuthorization');
  });

  it('re-derives to the same record the challenge produced, and within an authorization for it', () => {
    const { record } = x402Record(challenge);
    const t = eip3009TypedData(accept, from, { nonce, now });
    const derived = extractEip3009Operation('evm:84532', t)!;
    expect(derived.kind).toBe('transfer');
    expect(derived.asset).toBe(record.asset);
    expect(derived.amount).toBe(record.amount);
    expect(derived.destination).toBe(record.destination);
    expect(derived.raw).toEqual({ via: 'eip-3009', from, nonce, validBefore: t.message.validBefore });
    const authorization = { chain: 'evm:84532', kind: 'transfer', asset: record.asset, maxAmount: '10000', destination: record.destination } as Parameters<typeof recordWithinAuthorization>[1];
    expect(recordWithinAuthorization(derived, authorization)).toBe(true);
    expect(recordWithinAuthorization({ ...derived, amount: '10001' }, authorization)).toBe(false);
  });

  it('returns null for a chain mismatch, a different primary type, or altered field types', () => {
    const t = eip3009TypedData(accept, from, { nonce, now });
    expect(extractEip3009Operation('evm:11155111', t)).toBeNull();
    expect(extractEip3009Operation('evm:84532', { ...t, primaryType: 'Permit' })).toBeNull();
    expect(extractEip3009Operation('evm:84532', { ...t, types: { TransferWithAuthorization: [...t.types.TransferWithAuthorization.slice(0, 5), { name: 'nonce', type: 'uint256' }] } })).toBeNull();
    expect(extractEip3009Operation('evm:84532', { ...t, message: { ...t.message, value: '1e3' } })).toBeNull();
  });

  it('refuses to build typed data for a mainnet or a malformed nonce', () => {
    expect(() => eip3009TypedData({ ...accept, network: 'base' }, from, { nonce, now })).toThrow(expect.objectContaining({ code: 'MAINNET_NOT_ENABLED' }));
    expect(() => eip3009TypedData(accept, from, { nonce: '0x12', now })).toThrow(expect.objectContaining({ code: 'MALFORMED' }));
  });

  it('encodes the X-PAYMENT header as base64 JSON carrying the signature and the signed message', () => {
    const t = eip3009TypedData(accept, from, { nonce, now });
    const header = x402PaymentHeader(accept, t, '0xsig');
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded).toEqual({ x402Version: 1, scheme: 'exact', network: 'base-sepolia', payload: { signature: '0xsig', authorization: t.message } });
  });
});

describe('the server side (Phase 25)', () => {
  it('builds a challenge on a listed testnet from a registered address and refuses a mainnet or unknown chain', async () => {
    const { buildX402Challenge, networkForChain, parseX402Payment, x402PaymentRecord } = await import('./x402');
    expect(networkForChain('evm:84532')).toBe('base-sepolia');
    expect(networkForChain('evm:8453')).toBe('base');
    expect(networkForChain('evm:421614')).toBeNull();
    const c = buildX402Challenge({ chain: 'evm:84532', payTo: PAY_TO, asset: USDC_BASE_SEPOLIA, maxAmountRequired: '5000', resource: 'https://api.acme/report' });
    expect(c).toMatchObject({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base-sepolia', payTo: PAY_TO, maxAmountRequired: '5000', resource: 'https://api.acme/report', maxTimeoutSeconds: 60 }] });
    // The buyer's side accepts what the seller's side built.
    expect(x402Record(c).record).toMatchObject({ kind: 'transfer', chain: 'evm:84532', amount: '5000', destination: PAY_TO.toLowerCase() });
    expect(() => buildX402Challenge({ chain: 'evm:8453', payTo: PAY_TO, asset: USDC_BASE_SEPOLIA, maxAmountRequired: '1', resource: 'r' })).toThrow(expect.objectContaining({ code: 'MAINNET_NOT_ENABLED' }));
    expect(() => buildX402Challenge({ chain: 'evm:421614', payTo: PAY_TO, asset: USDC_BASE_SEPOLIA, maxAmountRequired: '1', resource: 'r' })).toThrow(expect.objectContaining({ code: 'UNKNOWN_NETWORK' }));
    expect(() => buildX402Challenge({ chain: 'evm:84532', payTo: 'bob', asset: USDC_BASE_SEPOLIA, maxAmountRequired: '1', resource: 'r' })).toThrow(expect.objectContaining({ code: 'BAD_ADDRESS' }));

    // A payment header round-trips into the record the seller's plane files.
    const t = eip3009TypedData(c.accepts[0], '0x1111111111111111111111111111111111111111', { nonce: '0x' + 'ab'.repeat(32), now: new Date('2026-09-21T10:00:00Z') });
    const header = x402PaymentHeader(c.accepts[0], t, '0xsig');
    const payment = parseX402Payment(header);
    expect(payment.payload.authorization).toEqual(t.message);
    expect(x402PaymentRecord(payment, USDC_BASE_SEPOLIA)).toMatchObject({ kind: 'transfer', chain: 'evm:84532', amount: '5000', destination: PAY_TO.toLowerCase(), raw: { via: 'x402', nonce: '0x' + 'ab'.repeat(32) } });
    expect(() => parseX402Payment('%%%')).toThrow(expect.objectContaining({ code: 'MALFORMED' }));
    expect(() => parseX402Payment(Buffer.from(JSON.stringify({ ...payment, payload: { ...payment.payload, authorization: { ...t.message, value: '1.5' } } })).toString('base64'))).toThrow(expect.objectContaining({ code: 'BAD_AMOUNT' }));
    expect(() => x402PaymentRecord({ ...payment, network: 'base' }, USDC_BASE_SEPOLIA)).toThrow(expect.objectContaining({ code: 'MAINNET_NOT_ENABLED' }));
  });
});
