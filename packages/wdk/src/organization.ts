// The organization, as the humans see it: it creates agents, sets their
// authority, answers their escalations, and reads the books.
//
// Every method here is a human-role act. None of it is reachable from an
// agent's token, which is why it is on this object and not on FlashyAgent.

import { FlashyAgent } from './agent';
import { FlashyEvents } from './events';
import type { Transport } from './transport';
import type {
  AgentChainIdentityView,
  AllowancePlanInput,
  AllowancePlanView,
  ChainFamily,
  DecisionView,
  ExternalSettlementView,
  MeterView,
  MoneyPage,
  NetworkWalletSummary,
  OrgKeyView,
  OutboundInvoiceView,
  PlaneDocument,
  PlanePublicKey,
  TrustInput,
  TrustedPlaneView,
  ProvenanceEntry,
  SealView,
  EnvelopeView,
  LedgerLine,
  ReceiptView,
  ReceivablesView,
  ReceivingAddressView,
  Scope,
  SettlementPolicyView,
  SpendEnvelopeInput,
  WalletMetrics,
} from './types';

export interface FlashyOrganizationOptions {
  events?: FlashyEvents;
}

export class FlashyOrganization {
  readonly orgId: string;
  readonly events: FlashyEvents;
  private readonly known = new Map<string, FlashyAgent>();

  constructor(
    private readonly transport: Transport,
    options: FlashyOrganizationOptions = {},
  ) {
    this.orgId = transport.orgId;
    this.events = options.events ?? new FlashyEvents();
  }

  // ── agents ────────────────────────────────────────────────────────────
  readonly agents = {
    /** Create an agent and give it its identity: a token with exactly these scopes. */
    create: async (agentName: string, scopes: Scope[]): Promise<FlashyAgent> => {
      const identity = await this.transport.createAgent(agentName, scopes);
      const agent = new FlashyAgent(identity, this.transport, this.events);
      this.known.set(agentName, agent);
      this.events.emit('agent.created', this.orgId, agentName, { scopes });
      return agent;
    },
    /** An agent that already exists (the transport must already hold its token). */
    get: (agentName: string, scopes: Scope[] = []): FlashyAgent => {
      let agent = this.known.get(agentName);
      if (!agent) {
        agent = new FlashyAgent({ orgId: this.orgId, agentName, scopes }, this.transport, this.events);
        this.known.set(agentName, agent);
      }
      return agent;
    },
    list: (): FlashyAgent[] => [...this.known.values()],
  };

  // ── authority ─────────────────────────────────────────────────────────
  readonly authority = {
    /** What an agent may spend on a chain. OWNER/ADMIN only; the plane enforces it. */
    set: async (agentName: string, input: SpendEnvelopeInput): Promise<EnvelopeView> => {
      const envelope = await this.transport.setEnvelope(agentName, input);
      this.events.emit('envelope.set', this.orgId, agentName, { chain: input.chain, envelopeId: envelope.id, version: envelope.version, delegable: envelope.delegable });
      return envelope;
    },
    revoke: async (agentName: string, chain: string): Promise<void> => {
      await this.transport.revokeEnvelope(agentName, chain);
      this.events.emit('envelope.revoked', this.orgId, agentName, { chain });
    },
    list: (): Promise<EnvelopeView[]> => this.transport.listEnvelopes(),
  };

  // ── treasury ──────────────────────────────────────────────────────────
  readonly treasury = {
    /** An address this org receives on — the one partners' envelopes must allowlist. */
    registerAddress: (input: { chain: string; address: string; label?: string }): Promise<ReceivingAddressView> => this.transport.registerAddress(input),
    /** Settlements to a partner, on one chain and asset, up to a ceiling, without asking. */
    setSettlementPolicy: (input: { partnerOrgId: string; chain: string; asset: string; maxAmount: string }): Promise<SettlementPolicyView> =>
      this.transport.setSettlementPolicy(input),
  };

  // ── identities (Phase 17) ─────────────────────────────────────────────
  readonly identities = {
    /** Give an agent its own derived account on a family. The index is the identity; the signer reports the address. */
    assign: async (agentName: string, family: ChainFamily): Promise<AgentChainIdentityView> => {
      const identity = await this.transport.assignIdentity(agentName, family);
      this.events.emit('identity.assigned', this.orgId, agentName, { family, accountIndex: identity.accountIndex, address: identity.address });
      return identity;
    },
    list: (): Promise<AgentChainIdentityView[]> => this.transport.listIdentities(),
    /** The envelope tree as Safe Allowance Module transactions — a document for a person to execute, never an action. */
    plan: (input: AllowancePlanInput): Promise<AllowancePlanView> => this.transport.allowancePlan(input),
  };

  // ── provenance (Phase 20) ─────────────────────────────────────────────
  readonly provenance = {
    /** Every wallet fact, hash-chained. Verify with `verifyExport` from @flashyos/wallet-wdk. */
    export: (): Promise<ProvenanceEntry[]> => this.transport.provenance(),
    seals: (): Promise<SealView[]> => this.transport.seals(),
    /** A Merkle root over the export, signed by the plane. OWNER/ADMIN. */
    seal: async (): Promise<SealView> => {
      const seal = await this.transport.seal();
      this.events.emit('provenance.sealed', this.orgId, undefined, { seq: seal.seq, entries: seal.entries, root: seal.root });
      return seal;
    },
  };

  // ── trust (Phase 23) ──────────────────────────────────────────────────
  readonly trust = {
    /** This plane's identity document: keys, chains, schemas. What another org adds to its registry. */
    plane: (): Promise<PlaneDocument> => this.transport.planeDocument(),
    list: (): Promise<TrustedPlaneView[]> => this.transport.listTrustedPlanes(),
    /** Trust a plane's key, or a plane document's active keys. OWNER. */
    add: async (input: TrustInput): Promise<TrustedPlaneView[]> => {
      const trusted = await this.transport.trustPlane(input);
      this.events.emit('plane.trusted', this.orgId, undefined, { name: input.name, kids: trusted.map((t) => t.kid) });
      return trusted;
    },
    revoke: async (id: string): Promise<void> => {
      await this.transport.revokeTrustedPlane(id);
      this.events.emit('plane.revoked', this.orgId, undefined, { trustedPlaneId: id });
    },
  };

  // ── keys (Phase 24) ───────────────────────────────────────────────────
  readonly keys = {
    /** Public halves, active first: what a payer checks an invoice's payee.publicKey against. */
    list: (): Promise<OrgKeyView[]> => this.transport.signingKeys(),
    /** A new active key; the old one retired and kept. OWNER. */
    rotate: async (): Promise<OrgKeyView> => {
      const key = await this.transport.rotateSigningKey();
      this.events.emit('key.rotated', this.orgId, undefined, { kid: key.kid });
      return key;
    },
  };

  // ── the network (Phase 21) ────────────────────────────────────────────
  readonly network = {
    /** Count this org's wallet numbers in the public summary, or stop. OWNER. */
    share: (share: boolean): Promise<{ share: boolean }> => this.transport.setWalletSharing(share),
    /** The public summary across every org that opted in. */
    summary: (): Promise<NetworkWalletSummary> => this.transport.networkWallet(),
  };

  // ── decisions ─────────────────────────────────────────────────────────
  readonly decisions = {
    list: (): Promise<DecisionView[]> => this.transport.listDecisions(),
    pending: async (): Promise<DecisionView[]> => (await this.transport.listDecisions()).filter((d) => d.status === 'PENDING'),
    resolve: async (decisionId: string, approve: boolean): Promise<void> => {
      await this.transport.resolveDecision(decisionId, approve);
      this.events.emit('decision.resolved', this.orgId, undefined, { decisionId, approve });
    },
  };

  // ── the books ─────────────────────────────────────────────────────────
  ledger(): Promise<LedgerLine[]> {
    return this.transport.ledger();
  }
  metrics(days = 7): Promise<WalletMetrics> {
    return this.transport.metrics(days);
  }
  receivables(): Promise<ReceivablesView> {
    return this.transport.receivables();
  }
  receipt(settlementId: string): Promise<ReceiptView | null> {
    return this.transport.receipt(settlementId);
  }
  /** Every meter in the org (Phase 19). */
  meters(): Promise<MeterView[]> {
    return this.transport.listMeters();
  }
  /** What the org has paid to payees outside FlashyOS (Phase 18). */
  externalSettlements(): Promise<ExternalSettlementView[]> {
    return this.transport.listExternalSettlements();
  }
  /** The plane's authorization public key: what every authorization and receipt verifies under. */
  publicKey(): Promise<PlanePublicKey> {
    return this.transport.publicKey();
  }
  /** Invoices this org issued to payers anywhere (Phase 24). */
  outboundInvoices(): Promise<OutboundInvoiceView[]> {
    return this.transport.listOutboundInvoices();
  }
  /** The money page the next compile writes, with claim addresses (Phase 26). */
  money(days = 7): Promise<MoneyPage | null> {
    return this.transport.moneyPage(days);
  }
}
