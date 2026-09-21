import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { invoiceHash, signInvoice, signReceipt, verifyInvoice, verifyReceipt, type SignedInvoicePayload, type SignedReceiptPayload } from './interop';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pub: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
};
const payee = pair();
const plane = pair();
const NOW = new Date('2026-09-20T10:00:00.000Z');

const invoicePayload: SignedInvoicePayload = {
  version: 1,
  id: 'inv-2026-0042',
  payee: { name: 'Northwind Data Co.', publicKey: payee.pub },
  chain: 'evm:84532',
  asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  amount: '2500000',
  destination: '0x7f3c000000000000000000000000000000000009',
  memo: 'September dataset licence',
  issuedAt: '2026-09-20T09:00:00.000Z',
  expiresAt: '2026-09-27T09:00:00.000Z',
};

describe('SignedInvoice', () => {
  it('verifies under the key it carries, and not after any signed field changes', () => {
    const invoice = signInvoice(invoicePayload, payee.priv);
    expect(verifyInvoice(invoice, NOW)).toEqual({ ok: true });
    expect(verifyInvoice({ ...invoice, amount: '2500001' }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyInvoice({ ...invoice, destination: '0x7f3c000000000000000000000000000000000001' }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyInvoice({ ...invoice, payee: { ...invoice.payee, publicKey: plane.pub } }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });

  it('is the same document whatever the key order, and a different hash for a different amount', () => {
    const invoice = signInvoice(invoicePayload, payee.priv);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(invoice).reverse())));
    expect(verifyInvoice(reordered, NOW)).toEqual({ ok: true });
    expect(invoiceHash(reordered)).toBe(invoiceHash(invoice));
    expect(invoiceHash({ ...invoicePayload, amount: '1' })).not.toBe(invoiceHash(invoicePayload));
  });

  it('refuses an expired, a not-yet-valid, and a malformed invoice, without throwing', () => {
    const invoice = signInvoice(invoicePayload, payee.priv);
    expect(verifyInvoice(invoice, new Date('2026-10-01T00:00:00Z'))).toEqual({ ok: false, code: 'EXPIRED' });
    expect(verifyInvoice(invoice, new Date('2026-09-20T08:00:00Z'))).toEqual({ ok: false, code: 'NOT_YET_VALID' });
    expect(verifyInvoice({ ...invoice, amount: '1.5' }, NOW)).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyInvoice(null, NOW)).toEqual({ ok: false, code: 'MALFORMED' });
    expect(verifyInvoice({ ...invoice, sig: '!!!' }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyInvoice({ ...invoice, payee: { name: 'x', publicKey: 'not a pem' } }, NOW)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
  });
});

describe('SignedReceipt', () => {
  const invoice = signInvoice(invoicePayload, payee.priv);
  const receiptPayload: SignedReceiptPayload = {
    version: 1,
    invoiceId: invoice.id,
    invoiceHash: invoiceHash(invoice),
    payer: { org: 'acme', agentName: 'procurement', publicKey: plane.pub },
    payee: invoice.payee,
    chain: invoice.chain,
    asset: invoice.asset,
    amount: invoice.amount,
    destination: invoice.destination,
    txHash: '0xabc',
    outcome: 'CONFIRMED',
    authorizationId: 'auth-1',
    settledAt: '2026-09-20T10:05:00.000Z',
  };

  it('verifies under the plane key the verifier already trusts', () => {
    const receipt = signReceipt(receiptPayload, plane.priv);
    expect(verifyReceipt(receipt, { expectedPayerKey: plane.pub, invoice })).toEqual({ ok: true });
    expect(verifyReceipt(receipt)).toEqual({ ok: true });
  });

  it('is WRONG_KEY when the embedded key is not the expected one, even if self-consistent', () => {
    const impostor = pair();
    const forged = signReceipt({ ...receiptPayload, payer: { ...receiptPayload.payer, publicKey: impostor.pub } }, impostor.priv);
    expect(verifyReceipt(forged)).toEqual({ ok: true });
    expect(verifyReceipt(forged, { expectedPayerKey: plane.pub })).toEqual({ ok: false, code: 'WRONG_KEY' });
  });

  it('fails when the receipt names a different invoice or a field is altered', () => {
    const receipt = signReceipt(receiptPayload, plane.priv);
    expect(verifyReceipt(receipt, { invoice: { ...invoicePayload, amount: '9' } })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyReceipt({ ...receipt, txHash: '0xdef' })).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifyReceipt({ ...receipt, outcome: 'MAYBE' })).toEqual({ ok: false, code: 'MALFORMED' });
  });
});

describe('plane identity (Phase 23)', () => {
  it('a kid is the fingerprint of the key whatever the PEM whitespace, and a receipt verifies under a trusted set including retired keys', async () => {
    const { keyFingerprint, verifyPlaneDocument } = await import('./interop');
    const retired = pair();
    expect(keyFingerprint(plane.pub)).toBe(keyFingerprint(plane.pub.replace(/\n/g, '\r\n')));
    expect(keyFingerprint(plane.pub)).not.toBe(keyFingerprint(retired.pub));
    const invoice = signInvoice(invoicePayload, payee.priv);
    const base: SignedReceiptPayload = {
      version: 1, invoiceId: invoice.id, invoiceHash: invoiceHash(invoice), payer: { org: 'acme', agentName: 'ops', publicKey: retired.pub }, payee: invoice.payee,
      chain: invoice.chain, asset: invoice.asset, amount: invoice.amount, destination: invoice.destination, txHash: '0x1', outcome: 'CONFIRMED', authorizationId: 'a', settledAt: '2026-09-21T10:00:00.000Z',
    };
    const receipt = signReceipt(base, retired.priv);
    expect(verifyReceipt(receipt, { trustedKeys: [plane.pub, retired.pub] })).toEqual({ ok: true });
    expect(verifyReceipt(receipt, { trustedKeys: [plane.pub] })).toEqual({ ok: false, code: 'WRONG_KEY' });
    expect(verifyReceipt(receipt, { trustedKeys: [] })).toEqual({ ok: false, code: 'WRONG_KEY' });
    const doc = { version: 1, plane: { name: 'acme-plane', url: null }, keys: [{ kid: keyFingerprint(plane.pub), publicKey: plane.pub, status: 'active' }, { kid: keyFingerprint(retired.pub), publicKey: retired.pub, status: 'retired' }], chains: [], schemas: [], generatedAt: 'now' };
    expect(verifyPlaneDocument(doc)).toMatchObject({ ok: true });
    expect(verifyPlaneDocument({ ...doc, keys: [{ ...doc.keys[0], kid: 'ab'.repeat(32) }] })).toMatchObject({ ok: false, code: 'BAD_KID' });
    expect(verifyPlaneDocument({ ...doc, keys: [doc.keys[1]] })).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyPlaneDocument(null)).toMatchObject({ ok: false, code: 'MALFORMED' });
  });
});
