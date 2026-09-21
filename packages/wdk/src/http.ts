// The transport an agent runtime uses: FlashyOS over HTTPS, the signer over
// its own port. Three credentials, each used only where it belongs:
//
//   sessionToken   a human's session — creates agents, sets envelopes, resolves decisions
//   agentTokens    per agent — proposes, delegates, settles, invoices, captures
//   signerUrl      the signer's POST /execute; the authorization is the credential
//
// Any of them may be absent; the method that needs it then throws
// TransportError('NO_CREDENTIAL') before making a request.

import { TransportError, type Transport } from './transport';
import type {
  AgentChainIdentityView, AllowancePlanInput, AllowancePlanView, ChainFamily, CloseMeterResult, Eip712TypedData, ExternalSettlementView, MeterView,
  OpenMeterInput, OpenMeterResult, PlanePublicKey, SettleExternalResult, SignTypedDataResult, SignedReceipt, NetworkWalletSummary, ProvenanceEntry, SealView,
  AcceptReceiptResult, ChallengeInput, InboundPaymentView, IssueSignedInvoiceInput, MoneyPage, OrgKeyView, OutboundInvoiceView, PlaneDocument, TrustInput, TrustedPlaneView, X402Challenge, X402SettlementInput,
  AgentIdentity, AuthorizationView, DecisionView, DelegationView, EnvelopeView, ExecuteResult, InvoiceInput, InvoiceView, LedgerLine,
  OperationRecord, ReceiptView, ReceivablesView, ReceivingAddressView, Scope, SettleInput, SettleResult, SettlementPolicyView,
  SignedSpendAuthorization, SignerCall, SpendEnvelopeInput, Verdict, WalletMetrics,
} from './types';

export interface HttpTransportOptions {
  /** e.g. https://api.flashyos.com */
  baseUrl: string;
  orgId: string;
  sessionToken?: string;
  agentTokens?: Record<string, string>;
  /** e.g. http://signer.internal:8787 — reachable only from inside the deployment. */
  signerUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpTransport implements Transport {
  readonly orgId: string;
  private readonly agentTokens: Map<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpTransportOptions) {
    this.orgId = options.orgId;
    this.agentTokens = new Map(Object.entries(options.agentTokens ?? {}));
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** The token this transport holds for an agent — set by createAgent, or supplied at construction. */
  tokenFor(agentName: string): string | undefined {
    return this.agentTokens.get(agentName);
  }

  private async request<T>(url: string, token: string | undefined, init: { method?: string; body?: unknown } = {}, okStatuses: number[] = [200, 201]): Promise<{ status: number; body: T }> {
    if (!token) throw new TransportError('NO_CREDENTIAL', 0, `no credential for ${init.method ?? 'GET'} ${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (err) {
      throw new TransportError('UNREACHABLE', 0, `${url}: ${(err as Error)?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
    if (!okStatuses.includes(res.status)) throw new TransportError(body.code ?? `HTTP_${res.status}`, res.status, body.error ?? `HTTP ${res.status}`);
    return { status: res.status, body };
  }

  private api(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/api/v1/orgs/${this.orgId}${path}`;
  }
  private session<T>(path: string, init?: { method?: string; body?: unknown }, ok?: number[]) {
    return this.request<T>(this.api(path), this.options.sessionToken, init, ok);
  }
  private agent<T>(agentName: string, path: string, init?: { method?: string; body?: unknown }, ok?: number[]) {
    return this.request<T>(this.api(path), this.agentTokens.get(agentName), init, ok);
  }

  // ── human role ────────────────────────────────────────────────────────
  async createAgent(agentName: string, scopes: Scope[]): Promise<AgentIdentity> {
    const minted = await this.session<{ orgId: string; agentName: string; token: string }>('/agents', { method: 'POST', body: { agentName } });
    this.agentTokens.set(agentName, minted.body.token);
    const granted = await this.session<{ scopes: Scope[] }>(`/agents/${encodeURIComponent(agentName)}/scopes`, { method: 'PUT', body: { scopes } });
    return { orgId: this.orgId, agentName, scopes: granted.body.scopes };
  }
  async setEnvelope(agentName: string, input: SpendEnvelopeInput): Promise<EnvelopeView> {
    return (await this.session<{ envelope: EnvelopeView }>('/wallet/envelopes', { method: 'POST', body: { agentName, ...input } })).body.envelope;
  }
  async revokeEnvelope(agentName: string, chain: string): Promise<void> {
    await this.session('/wallet/envelopes/revoke', { method: 'POST', body: { agentName, chain } });
  }
  async listEnvelopes(): Promise<EnvelopeView[]> {
    return (await this.session<{ envelopes: EnvelopeView[] }>('/wallet/envelopes')).body.envelopes;
  }
  async registerAddress(input: { chain: string; address: string; label?: string }): Promise<ReceivingAddressView> {
    return (await this.session<{ address: ReceivingAddressView }>('/wallet/addresses', { method: 'POST', body: input })).body.address;
  }
  async setSettlementPolicy(input: { partnerOrgId: string; chain: string; asset: string; maxAmount: string }): Promise<SettlementPolicyView> {
    return (await this.session<{ policy: SettlementPolicyView }>('/wallet/settlement-policies', { method: 'POST', body: input })).body.policy;
  }
  async listDecisions(): Promise<DecisionView[]> {
    return (await this.session<{ decisions: DecisionView[] }>('/decisions')).body.decisions;
  }
  async resolveDecision(decisionId: string, approve: boolean): Promise<void> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/api/v1/decisions/${decisionId}/resolve`;
    await this.request(url, this.options.sessionToken, { method: 'POST', body: { approve } });
  }
  async ledger(): Promise<LedgerLine[]> {
    return (await this.session<{ ledger: LedgerLine[] }>('/wallet/ledger')).body.ledger;
  }
  async metrics(days: number): Promise<WalletMetrics> {
    return (await this.session<{ metrics: WalletMetrics }>(`/wallet/metrics?days=${days}`)).body.metrics;
  }
  async receivables(): Promise<ReceivablesView> {
    return (await this.session<ReceivablesView>('/wallet/receivables')).body;
  }
  async receipt(settlementId: string): Promise<ReceiptView | null> {
    const res = await this.session<{ receipt?: ReceiptView; code?: string }>(`/wallet/receipts/${settlementId}`, {}, [200, 404]);
    return res.status === 200 ? (res.body.receipt ?? null) : null;
  }

  async assignIdentity(agentName: string, family: ChainFamily): Promise<AgentChainIdentityView> {
    return (await this.session<{ identity: AgentChainIdentityView }>('/wallet/identities', { method: 'POST', body: { agentName, family } })).body.identity;
  }
  async listIdentities(): Promise<AgentChainIdentityView[]> {
    return (await this.session<{ identities: AgentChainIdentityView[] }>('/wallet/identities')).body.identities;
  }
  async allowancePlan(input: AllowancePlanInput): Promise<AllowancePlanView> {
    const q = new URLSearchParams({ safe: input.safeAddress, module: input.moduleAddress, token: input.token, chain: input.chain });
    return (await this.session<AllowancePlanView>(`/wallet/identities/plan?${q}`)).body;
  }
  async listMeters(): Promise<MeterView[]> {
    return (await this.session<{ meters: MeterView[] }>('/wallet/meters')).body.meters;
  }
  async listExternalSettlements(): Promise<ExternalSettlementView[]> {
    return (await this.session<{ settlements: ExternalSettlementView[] }>('/wallet/external/invoices')).body.settlements;
  }
  async publicKey(): Promise<PlanePublicKey> {
    // A public key needs no credential; any token the transport holds is fine, and none is required.
    return (await this.request<PlanePublicKey>(this.api('/wallet/public-key'), this.options.sessionToken ?? [...this.agentTokens.values()][0] ?? 'public')).body;
  }

  async provenance(): Promise<ProvenanceEntry[]> {
    return (await this.session<{ entries: ProvenanceEntry[] }>('/wallet/provenance')).body.entries;
  }
  async seals(): Promise<SealView[]> {
    return (await this.session<{ seals: SealView[] }>('/wallet/provenance/seals')).body.seals;
  }
  async seal(): Promise<SealView> {
    return (await this.session<{ seal: SealView }>('/wallet/provenance/seal', { method: 'POST', body: {} })).body.seal;
  }
  async setWalletSharing(share: boolean): Promise<{ share: boolean }> {
    return (await this.session<{ share: boolean }>('/wallet/sharing', { method: 'POST', body: { share } })).body;
  }
  async networkWallet(): Promise<NetworkWalletSummary> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/api/v1/public/network/wallet`;
    return (await this.request<NetworkWalletSummary>(url, this.options.sessionToken ?? [...this.agentTokens.values()][0] ?? 'public')).body;
  }

  async planeDocument(): Promise<PlaneDocument> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/.well-known/flashyos-plane.json`;
    return (await this.request<PlaneDocument>(url, this.options.sessionToken ?? [...this.agentTokens.values()][0] ?? 'public')).body;
  }
  async listTrustedPlanes(): Promise<TrustedPlaneView[]> {
    return (await this.session<{ trustedPlanes: TrustedPlaneView[] }>('/wallet/trusted-planes')).body.trustedPlanes;
  }
  async trustPlane(input: TrustInput): Promise<TrustedPlaneView[]> {
    return (await this.session<{ trustedPlanes: TrustedPlaneView[] }>('/wallet/trusted-planes', { method: 'POST', body: input })).body.trustedPlanes;
  }
  async revokeTrustedPlane(id: string): Promise<void> {
    await this.session(`/wallet/trusted-planes/${id}/revoke`, { method: 'POST', body: {} });
  }
  async signingKeys(): Promise<OrgKeyView[]> {
    return (await this.session<{ keys: OrgKeyView[] }>('/wallet/signing-keys')).body.keys;
  }
  async rotateSigningKey(): Promise<OrgKeyView> {
    return (await this.session<{ key: OrgKeyView }>('/wallet/signing-keys/rotate', { method: 'POST', body: {} })).body.key;
  }
  async listOutboundInvoices(): Promise<OutboundInvoiceView[]> {
    return (await this.session<{ invoices: OutboundInvoiceView[] }>('/wallet/outbound-invoices')).body.invoices;
  }
  async listInboundPayments(): Promise<InboundPaymentView[]> {
    return (await this.session<{ payments: InboundPaymentView[] }>('/wallet/x402/settlements')).body.payments;
  }
  async moneyPage(days = 7): Promise<MoneyPage | null> {
    return (await this.session<{ page: MoneyPage | null }>(`/wallet/digest?days=${days}`)).body.page;
  }

  // ── agent ─────────────────────────────────────────────────────────────
  async propose(agentName: string, record: OperationRecord): Promise<Verdict> {
    return (await this.agent<Verdict>(agentName, '/wallet/proposals', { method: 'POST', body: record }, [200, 201, 202])).body;
  }
  async authorizations(agentName: string): Promise<AuthorizationView[]> {
    return (await this.agent<{ authorizations: AuthorizationView[] }>(agentName, '/wallet/authorizations?limit=100')).body.authorizations;
  }
  async delegate(agentName: string, targetAgent: string, input: SpendEnvelopeInput): Promise<DelegationView> {
    return (await this.agent<{ delegation: DelegationView }>(agentName, '/wallet/envelopes/delegate', { method: 'POST', body: { agentName: targetAgent, ...input } })).body.delegation;
  }
  async revokeDelegation(agentName: string, targetAgent: string, chain: string): Promise<void> {
    await this.agent(agentName, '/wallet/envelopes/delegate/revoke', { method: 'POST', body: { agentName: targetAgent, chain } });
  }
  async settle(agentName: string, input: SettleInput): Promise<SettleResult> {
    return (await this.agent<SettleResult>(agentName, '/wallet/settlements', { method: 'POST', body: input }, [200, 201, 202])).body;
  }
  async invoice(agentName: string, input: InvoiceInput): Promise<InvoiceView> {
    return (await this.agent<{ invoice: InvoiceView }>(agentName, '/wallet/invoices', { method: 'POST', body: input })).body.invoice;
  }
  async capture(agentName: string, body: string, sourcePath?: string): Promise<void> {
    await this.agent(agentName, '/vault/captures', { method: 'POST', body: { body, sourcePath } });
  }
  async openMeter(agentName: string, input: OpenMeterInput): Promise<OpenMeterResult> {
    return (await this.agent<OpenMeterResult>(agentName, '/wallet/meters', { method: 'POST', body: input }, [200, 201, 202])).body;
  }
  async tickMeter(agentName: string, meterId: string, input: { units: string; amount: string; note?: string }): Promise<MeterView> {
    return (await this.agent<{ meter: MeterView }>(agentName, `/wallet/meters/${meterId}/tick`, { method: 'POST', body: input })).body.meter;
  }
  async closeMeter(agentName: string, meterId: string, input: { providerUnits: string; providerAmount: string }): Promise<CloseMeterResult> {
    return (await this.agent<CloseMeterResult>(agentName, `/wallet/meters/${meterId}/close`, { method: 'POST', body: input }, [200, 201])).body;
  }
  async settleExternal(agentName: string, invoice: unknown): Promise<SettleExternalResult> {
    return (await this.agent<SettleExternalResult>(agentName, '/wallet/external/invoices', { method: 'POST', body: { invoice } }, [200, 201, 202])).body;
  }
  async issueSignedInvoice(agentName: string, input: IssueSignedInvoiceInput): Promise<OutboundInvoiceView> {
    return (await this.agent<{ invoice: OutboundInvoiceView }>(agentName, '/wallet/outbound-invoices', { method: 'POST', body: input })).body.invoice;
  }
  async voidOutboundInvoice(agentName: string, id: string): Promise<OutboundInvoiceView> {
    return (await this.agent<{ invoice: OutboundInvoiceView }>(agentName, `/wallet/outbound-invoices/${id}/void`, { method: 'POST', body: {} })).body.invoice;
  }
  async acceptReceipt(agentName: string, receipt: unknown): Promise<AcceptReceiptResult> {
    return (await this.agent<AcceptReceiptResult>(agentName, '/wallet/receivables/receipts', { method: 'POST', body: { receipt } })).body;
  }
  async x402Challenge(agentName: string, input: ChallengeInput): Promise<X402Challenge> {
    const q = new URLSearchParams({ chain: input.chain, asset: input.asset, amount: input.amount, resource: input.resource, ...(input.payTo ? { payTo: input.payTo } : {}), ...(input.description ? { description: input.description } : {}) });
    return (await this.agent<X402Challenge>(agentName, `/wallet/x402/challenge?${q}`)).body;
  }
  async recordX402Settlement(agentName: string, input: X402SettlementInput): Promise<InboundPaymentView> {
    return (await this.agent<{ payment: InboundPaymentView }>(agentName, '/wallet/x402/settlements', { method: 'POST', body: input })).body.payment;
  }
  async externalReceipt(agentName: string, invoiceId: string): Promise<SignedReceipt | null> {
    const res = await this.agent<{ receipt?: SignedReceipt }>(agentName, `/wallet/external/invoices/${encodeURIComponent(invoiceId)}/receipt`, {}, [200, 404]);
    return res.status === 200 ? (res.body.receipt ?? null) : null;
  }

  // ── signer ────────────────────────────────────────────────────────────
  private async signer<T extends { ok: boolean }>(path: string, body: unknown): Promise<T | { ok: false; code: string; reason: string }> {
    if (!this.options.signerUrl) return { ok: false, code: 'NO_SIGNER', reason: 'this transport has no signer to execute through' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.options.signerUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // 200 done, 403 refused: both are the signer's answer, as a value.
      if (res.status === 200 || res.status === 403) return (await res.json()) as T;
      const parsed = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, code: `SIGNER_HTTP_${res.status}`, reason: parsed.error ?? `signer answered HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, code: 'SIGNER_UNREACHABLE', reason: (err as Error)?.message ?? String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
  execute(authorization: SignedSpendAuthorization, call: SignerCall): Promise<ExecuteResult> {
    return this.signer<ExecuteResult>('/execute', { authorization, call });
  }
  signTypedData(authorization: SignedSpendAuthorization, typedData: Eip712TypedData): Promise<SignTypedDataResult> {
    return this.signer<SignTypedDataResult>('/sign-typed-data', { authorization, typedData });
  }
}
