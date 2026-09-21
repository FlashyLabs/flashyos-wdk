// Everything the object needs from FlashyOS, as one interface.
//
// Two implementations exist: HttpTransport (this package) speaks to the API
// and the signer over the network, which is how an agent runtime uses it;
// InProcessTransport (packages/api) calls the services directly, which is
// how the demos and the API's own tests use it. The object cannot tell them
// apart, and that is the point — the same seven verbs, the same events,
// the same results, whether the caller is a process across a network hop
// or a test in the same one.
//
// Human-role methods take no agent name: the transport carries the session.
// Agent methods take the agent's name: the transport maps it to the token.

import type {
  AgentChainIdentityView,
  AgentIdentity,
  AllowancePlanInput,
  AllowancePlanView,
  ChainFamily,
  CloseMeterResult,
  Eip712TypedData,
  ExternalSettlementView,
  MeterView,
  NetworkWalletSummary,
  AcceptReceiptResult,
  ChallengeInput,
  InboundPaymentView,
  IssueSignedInvoiceInput,
  MoneyPage,
  OrgKeyView,
  OutboundInvoiceView,
  PlaneDocument,
  TrustInput,
  TrustedPlaneView,
  X402Challenge,
  X402SettlementInput,
  OpenMeterInput,
  ProvenanceEntry,
  SealView,
  OpenMeterResult,
  PlanePublicKey,
  SettleExternalResult,
  SignTypedDataResult,
  SignedReceipt,
  AuthorizationView,
  DecisionView,
  DelegationView,
  EnvelopeView,
  ExecuteResult,
  InvoiceInput,
  InvoiceView,
  LedgerLine,
  OperationRecord,
  ReceiptView,
  ReceivablesView,
  ReceivingAddressView,
  Scope,
  SettleInput,
  SettleResult,
  SettlementPolicyView,
  SignedSpendAuthorization,
  SignerCall,
  SpendEnvelopeInput,
  Verdict,
  WalletMetrics,
} from './types';

export interface Transport {
  readonly orgId: string;

  // ── Human role (session) ──────────────────────────────────────────────
  createAgent(agentName: string, scopes: Scope[]): Promise<AgentIdentity>;
  setEnvelope(agentName: string, input: SpendEnvelopeInput): Promise<EnvelopeView>;
  revokeEnvelope(agentName: string, chain: string): Promise<void>;
  listEnvelopes(): Promise<EnvelopeView[]>;
  registerAddress(input: { chain: string; address: string; label?: string }): Promise<ReceivingAddressView>;
  setSettlementPolicy(input: { partnerOrgId: string; chain: string; asset: string; maxAmount: string }): Promise<SettlementPolicyView>;
  listDecisions(): Promise<DecisionView[]>;
  resolveDecision(decisionId: string, approve: boolean): Promise<void>;
  ledger(): Promise<LedgerLine[]>;
  metrics(days: number): Promise<WalletMetrics>;
  receivables(): Promise<ReceivablesView>;
  receipt(settlementId: string): Promise<ReceiptView | null>;
  /** Phase 17: which derived account acts for an agent. OWNER/ADMIN. */
  assignIdentity(agentName: string, family: ChainFamily): Promise<AgentChainIdentityView>;
  listIdentities(): Promise<AgentChainIdentityView[]>;
  /** Phase 17: the envelope tree as Safe Allowance Module transactions, for a person to execute. */
  allowancePlan(input: AllowancePlanInput): Promise<AllowancePlanView>;
  /** Phase 19: every meter in the org. */
  listMeters(): Promise<MeterView[]>;
  /** Phase 18: what the org has paid outside FlashyOS. */
  listExternalSettlements(): Promise<ExternalSettlementView[]>;
  /** The plane's authorization public key: what every receipt verifies under. No credential needed. */
  publicKey(): Promise<PlanePublicKey>;
  /** Phase 20: every wallet fact, hash-chained; the seals over it; a new seal (OWNER/ADMIN). */
  provenance(): Promise<ProvenanceEntry[]>;
  seals(): Promise<SealView[]>;
  seal(): Promise<SealView>;
  /** Phase 21: whether this org's wallet numbers count toward the public network summary (OWNER). */
  setWalletSharing(share: boolean): Promise<{ share: boolean }>;
  /** Phase 21: the public summary. No credential needed. */
  networkWallet(): Promise<NetworkWalletSummary>;
  /** Phase 23: the plane's identity document (no credential); whom this org trusts (OWNER edits). */
  planeDocument(): Promise<PlaneDocument>;
  listTrustedPlanes(): Promise<TrustedPlaneView[]>;
  trustPlane(input: TrustInput): Promise<TrustedPlaneView[]>;
  revokeTrustedPlane(id: string): Promise<void>;
  /** Phase 24: the org's own keys (public halves); rotation is an OWNER act. */
  signingKeys(): Promise<OrgKeyView[]>;
  rotateSigningKey(): Promise<OrgKeyView>;
  listOutboundInvoices(): Promise<OutboundInvoiceView[]>;
  /** Phase 25: what arrived by x402. */
  listInboundPayments(): Promise<InboundPaymentView[]>;
  /** Phase 26: the money page as the next compile writes it. */
  moneyPage(days?: number): Promise<MoneyPage | null>;

  // ── Agent (token) ─────────────────────────────────────────────────────
  propose(agentName: string, record: OperationRecord): Promise<Verdict>;
  authorizations(agentName: string): Promise<AuthorizationView[]>;
  delegate(agentName: string, targetAgent: string, input: SpendEnvelopeInput): Promise<DelegationView>;
  revokeDelegation(agentName: string, targetAgent: string, chain: string): Promise<void>;
  settle(agentName: string, input: SettleInput): Promise<SettleResult>;
  invoice(agentName: string, input: InvoiceInput): Promise<InvoiceView>;
  capture(agentName: string, body: string, sourcePath?: string): Promise<void>;
  /** Phase 19: a cap for one provider under one decision, then ticks, then one settlement. */
  openMeter(agentName: string, input: OpenMeterInput): Promise<OpenMeterResult>;
  tickMeter(agentName: string, meterId: string, input: { units: string; amount: string; note?: string }): Promise<MeterView>;
  closeMeter(agentName: string, meterId: string, input: { providerUnits: string; providerAmount: string }): Promise<CloseMeterResult>;
  /** Phase 18: pay a SignedInvoice from a payee outside FlashyOS, through the plane. */
  settleExternal(agentName: string, invoice: unknown): Promise<SettleExternalResult>;
  externalReceipt(agentName: string, invoiceId: string): Promise<SignedReceipt | null>;
  /** Phase 24: an invoice under the org's key to a payer anywhere; a receipt presented for one. */
  issueSignedInvoice(agentName: string, input: IssueSignedInvoiceInput): Promise<OutboundInvoiceView>;
  voidOutboundInvoice(agentName: string, id: string): Promise<OutboundInvoiceView>;
  acceptReceipt(agentName: string, receipt: unknown): Promise<AcceptReceiptResult>;
  /** Phase 25: the 402 body for a paid resource; a facilitator's settlement report (wallet:settle). */
  x402Challenge(agentName: string, input: ChallengeInput): Promise<X402Challenge>;
  recordX402Settlement(agentName: string, input: X402SettlementInput): Promise<InboundPaymentView>;

  // ── Execution (the signer) ────────────────────────────────────────────
  execute(authorization: SignedSpendAuthorization, call: SignerCall): Promise<ExecuteResult>;
  /** Phase 18: an EIP-3009 authorization signed off-chain (x402). The signer re-derives the typed data like any call. */
  signTypedData(authorization: SignedSpendAuthorization, typedData: Eip712TypedData): Promise<SignTypedDataResult>;
}

/** Thrown by a transport when FlashyOS answered with an error rather than a result. */
export class TransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
