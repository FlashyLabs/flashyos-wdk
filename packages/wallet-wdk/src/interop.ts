// Phase 18 — the documents that cross an organization boundary.
//
// A payee that is not a FlashyOS org presents a SignedInvoice: what it wants,
// where, signed by a key it holds. A payer's plane pays it like any spend —
// the destination must be on the paying agent's allowlist, so the invoice's
// signature proves *who is asking*, and the envelope decides *whether*. When
// the chain answers, the plane signs a SignedReceipt with the same Ed25519
// key that signs every authorization, and anyone holding the plane's public
// key can verify it without asking FlashyOS anything.
//
// Canonical form: the signed fields only, keys sorted, no whitespace, `sig`
// omitted. Implemented once, here, and used by the plane (to sign receipts
// and verify invoices) and by counterparties (to sign invoices and verify
// receipts). Node's crypto only; nothing here needs a chain.

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'crypto';

export interface InvoicePayee {
  /** Who is asking, for the human reading the receipt. */
  name: string;
  /** Ed25519 public key, SPKI PEM. The invoice is verified against this key. */
  publicKey: string;
}

export interface SignedInvoicePayload {
  version: 1;
  /** The payee's own id for the invoice; unique under its key. */
  id: string;
  payee: InvoicePayee;
  /** `<family>:<chainId>`. */
  chain: string;
  /** Exact contract address, or "native". */
  asset: string;
  /** Base units, decimal string. */
  amount: string;
  /** The payee's receiving address on `chain`. */
  destination: string;
  memo: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedInvoice extends SignedInvoicePayload {
  /** base64url(ed25519(canonical payload)) under `payee.publicKey`. */
  sig: string;
}

export interface SignedReceiptPayload {
  version: 1;
  invoiceId: string;
  /** sha256 of the invoice's canonical bytes, hex: the receipt names exactly which invoice it settles. */
  invoiceHash: string;
  payer: { org: string; agentName: string; publicKey: string };
  payee: InvoicePayee;
  chain: string;
  asset: string;
  /** What was authorized and spent, base units. */
  amount: string;
  destination: string;
  txHash: string;
  outcome: 'CONFIRMED' | 'REVERTED';
  authorizationId: string;
  settledAt: string;
}

export interface SignedReceipt extends SignedReceiptPayload {
  /** base64url(ed25519(canonical payload)) under `payer.publicKey` — the plane's authorization key. */
  sig: string;
}

export const INVOICE_SIGNED_FIELDS = ['version', 'id', 'payee', 'chain', 'asset', 'amount', 'destination', 'memo', 'issuedAt', 'expiresAt'] as const;
export const RECEIPT_SIGNED_FIELDS = [
  'version', 'invoiceId', 'invoiceHash', 'payer', 'payee', 'chain', 'asset', 'amount', 'destination', 'txHash', 'outcome', 'authorizationId', 'settledAt',
] as const;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function canonical(fields: readonly string[], value: Record<string, unknown>): Buffer {
  const picked: Record<string, unknown> = {};
  for (const key of fields) picked[key] = value[key];
  return Buffer.from(JSON.stringify(sortKeys(picked)), 'utf8');
}

export const canonicalInvoice = (invoice: SignedInvoicePayload | SignedInvoice): Buffer => canonical(INVOICE_SIGNED_FIELDS, invoice as unknown as Record<string, unknown>);
export const canonicalReceipt = (receipt: SignedReceiptPayload | SignedReceipt): Buffer => canonical(RECEIPT_SIGNED_FIELDS, receipt as unknown as Record<string, unknown>);

/** sha256 of the canonical invoice, hex. Stable across re-serialization; changes if any signed field changes. */
export function invoiceHash(invoice: SignedInvoicePayload | SignedInvoice): string {
  return createHash('sha256').update(canonicalInvoice(invoice)).digest('hex');
}

const asKey = (pem: string | KeyObject, kind: 'public' | 'private'): KeyObject =>
  typeof pem === 'string' ? (kind === 'public' ? createPublicKey(pem) : createPrivateKey(pem)) : pem;

/** A payee signs its invoice with its own Ed25519 private key (PEM or KeyObject). */
export function signInvoice(payload: SignedInvoicePayload, privateKey: string | KeyObject): SignedInvoice {
  return { ...payload, sig: sign(null, canonicalInvoice(payload), asKey(privateKey, 'private')).toString('base64url') };
}

/** The plane signs a receipt with its authorization key. */
export function signReceipt(payload: SignedReceiptPayload, privateKey: string | KeyObject): SignedReceipt {
  return { ...payload, sig: sign(null, canonicalReceipt(payload), asKey(privateKey, 'private')).toString('base64url') };
}

export type InteropCheck =
  | { ok: true }
  | { ok: false; code: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'NOT_YET_VALID' | 'WRONG_KEY' };

const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
const CHAIN_RE = /^(evm|tron|ton|solana|btc):[A-Za-z0-9_-]+$/;
const isIso = (s: unknown): s is string => typeof s === 'string' && !Number.isNaN(Date.parse(s));

function shapeOfInvoice(v: unknown): v is SignedInvoice {
  const i = v as SignedInvoice;
  return (
    !!i && typeof i === 'object' && i.version === 1 && typeof i.id === 'string' && i.id.length > 0 &&
    !!i.payee && typeof i.payee.name === 'string' && typeof i.payee.publicKey === 'string' &&
    typeof i.chain === 'string' && CHAIN_RE.test(i.chain) && typeof i.asset === 'string' && i.asset.length > 0 &&
    typeof i.amount === 'string' && AMOUNT_RE.test(i.amount) && typeof i.destination === 'string' && i.destination.length > 0 &&
    typeof i.memo === 'string' && isIso(i.issuedAt) && isIso(i.expiresAt) && typeof i.sig === 'string' && i.sig.length > 0
  );
}

/**
 * Signature under the invoice's own key, plus its window. Never throws.
 * Verifying against the key *inside* the document proves only that the
 * holder of that key wrote it; whether that key may be paid is the paying
 * agent's allowlist's decision, not this function's.
 */
export function verifyInvoice(invoice: unknown, now: Date = new Date()): InteropCheck {
  if (!shapeOfInvoice(invoice)) return { ok: false, code: 'MALFORMED' };
  let valid = false;
  try {
    valid = verify(null, canonicalInvoice(invoice), createPublicKey(invoice.payee.publicKey), Buffer.from(invoice.sig, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: 'BAD_SIGNATURE' };
  const SKEW_MS = 30_000;
  if (now.getTime() + SKEW_MS < Date.parse(invoice.issuedAt)) return { ok: false, code: 'NOT_YET_VALID' };
  if (now.getTime() > Date.parse(invoice.expiresAt)) return { ok: false, code: 'EXPIRED' };
  return { ok: true };
}

function shapeOfReceipt(v: unknown): v is SignedReceipt {
  const r = v as SignedReceipt;
  return (
    !!r && typeof r === 'object' && r.version === 1 && typeof r.invoiceId === 'string' && /^[0-9a-f]{64}$/.test(r.invoiceHash ?? '') &&
    !!r.payer && typeof r.payer.org === 'string' && typeof r.payer.agentName === 'string' && typeof r.payer.publicKey === 'string' &&
    !!r.payee && typeof r.payee.name === 'string' && typeof r.payee.publicKey === 'string' &&
    typeof r.chain === 'string' && typeof r.asset === 'string' && typeof r.amount === 'string' && AMOUNT_RE.test(r.amount) &&
    typeof r.destination === 'string' && typeof r.txHash === 'string' && (r.outcome === 'CONFIRMED' || r.outcome === 'REVERTED') &&
    typeof r.authorizationId === 'string' && isIso(r.settledAt) && typeof r.sig === 'string'
  );
}

/**
 * A receipt verifies under the plane's public key. Pass the key you already
 * trust as `expectedPayerKey`; a receipt whose embedded key differs is
 * WRONG_KEY even if self-consistent — a document cannot vouch for itself.
 * With `invoice` given, the receipt must name that invoice's hash.
 */
export function verifyReceipt(
  receipt: unknown,
  options: { expectedPayerKey?: string; trustedKeys?: string[]; invoice?: SignedInvoice | SignedInvoicePayload } = {},
): InteropCheck {
  if (!shapeOfReceipt(receipt)) return { ok: false, code: 'MALFORMED' };
  if (options.expectedPayerKey !== undefined && normalizePem(options.expectedPayerKey) !== normalizePem(receipt.payer.publicKey)) return { ok: false, code: 'WRONG_KEY' };
  // A set of keys the verifier trusts — a registry of planes, a plane
  // document's keys. The embedded key must be one of them; retired keys
  // count, so a receipt outlives the rotation that followed it.
  if (options.trustedKeys !== undefined && !options.trustedKeys.some((k) => normalizePem(k) === normalizePem(receipt.payer.publicKey))) return { ok: false, code: 'WRONG_KEY' };
  if (options.invoice && invoiceHash(options.invoice) !== receipt.invoiceHash) return { ok: false, code: 'BAD_SIGNATURE' };
  try {
    const ok = verify(null, canonicalReceipt(receipt), createPublicKey(receipt.payer.publicKey), Buffer.from(receipt.sig, 'base64url'));
    return ok ? { ok: true } : { ok: false, code: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, code: 'BAD_SIGNATURE' };
  }
}

const normalizePem = (pem: string) => pem.replace(/\s+/g, '');

// ─── Plane identity (Phase 23) ───────────────────────────────────────────────

/** A key's id: sha256 of its SPKI DER, hex. The same key in any PEM formatting has one kid. */
export function keyFingerprint(publicKeyPem: string): string {
  return createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex');
}

export interface PlaneKey {
  kid: string;
  publicKey: string;
  /** active: signs today. retired: signed once; still verifies, never signs again. */
  status: 'active' | 'retired';
}

/** What a plane publishes at /.well-known/flashyos-plane.json. */
export interface PlaneDocument {
  version: 1;
  plane: { name: string; url: string | null };
  keys: PlaneKey[];
  /** `<family>:<chainId>` the plane's signer can reach. */
  chains: string[];
  /** The $id of every schema the plane enforces. */
  schemas: string[];
  generatedAt: string;
}

export type PlaneDocumentCheck = { ok: true; keys: PlaneKey[] } | { ok: false; code: 'MALFORMED' | 'BAD_KID'; detail: string };

/** Shape, and every kid is the fingerprint of the key beside it — a document cannot name a key it does not carry. */
export function verifyPlaneDocument(doc: unknown): PlaneDocumentCheck {
  const d = doc as PlaneDocument;
  if (!d || typeof d !== 'object' || d.version !== 1 || !d.plane || typeof d.plane.name !== 'string' || !Array.isArray(d.keys) || d.keys.length === 0) {
    return { ok: false, code: 'MALFORMED', detail: 'a plane document needs version 1, a plane name and at least one key' };
  }
  for (const k of d.keys) {
    if (!k || typeof k.kid !== 'string' || typeof k.publicKey !== 'string' || (k.status !== 'active' && k.status !== 'retired')) {
      return { ok: false, code: 'MALFORMED', detail: 'each key needs kid, publicKey and status' };
    }
    let kid: string;
    try {
      kid = keyFingerprint(k.publicKey);
    } catch (err) {
      return { ok: false, code: 'MALFORMED', detail: `key ${k.kid}: ${(err as Error).message}` };
    }
    if (kid !== k.kid) return { ok: false, code: 'BAD_KID', detail: `key ${k.kid} is not the fingerprint of the key it carries (${kid})` };
  }
  if (!d.keys.some((k) => k.status === 'active')) return { ok: false, code: 'MALFORMED', detail: 'a plane document needs an active key' };
  return { ok: true, keys: d.keys };
}
