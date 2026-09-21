// The agent, as one object.
//
//   identity   who it is: org, name, scopes
//   authority  what it may do: its envelope, and what it can carve out for others
//   wallet     doing it: propose, or transact end to end through plane and signer
//   memory     what it did, in the org's brain
//   partners   the other organizations it works with: invoices and settlement
//
// Nothing here holds authority of its own. Every method is a call the
// transport makes with this agent's token, and every refusal is the plane's
// or the signer's, returned as a value with its reason — never thrown.

import { eip3009TypedData, extractOperation, parseX402Challenge, x402PaymentHeader, x402Record, X402Refused } from '@flashyos/wallet-wdk';
import { randomBytes } from 'crypto';
import type { FlashyEvents } from './events';
import type { Transport } from './transport';
import type {
  AgentIdentity,
  AuthorizationView,
  CloseMeterResult,
  MeterView,
  OpenMeterInput,
  OpenMeterResult,
  Pay402Result,
  SettleExternalResult,
  SignedReceipt,
  AcceptReceiptResult,
  ChallengeInput,
  InboundPaymentView,
  IssueSignedInvoiceInput,
  OutboundInvoiceView,
  X402Challenge,
  X402SettlementInput,
  DelegationView,
  EnvelopeView,
  InvoiceInput,
  InvoiceView,
  OperationRecord,
  SettleInput,
  SettleResult,
  SignedSpendAuthorization,
  SignerCall,
  SpendEnvelopeInput,
  TransactResult,
  Verdict,
} from './types';

export interface TransactOptions {
  /**
   * When the plane escalates, wait for a human: poll this agent's
   * authorizations until one for that decision is issued, then execute.
   * Unset, an escalation returns immediately with the decisionId.
   */
  waitForDecision?: { timeoutMs: number; pollMs: number };
  /** Injectable clock and sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class FlashyAgent {
  readonly identity: AgentIdentity;

  constructor(
    identity: AgentIdentity,
    private readonly transport: Transport,
    private readonly events: FlashyEvents,
  ) {
    this.identity = identity;
  }

  get name(): string {
    return this.identity.agentName;
  }

  private emit(type: Parameters<FlashyEvents['emit']>[0], data: Record<string, unknown>) {
    return this.events.emit(type, this.identity.orgId, this.identity.agentName, data);
  }

  // ── authority ─────────────────────────────────────────────────────────
  readonly authority = {
    /** This agent's active envelopes, one per chain. */
    envelopes: async (): Promise<EnvelopeView[]> => (await this.transport.listEnvelopes()).filter((e) => e.agentName === this.name),
    /** Carve a sub-envelope for another agent out of this one's. Narrower only; the plane refuses anything wider. */
    delegate: async (targetAgent: string, input: SpendEnvelopeInput): Promise<DelegationView> => {
      const delegation = await this.transport.delegate(this.name, targetAgent, input);
      this.emit('delegation.created', { targetAgent, chain: input.chain, envelopeId: delegation.id, decisionId: delegation.decisionId });
      return delegation;
    },
    revokeDelegation: async (targetAgent: string, chain: string): Promise<void> => {
      await this.transport.revokeDelegation(this.name, targetAgent, chain);
      this.emit('delegation.revoked', { targetAgent, chain });
    },
  };

  // ── wallet ────────────────────────────────────────────────────────────
  readonly wallet = {
    /** Ask the plane. The answer is a verdict, never a transaction. */
    propose: async (record: OperationRecord): Promise<Verdict> => {
      this.emit('wallet.proposed', { record });
      const verdict = await this.transport.propose(this.name, record);
      if (verdict.verdict === 'ALLOW') this.emit('wallet.allowed', { record, authorizationId: verdict.authorization.id, decisionId: verdict.decisionId });
      else if (verdict.verdict === 'ESCALATE') this.emit('wallet.escalated', { record, decisionId: verdict.decisionId, impact: verdict.impact });
      else this.emit('wallet.denied', { record, code: verdict.code, reason: verdict.reason });
      return verdict;
    },

    authorizations: (): Promise<AuthorizationView[]> => this.transport.authorizations(this.name),

    /**
     * The whole path: re-derive the record from the call, ask the plane,
     * and — if allowed, or approved while waiting — hand the authorization
     * and the *same call* to the signer. Chain-agnostic: the call is an EVM
     * or TRON transaction or a swap/bridge protocol call, and the chain id
     * says which extractor vouches for it.
     */
    transact: async (chain: string, call: SignerCall, options: TransactOptions = {}): Promise<TransactResult> => {
      const record = extractOperation(chain, call);
      if (!record) {
        const reason = `the call is not an operation ${chain} extractors can vouch for`;
        this.emit('wallet.denied', { chain, code: 'UNRECOGNISED_CALL', reason });
        return { status: 'unrecognised', reason };
      }
      const verdict = await this.wallet.propose(record);
      if (verdict.verdict === 'DENY') return { status: 'denied', record, code: verdict.code, reason: verdict.reason };

      let authorization: SignedSpendAuthorization | null = null;
      if (verdict.verdict === 'ALLOW') authorization = verdict.authorization;
      else {
        authorization = await this.awaitIssued(verdict.decisionId, options);
        if (!authorization) return { status: 'escalated', record, decisionId: verdict.decisionId, impact: verdict.impact };
      }

      return this.wallet.execute(authorization, call, record);
    },

    /**
     * Hand an already-issued authorization and the call to the signer. The
     * second half of transact, on its own, for the two cases where the first
     * half happened elsewhere: an escalation a human has since approved
     * (see `complete`), and a settlement the plane allowed through
     * `partners.settle`. The signer re-derives the call regardless; a call
     * that does not match the authorization is refused here as anywhere.
     */
    execute: async (authorization: SignedSpendAuthorization, call: SignerCall, record?: OperationRecord): Promise<TransactResult> => {
      const derived = record ?? extractOperation(authorization.chain, call);
      if (!derived) {
        const reason = `the call is not an operation ${authorization.chain} extractors can vouch for`;
        this.emit('wallet.refused', { authorizationId: authorization.id, code: 'UNRECOGNISED_CALL', reason });
        return { status: 'unrecognised', reason };
      }
      const result = await this.transport.execute(authorization, call);
      if (result.ok) {
        this.emit('wallet.executed', { authorizationId: authorization.id, txHash: result.txHash, outcome: result.outcome });
        return { status: 'executed', record: derived, authorization, txHash: result.txHash, outcome: result.outcome };
      }
      this.emit('wallet.refused', { authorizationId: authorization.id, code: result.code, reason: result.reason });
      return { status: 'refused', record: derived, authorization, code: result.code, reason: result.reason };
    },

    /**
     * A human answered an escalation: pick up the authorization the plane
     * issued for that decision and execute the call. Returns `escalated`
     * again if nothing has been issued (rejected, or not yet decided and
     * not asked to wait).
     */
    complete: async (decisionId: string, chain: string, call: SignerCall, options: TransactOptions = {}): Promise<TransactResult> => {
      const record = extractOperation(chain, call);
      if (!record) return { status: 'unrecognised', reason: `the call is not an operation ${chain} extractors can vouch for` };
      const authorization = await this.awaitIssued(decisionId, { ...options, waitForDecision: options.waitForDecision ?? { timeoutMs: 0, pollMs: 0 } });
      if (!authorization) return { status: 'escalated', record, decisionId, impact: 'MEDIUM' };
      return this.wallet.execute(authorization, call, record);
    },

    /**
     * Phase 19 — pay by the unit under one decision. `open` is graded like a
     * spend of the cap; `tick` records units with no plane round-trip; `close`
     * reconciles the provider's count against the agent's and issues one
     * transfer authorization for what was used, which `transact`-style
     * execution then performs (the close returns the authorization; hand it
     * to `execute` with the transfer call).
     */
    meter: {
      open: async (input: OpenMeterInput): Promise<OpenMeterResult> => {
        const result = await this.transport.openMeter(this.name, input);
        if (result.verdict === 'DENY') this.emit('wallet.denied', { record: { kind: 'meter', ...input }, code: result.code, reason: result.reason });
        else this.emit('meter.opened', { meterId: result.meter.id, verdict: result.verdict, cap: input.cap, provider: input.provider, decisionId: result.meter.decisionId });
        return result;
      },
      tick: async (meterId: string, input: { units: string; amount: string; note?: string }): Promise<MeterView> => {
        const meter = await this.transport.tickMeter(this.name, meterId, input);
        this.emit('meter.ticked', { meterId, units: input.units, amount: input.amount, used: meter.used });
        return meter;
      },
      close: async (meterId: string, input: { providerUnits: string; providerAmount: string }): Promise<CloseMeterResult> => {
        const result = await this.transport.closeMeter(this.name, meterId, input);
        if (result.closed) this.emit('meter.closed', { meterId, authorizationId: result.authorization.id, paid: result.authorization.maxAmount, used: result.meter.used });
        else this.emit('meter.refused', { meterId, code: result.code, reason: result.reason, difference: result.meter.difference });
        return result;
      },
    },

    /**
     * Phase 18 — answer an HTTP 402. The x402 challenge becomes a bounded
     * transfer record (testnets only), the plane grades it, and the signer
     * signs the EIP-3009 authorization only if the typed data re-derives to
     * within what was authorized. Returns the `X-PAYMENT` header to retry
     * the request with. `from` is this agent's account address on the chain.
     */
    pay402: async (challenge: unknown, from: string, options: TransactOptions & { nonce?: string; header?: string | null } = {}): Promise<Pay402Result> => {
      let parsed;
      try {
        parsed = x402Record(parseX402Challenge({ body: options.header ? undefined : challenge, header: options.header ?? null }));
      } catch (err) {
        const reason = err instanceof X402Refused ? `${err.code}: ${err.message}` : (err as Error)?.message ?? String(err);
        this.emit('wallet.denied', { chain: null, code: err instanceof X402Refused ? err.code : 'UNRECOGNISED_CALL', reason });
        return { status: 'unrecognised', reason };
      }
      const { record, accept } = parsed;
      const verdict = await this.wallet.propose(record);
      if (verdict.verdict === 'DENY') return { status: 'denied', record, code: verdict.code, reason: verdict.reason };
      let authorization: SignedSpendAuthorization | null = null;
      if (verdict.verdict === 'ALLOW') authorization = verdict.authorization;
      else {
        authorization = await this.awaitIssued(verdict.decisionId, options);
        if (!authorization) return { status: 'escalated', record, decisionId: verdict.decisionId, impact: verdict.impact };
      }
      const nonce = options.nonce ?? `0x${randomBytes(32).toString('hex')}`;
      const typedData = eip3009TypedData(accept, from, { nonce, now: options.now ? new Date(options.now()) : undefined });
      const signed = await this.transport.signTypedData(authorization, typedData);
      if (!signed.ok) {
        this.emit('wallet.refused', { authorizationId: authorization.id, code: signed.code, reason: signed.reason });
        return { status: 'refused', record, authorization, code: signed.code, reason: signed.reason };
      }
      this.emit('payment.signed', { authorizationId: authorization.id, reference: signed.reference, network: accept.network, amount: record.amount, destination: record.destination });
      return { status: 'signed', record, authorization, header: x402PaymentHeader(accept, typedData, signed.signature), signature: signed.signature, reference: signed.reference };
    },
  };

  private async awaitIssued(decisionId: string, options: TransactOptions): Promise<SignedSpendAuthorization | null> {
    const wait = options.waitForDecision;
    if (!wait) return null;
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + wait.timeoutMs;
    let first = true;
    while (first || now() < deadline) {
      first = false;
      const list = await this.transport.authorizations(this.name);
      const issued = list.find((a) => a.decisionId === decisionId && a.status === 'ISSUED' && a.sig);
      if (issued?.sig) {
        return {
          id: issued.id, orgId: issued.orgId, agentName: issued.agentName, chain: issued.chain, kind: issued.kind as SignedSpendAuthorization['kind'],
          asset: issued.asset, maxAmount: issued.maxAmount, destination: issued.destination, reservationId: issued.reservationId,
          decisionId: issued.decisionId, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt, sig: issued.sig,
        };
      }
      if (list.some((a) => a.decisionId === decisionId && a.status !== 'ISSUED')) return null;
      await sleep(wait.pollMs);
    }
    return null;
  }

  // ── memory ────────────────────────────────────────────────────────────
  readonly memory = {
    /** Write to the org's brain. Data, never an instruction — the plane's captures say so and so does this. */
    record: async (body: string, sourcePath?: string): Promise<void> => {
      await this.transport.capture(this.name, body, sourcePath);
      this.emit('memory.recorded', { sourcePath: sourcePath ?? null, length: body.length });
    },
  };

  // ── partners ──────────────────────────────────────────────────────────
  readonly partners = {
    /** Raise an invoice against a broadcast this org delivered on. The payer is whoever posted it. */
    invoice: async (input: InvoiceInput): Promise<InvoiceView> => {
      const invoice = await this.transport.invoice(this.name, input);
      this.emit('invoice.issued', { invoiceId: invoice.id, payerOrgId: invoice.payerOrgId, amount: invoice.amount, asset: invoice.asset, chain: invoice.chain });
      return invoice;
    },
    /** Pay a partner for delivered work — by invoice, or by naming the terms. Through the plane like any spend. */
    settle: async (input: SettleInput): Promise<SettleResult> => {
      const result = await this.transport.settle(this.name, input);
      this.emit('settlement.attempted', {
        settlementId: result.settlement.id, payeeOrgId: result.settlement.payeeOrgId, status: result.settlement.status,
        verdict: result.verdict.verdict, autoAcceptedByPolicyId: result.autoAcceptedByPolicyId,
      });
      return result;
    },
    /**
     * Phase 18 — pay a SignedInvoice from a payee that is not a FlashyOS org.
     * The plane verifies the signature and grades the transfer like any
     * spend; the destination must already be on this agent's allowlist. On
     * ALLOW the result carries the authorization to execute.
     */
    pay: async (invoice: unknown): Promise<SettleExternalResult> => {
      const result = await this.transport.settleExternal(this.name, invoice);
      this.emit('invoice.paid', {
        settlementId: result.settlement.id, invoiceId: result.settlement.invoiceId, payee: result.settlement.payeeName, status: result.settlement.status,
        verdict: result.verdict.verdict, amount: result.settlement.amount, chain: result.settlement.chain,
      });
      return result;
    },
    /** The plane-signed receipt for an invoice this agent's org paid — hand it to the payee. */
    receipt: (invoiceId: string): Promise<SignedReceipt | null> => this.transport.externalReceipt(this.name, invoiceId),
    /**
     * Phase 24 — a SignedInvoice under the org's own key, to a payer anywhere.
     * The destination is one of the org's registered receiving addresses,
     * chosen by name, never typed.
     */
    issueSignedInvoice: async (input: IssueSignedInvoiceInput): Promise<OutboundInvoiceView> => {
      const invoice = await this.transport.issueSignedInvoice(this.name, input);
      this.emit('invoice.signed', { outboundInvoiceId: invoice.id, invoiceId: invoice.invoiceId, amount: invoice.amount, asset: invoice.asset, chain: invoice.chain, kid: invoice.kid });
      return invoice;
    },
    voidInvoice: async (id: string): Promise<OutboundInvoiceView> => {
      const invoice = await this.transport.voidOutboundInvoice(this.name, id);
      this.emit('invoice.voided', { outboundInvoiceId: id, invoiceId: invoice.invoiceId });
      return invoice;
    },
    /** Phase 24 — present a payer's receipt for an invoice this org issued. Accepted only if it verifies under a trusted plane. */
    acceptReceipt: async (receipt: unknown): Promise<AcceptReceiptResult> => {
      const result = await this.transport.acceptReceipt(this.name, receipt);
      this.emit('receipt.accepted', { outboundInvoiceId: result.invoice.id, invoiceId: result.invoice.invoiceId, txHash: result.invoice.txHash, verifiedUnder: result.verifiedUnder, page: result.page.address });
      return result;
    },
    /** Phase 25 — the 402 body this org's paid endpoint answers with, paying to a registered address. */
    x402Challenge: (input: ChallengeInput): Promise<X402Challenge> => this.transport.x402Challenge(this.name, input),
    /** Phase 25 — a facilitator's report that a buyer's payment settled (this agent holds wallet:settle). */
    recordX402Settlement: async (input: X402SettlementInput): Promise<InboundPaymentView> => {
      const payment = await this.transport.recordX402Settlement(this.name, input);
      this.emit('x402.received', { inboundPaymentId: payment.id, amount: payment.amount, asset: payment.asset, from: payment.from, txHash: payment.txHash, outcome: payment.outcome });
      return payment;
    },
  };
}
