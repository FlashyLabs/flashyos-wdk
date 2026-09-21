// The signer.
//
// It holds the seed and the plane's *public* key, and does five things in a
// fixed order for every request: verify the authorization's signature and
// window; refuse a nonce it has seen; re-derive the OperationRecord from the
// actual call arguments — never from the authorization; refuse any mismatch;
// then mark the nonce spent, execute, and report settlement.
//
// The re-derivation is the point. The authorization says what *may* happen;
// the call says what *is* happening. If the agent was authorized to pay
// vendor A and the call pays vendor B, no signature in the world makes that
// acceptable, and this is where it is caught.

import type { KeyObject } from 'crypto';
import { extractEip3009Operation, extractOperation, recordWithinAuthorization, type Eip712TypedData, type OperationRecord, type SignedSpendAuthorization, type SignerCall } from '@flashyos/wallet-wdk';
import { TypedDataUnsupported, type ChainBackend, type ChainOutcome } from './chain';
import { MemoryNonceStore, type NonceStore } from './nonces';
import { publicKeyFromPem, verifyAuthorization } from './verify';

export interface SettlementReporter {
  report(authorization: SignedSpendAuthorization, outcome: ChainOutcome, txHash: string): Promise<void>;
}

export interface SignerOptions {
  /** The authorization plane's public key, PEM. The private half never comes here. */
  planePublicKeyPem: string;
  chains: ChainBackend[];
  nonces?: NonceStore;
  settlement?: SettlementReporter;
  now?: () => Date;
  /** Override extraction, e.g. to add a chain family. Default handles evm:* and tron:* transactions and swap/bridge protocol calls. */
  extract?: (chain: string, call: unknown) => OperationRecord | null;
  /**
   * The third line: a limit the account contract enforces, read before
   * execution so the signer refuses what the chain would refuse. It is a
   * read, not the enforcement — the chain still decides — and it applies
   * only to records it governs (ERC-20 transfers, today).
   */
  onChainLimit?: OnChainLimit;
  /**
   * Which derived account acts for an authorization — one index per agent
   * (Phase 17). Absent, or returning undefined, means the backend's default.
   * Typically backed by the plane's identity registry.
   */
  accountIndexFor?: (authorization: SignedSpendAuthorization) => Promise<number | undefined>;
}

export interface OnChainLimit {
  check(record: OperationRecord): Promise<{ ok: true } | { ok: false; code: string; reason: string }>;
}

export interface ExecuteRequest {
  authorization: SignedSpendAuthorization;
  /** The actual call: an EVM or TRON transaction, or a swap/bridge protocol call. */
  call: SignerCall;
}

export type ExecuteRefusal =
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'REPLAY'
  | 'NO_BACKEND'
  | 'UNRECOGNISED_CALL'
  | 'MISMATCH'
  | 'ONCHAIN_LIMIT'
  | 'EXECUTION_FAILED';

export type ExecuteResult =
  | { ok: true; txHash: string; outcome: ChainOutcome; settled: boolean }
  | { ok: false; code: ExecuteRefusal; reason: string };

export interface SignTypedDataRequest {
  authorization: SignedSpendAuthorization;
  /** An EIP-3009 TransferWithAuthorization; anything else is UNRECOGNISED_CALL. */
  typedData: Eip712TypedData;
}

export type SignTypedDataResult =
  | {
      ok: true;
      signature: string;
      address: string;
      /** What the plane's ledger records the authorization as spent against: `eip3009:<nonce>`. The transfer itself is the facilitator's to submit. */
      reference: string;
      settled: boolean;
    }
  | { ok: false; code: ExecuteRefusal | 'TYPED_DATA_UNSUPPORTED'; reason: string };

const defaultExtract = (chain: string, call: unknown): OperationRecord | null => extractOperation(chain, call);

export class Signer {
  private readonly publicKey: KeyObject;
  private readonly nonces: NonceStore;
  private readonly now: () => Date;
  private readonly extract: NonNullable<SignerOptions['extract']>;
  private readonly backends = new Map<string, ChainBackend>();
  /** Executions whose settlement report failed; an operator retries these. */
  readonly unreportedSettlements: { authorization: SignedSpendAuthorization; outcome: ChainOutcome; txHash: string; error: string }[] = [];
  /**
   * Executions the backend could not complete after the nonce was spent. When
   * `txHash` is set the transaction was broadcast and its receipt never
   * arrived; an operator reconciles it against the chain. When it is null
   * nothing was broadcast and the authorization is simply lost — the safe
   * direction, and the plane's nightly sweep releases its budget.
   */
  readonly pendingExecutions: { authorization: SignedSpendAuthorization; record: OperationRecord; txHash: string | null; error: string }[] = [];

  constructor(private readonly options: SignerOptions) {
    this.publicKey = publicKeyFromPem(options.planePublicKeyPem);
    this.nonces = options.nonces ?? new MemoryNonceStore();
    this.now = options.now ?? (() => new Date());
    this.extract = options.extract ?? defaultExtract;
    for (const backend of options.chains) this.backends.set(backend.chain, backend);
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const { authorization, call } = request;

    const verified = verifyAuthorization(authorization, this.publicKey, this.now());
    if (!verified.ok) return { ok: false, code: verified.code, reason: `authorization ${verified.code.toLowerCase()}` };

    if (await this.nonces.has(authorization.id)) {
      return { ok: false, code: 'REPLAY', reason: `authorization ${authorization.id} has already been used` };
    }

    const backend = this.backends.get(authorization.chain);
    if (!backend) return { ok: false, code: 'NO_BACKEND', reason: `no backend for ${authorization.chain}` };

    const record = this.extract(authorization.chain, call);
    if (!record) return { ok: false, code: 'UNRECOGNISED_CALL', reason: 'the call is not an operation this signer can vouch for' };

    if (!recordWithinAuthorization(record, authorization)) {
      return { ok: false, code: 'MISMATCH', reason: 'the call does not match what was authorized' };
    }

    // The third line, when configured: what the chain's own limit says,
    // read now. A refusal here costs nothing on chain and is recorded like
    // any other; a pass is not a promise, and a revert is still a revert.
    if (this.options.onChainLimit && record.kind === 'transfer' && record.asset !== 'native') {
      const verdict = await this.options.onChainLimit.check(record);
      if (!verdict.ok) return { ok: false, code: 'ONCHAIN_LIMIT', reason: verdict.reason };
    }

    // Spent before broadcast: a crash between the two strands an unused
    // authorization, which is recoverable; the reverse strands a double
    // spend, which is not.
    await this.nonces.add(authorization.id);

    let result;
    try {
      // The backend gets the verified record and the original call: a swap
      // needs tokenOut and minAmountOut to execute, which the record — by
      // design — does not carry. And which account acts: the agent's own.
      const accountIndex = this.options.accountIndexFor ? await this.options.accountIndexFor(authorization) : undefined;
      result = await backend.execute(record, call, { accountIndex });
    } catch (err) {
      const e = err as { message?: string; txHash?: unknown };
      const txHash = typeof e?.txHash === 'string' ? e.txHash : null;
      const error = e?.message ?? String(err);
      this.pendingExecutions.push({ authorization, record, txHash, error });
      return { ok: false, code: 'EXECUTION_FAILED', reason: txHash ? `broadcast as ${txHash} but unconfirmed: ${error}` : `not broadcast: ${error}` };
    }

    let settled = false;
    if (this.options.settlement) {
      try {
        await this.options.settlement.report(authorization, result.outcome, result.txHash);
        settled = true;
      } catch (err) {
        this.unreportedSettlements.push({ authorization, outcome: result.outcome, txHash: result.txHash, error: (err as Error)?.message ?? String(err) });
      }
    }
    return { ok: true, txHash: result.txHash, outcome: result.outcome, settled };
  }

  /**
   * The same ladder for an off-chain signature. The typed data is
   * re-derived to a record — chain from the domain, asset from the verifying
   * contract, amount and destination from the message — and must sit within
   * the authorization; the nonce is spent before signing; the plane is told
   * the authorization was consumed. The signature is a payment the holder
   * can submit once; that is why it is treated exactly like a broadcast.
   */
  async signTypedData(request: SignTypedDataRequest): Promise<SignTypedDataResult> {
    const { authorization, typedData } = request;

    const verified = verifyAuthorization(authorization, this.publicKey, this.now());
    if (!verified.ok) return { ok: false, code: verified.code, reason: `authorization ${verified.code.toLowerCase()}` };
    if (await this.nonces.has(authorization.id)) {
      return { ok: false, code: 'REPLAY', reason: `authorization ${authorization.id} has already been used` };
    }
    const backend = this.backends.get(authorization.chain);
    if (!backend) return { ok: false, code: 'NO_BACKEND', reason: `no backend for ${authorization.chain}` };
    if (!backend.signTypedData) return { ok: false, code: 'TYPED_DATA_UNSUPPORTED', reason: `the ${authorization.chain} backend cannot sign typed data` };

    const record = extractEip3009Operation(authorization.chain, typedData);
    if (!record) return { ok: false, code: 'UNRECOGNISED_CALL', reason: 'the typed data is not a TransferWithAuthorization this signer can vouch for' };
    if (!recordWithinAuthorization(record, authorization)) {
      return { ok: false, code: 'MISMATCH', reason: 'the typed data does not match what was authorized' };
    }
    if (this.options.onChainLimit) {
      const verdict = await this.options.onChainLimit.check(record);
      if (!verdict.ok) return { ok: false, code: 'ONCHAIN_LIMIT', reason: verdict.reason };
    }

    await this.nonces.add(authorization.id);
    let signed;
    try {
      const accountIndex = this.options.accountIndexFor ? await this.options.accountIndexFor(authorization) : undefined;
      signed = await backend.signTypedData(typedData, { accountIndex });
    } catch (err) {
      if (err instanceof TypedDataUnsupported) return { ok: false, code: 'TYPED_DATA_UNSUPPORTED', reason: err.message };
      const error = (err as Error)?.message ?? String(err);
      this.pendingExecutions.push({ authorization, record, txHash: null, error });
      return { ok: false, code: 'EXECUTION_FAILED', reason: `not signed: ${error}` };
    }

    const reference = `eip3009:${typedData.message.nonce}`;
    let settled = false;
    if (this.options.settlement) {
      try {
        await this.options.settlement.report(authorization, 'CONFIRMED', reference);
        settled = true;
      } catch (err) {
        this.unreportedSettlements.push({ authorization, outcome: 'CONFIRMED', txHash: reference, error: (err as Error)?.message ?? String(err) });
      }
    }
    return { ok: true, signature: signed.signature, address: signed.address, reference, settled };
  }
}

/** Reports settlement to the plane with a token holding wallet:settle. */
export class FlashyOSSettlementReporter implements SettlementReporter {
  constructor(
    private readonly options: { baseUrl: string; orgId: string; settleToken: string; fetch?: typeof fetch; timeoutMs?: number },
  ) {}

  async report(authorization: SignedSpendAuthorization, outcome: ChainOutcome, txHash: string): Promise<void> {
    const fetchImpl = this.options.fetch ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const res = await fetchImpl(
        `${this.options.baseUrl.replace(/\/$/, '')}/api/v1/orgs/${this.options.orgId}/wallet/authorizations/${authorization.id}/settle`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.settleToken}` },
          body: JSON.stringify({ outcome, txHash }),
        },
      );
      if (!res.ok) throw new Error(`settle returned HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
