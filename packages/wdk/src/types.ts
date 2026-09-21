// Wire shapes. Every view here is exactly what the FlashyOS API returns as
// JSON — dates are ISO strings, amounts are base-unit decimal strings — so
// the HTTP transport passes them through and the in-process transport
// serializes to them. The object never sees a Date.

import type { AuthorizationView, OperationKind, OperationRecord, SignedSpendAuthorization, SignerCall, Verdict } from '@flashyos/wallet-wdk';

export type { AuthorizationView, OperationKind, OperationRecord, SignedSpendAuthorization, SignerCall, Verdict };

export type Scope = 'memory:read' | 'memory:capture' | 'wallet:read' | 'wallet:propose' | 'wallet:settle' | 'wallet:delegate';
export type EscalationImpact = 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type DecisionImpact = 'LOW' | EscalationImpact;
export type DecisionStatus = 'AUTO_APPROVED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface AgentIdentity {
  orgId: string;
  agentName: string;
  scopes: Scope[];
}

export interface SpendEnvelopeInput {
  chain: string;
  kinds: OperationKind[];
  assets: string[];
  destinations: string[];
  perTxMax: string;
  dailyMax: string;
  autoApproveMax: string;
  alwaysEscalate?: boolean;
  escalationImpact?: EscalationImpact;
  delegable?: boolean;
}

export interface EnvelopeView {
  id: string;
  agentName: string;
  chain: string;
  kinds: string[];
  assets: string[];
  destinations: string[];
  perTxMax: string;
  dailyMax: string;
  autoApproveMax: string;
  alwaysEscalate: boolean;
  escalationImpact: DecisionImpact;
  active: boolean;
  version: number;
  createdAt: string;
  delegable: boolean;
  delegatedBy: string | null;
  parentEnvelopeId: string | null;
}

export interface DelegationView extends EnvelopeView {
  decisionId: string;
}

export interface LedgerLine {
  envelopeId: string;
  agentName: string;
  chain: string;
  dailyMax: string;
  reservedToday: string;
  committedToday: string;
  remainingToday: string;
}

export interface ReceivingAddressView {
  id: string;
  chain: string;
  address: string;
  label: string;
  active: boolean;
  createdAt: string;
}

export interface SettlementPolicyView {
  id: string;
  partnerOrgId: string;
  chain: string;
  asset: string;
  maxAmount: string;
  createdBy: string;
  active: boolean;
  createdAt: string;
}

export interface DecisionView {
  id: string;
  orgId: string;
  agentName: string;
  summary: string;
  impact: DecisionImpact;
  status: DecisionStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SettlementView {
  id: string;
  workBroadcastId: string;
  payerOrgId: string;
  payeeOrgId: string;
  payerAgentName: string;
  chain: string;
  asset: string;
  amount: string;
  destination: string;
  status: 'AUTHORIZED' | 'ESCALATED' | 'REFUSED' | 'SETTLED' | 'REVERTED';
  refusalCode: string | null;
  decisionId: string | null;
  authorizationId: string | null;
  txHash: string | null;
  settledAt: string | null;
  invoiceId: string | null;
  createdAt: string;
}

export type SettleInput =
  | { invoiceId: string }
  | { workBroadcastId: string; payeeOrgId: string; chain: string; asset: string; amount: string };

export interface SettleResult {
  settlement: SettlementView;
  verdict: Verdict;
  autoAcceptedByPolicyId: string | null;
}

export interface InvoiceInput {
  workBroadcastId: string;
  chain: string;
  asset: string;
  amount: string;
  memo?: string;
}

export interface InvoiceView {
  id: string;
  workBroadcastId: string;
  payeeOrgId: string;
  payerOrgId: string;
  chain: string;
  asset: string;
  amount: string;
  memo: string;
  status: 'ISSUED' | 'PAID' | 'VOID';
  issuedBy: string;
  createdAt: string;
}

export interface ReceivablesView {
  outstandingInvoices: InvoiceView[];
  expected: SettlementView[];
  received: SettlementView[];
  refused: SettlementView[];
  reverted: SettlementView[];
  totals: { chain: string; asset: string; received: string; expected: string; invoiced: string }[];
  byPayer: { payerOrgId: string; payerSlug: string; received: string; settlements: number }[];
  receipts: { settlementId: string; key: string }[];
  /** Phase 24: SignedInvoices this org issued, with status. */
  outboundInvoices: { id: string; invoiceId: string; chain: string; asset: string; amount: string; status: string; paidAt: string | null; txHash: string | null; createdAt: string }[];
  /** Phase 25: x402 payments that arrived, one per nonce. */
  inboundPayments: { id: string; kind: string; chain: string; asset: string; amount: string; from: string; txHash: string; outcome: string; createdAt: string }[];
}

export interface ReceiptView {
  orgId: string;
  orgSlug: string;
  side: 'payer' | 'payee';
  key: string;
  title: string;
  body: string;
  contentHash: string;
  version: number;
  address: string;
}

export interface WalletMetrics {
  orgId: string;
  since: string;
  until: string;
  writes: number;
  proposalsAllowed: number;
  proposalsEscalated: number;
  proposalsRefused: number;
  humanAsks: number;
  humanAsksPerHundredWrites: number | null;
  reasonedOutcomes: number;
  reasonCoverage: number | null;
  settlementsPaid: { attempted: number; settled: number; reverted: number; refused: number; pending: number };
  settlementsReceived: number;
  settlementLatencySeconds: { mean: number | null; median: number | null; samples: number };
}

/** What a signer answers. Mirrors @flashyos/signer's ExecuteResult without depending on it. */
export type ExecuteResult =
  | { ok: true; txHash: string; outcome: 'CONFIRMED' | 'REVERTED'; settled: boolean }
  | { ok: false; code: string; reason: string };

/** The outcome of `agent.wallet.transact()`, one of five, each with the reason it carries. */
export type TransactResult =
  | { status: 'executed'; record: OperationRecord; authorization: SignedSpendAuthorization; txHash: string; outcome: 'CONFIRMED' | 'REVERTED' }
  | { status: 'refused'; record: OperationRecord; authorization: SignedSpendAuthorization; code: string; reason: string }
  | { status: 'escalated'; record: OperationRecord; decisionId: string; impact: EscalationImpact }
  | { status: 'denied'; record: OperationRecord; code: string; reason: string }
  | { status: 'unrecognised'; reason: string };

// ─── Phases 17–18–19: identity, interop, meters ──────────────────────────────

import type { Eip712TypedData, SignedInvoice, SignedReceipt, X402Challenge } from '@flashyos/wallet-wdk';
export type { Eip712TypedData, SignedInvoice, SignedReceipt, X402Challenge };

export type ChainFamily = 'evm' | 'tron';

/** Which derived account acts for an agent on a family (Phase 17). Index 0 is the treasury; agents start at 1. */
export interface AgentChainIdentityView {
  agentName: string;
  family: ChainFamily;
  accountIndex: number;
  /** Reported by the signer once it has derived it; null until then. */
  address: string | null;
  createdAt: string;
}

export interface AllowancePlanInput {
  safeAddress: string;
  moduleAddress: string;
  token: string;
  chain: string;
}

export interface AllowancePlanView {
  plan: {
    version: 1;
    safeAddress: string;
    moduleAddress: string;
    token: string;
    transactions: { op: 'addDelegate' | 'setAllowance' | 'removeDelegate' | 'deleteAllowance'; agentName: string; to: string; value: '0'; data: string; summary: string }[];
  };
  missingAddress: string[];
  agents: { agentName: string; address: string; dailyMax: string; envelopeId: string }[];
}

export interface OpenMeterInput {
  chain: string;
  asset: string;
  provider: string;
  providerName?: string;
  unit: string;
  cap: string;
  toleranceBps?: number;
}

export interface MeterView {
  id: string;
  agentName: string;
  chain: string;
  asset: string;
  provider: string;
  providerName: string;
  unit: string;
  cap: string;
  used: string;
  units: string;
  toleranceBps: number;
  status: 'PENDING' | 'OPEN' | 'CLOSED' | 'REFUSED' | 'REJECTED';
  decisionId: string;
  authorizationId: string | null;
  txHash: string | null;
  providerUnits: string | null;
  providerAmount: string | null;
  difference: string | null;
  refusalCode: string | null;
  openedAt: string;
  closedAt: string | null;
  ticks: number;
}

export type OpenMeterResult =
  | { verdict: 'ALLOW' | 'ESCALATE'; meter: MeterView }
  | { verdict: 'DENY'; code: string; reason: string };

export type CloseMeterResult =
  | { closed: true; meter: MeterView; authorization: SignedSpendAuthorization }
  | { closed: false; meter: MeterView; code: 'METER_DISAGREE' | 'METER_EMPTY'; reason: string };

export interface ExternalSettlementView {
  id: string;
  payerAgentName: string;
  payeeName: string;
  payeePublicKey: string;
  invoiceId: string;
  invoice: SignedInvoice;
  chain: string;
  asset: string;
  amount: string;
  destination: string;
  status: 'AUTHORIZED' | 'ESCALATED' | 'REFUSED' | 'SETTLED' | 'REVERTED';
  refusalCode: string | null;
  decisionId: string | null;
  authorizationId: string | null;
  txHash: string | null;
  settledAt: string | null;
  receipt: SignedReceipt | null;
  createdAt: string;
}

export interface SettleExternalResult {
  settlement: ExternalSettlementView;
  verdict: Verdict;
}

export interface PlanePublicKey {
  algorithm: 'Ed25519';
  format: 'spki-pem';
  publicKey: string;
}

/** What a signer answers to typed data. Mirrors @flashyos/signer's SignTypedDataResult. */
export type SignTypedDataResult =
  | { ok: true; signature: string; address: string; reference: string; settled: boolean }
  | { ok: false; code: string; reason: string };

/** The outcome of `agent.wallet.pay402()`: the payment header to retry the request with, or why not. */
export type Pay402Result =
  | { status: 'signed'; record: OperationRecord; authorization: SignedSpendAuthorization; header: string; signature: string; reference: string }
  | { status: 'refused'; record: OperationRecord; authorization: SignedSpendAuthorization; code: string; reason: string }
  | { status: 'escalated'; record: OperationRecord; decisionId: string; impact: EscalationImpact }
  | { status: 'denied'; record: OperationRecord; code: string; reason: string }
  | { status: 'unrecognised'; reason: string };

// ─── Phase 20–21: provenance and the network ─────────────────────────────────

import type { ProvenanceEntry, SignedProvenanceRoot } from '@flashyos/wallet-wdk';
export type { ProvenanceEntry, SignedProvenanceRoot };

export interface SealView extends SignedProvenanceRoot {
  id: string;
  createdAt: string;
  /** The 32 bytes a person anchors on a chain, as calldata. */
  anchorCalldata: string;
}

/** Wallet numbers summed across the organizations that opted in, with the count that did. Honest zeros when none. */
export interface NetworkWalletSummary {
  contributing: number;
  since: string;
  until: string;
  writes: number;
  humanAsks: number;
  humanAsksPerHundredWrites: number | null;
  reasonedOutcomes: number;
  reasonCoverage: number | null;
  settlementsPaid: { attempted: number; settled: number; reverted: number; refused: number; pending: number };
  settlementsReceived: number;
  settlementLatencySeconds: { median: number | null; samples: number };
  generatedAt: string;
}

// ─── Phases 23–26: federation ────────────────────────────────────────────────

import type { PlaneDocument, X402Challenge as X402ChallengeDoc, X402Payment } from '@flashyos/wallet-wdk';
export type { PlaneDocument, X402Payment };

export interface TrustedPlaneView {
  id: string;
  name: string;
  kid: string;
  publicKey: string;
  url: string | null;
  createdBy: string;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export type TrustInput = { name: string; publicKey: string; url?: string } | { name: string; document: PlaneDocument | unknown; url?: string };

export interface OrgKeyView {
  id: string;
  kid: string;
  publicKey: string;
  active: boolean;
  createdAt: string;
  retiredAt: string | null;
}

export interface IssueSignedInvoiceInput {
  chain: string;
  asset: string;
  amount: string;
  destination?: string;
  memo?: string;
  expiresInDays?: number;
  invoiceId?: string;
}

export interface OutboundInvoiceView {
  id: string;
  invoiceId: string;
  invoice: SignedInvoice;
  invoiceHash: string;
  kid: string;
  chain: string;
  asset: string;
  amount: string;
  destination: string;
  memo: string;
  status: 'ISSUED' | 'PAID' | 'VOID';
  issuedBy: string;
  receipt: SignedReceipt | null;
  receiptKid: string | null;
  txHash: string | null;
  paidAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface AcceptReceiptResult {
  accepted: true;
  invoice: OutboundInvoiceView;
  verifiedUnder: { kid: string; name: string; source: 'registry' | 'this-plane' };
  page: { key: string; address: string };
}

export interface ChallengeInput {
  chain: string;
  asset: string;
  amount: string;
  resource: string;
  description?: string;
  payTo?: string;
}

export interface InboundPaymentView {
  id: string;
  kind: string;
  chain: string;
  asset: string;
  amount: string;
  from: string;
  to: string;
  nonce: string;
  resource: string | null;
  txHash: string;
  outcome: string;
  createdAt: string;
}

export interface X402SettlementInput {
  payment: string | X402Payment;
  asset: string;
  txHash: string;
  outcome: 'CONFIRMED' | 'REVERTED';
  resource?: string;
}

/** The money page the next compile writes: a DIGEST page with claim addresses. */
export interface MoneyPage {
  key: string;
  title: string;
  tier: 'DIGEST';
  body: string;
  contentHash: string;
  citations: { sourcePath: string; lineStart: number | null; lineEnd: number | null; quote: string | null }[];
  links: string[];
}

export type { X402ChallengeDoc };
