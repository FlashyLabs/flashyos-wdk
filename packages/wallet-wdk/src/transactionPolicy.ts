// A TransactionPolicy for the FlashyOS authorization plane, written against
// the contract in tetherto/wdk PR #88 (a draft, unmerged at time of writing).
//
// The contract, as read from that PR:
//
//   abstract class TransactionPolicy {
//     match(op):    Promise<boolean>
//     evaluate(op): Promise<{ type: 'allow' } | { type: 'deny', reason } | { type: 'abstain' }>
//     commit(op, result):   Promise<void>
//     rollback(op, reason): Promise<void>
//   }
//   OperationRecord { kind, asset, amount, destination, raw }
//   AdapterRegistry: { walletType, method, args } → OperationRecord via extractor packs;
//                    register() replaces, extend() merges; a throwing or
//                    incomplete extractor is a PolicyAdapterError → fail closed.
//   abstain: "matched but unable to judge" — not a vote, so default-deny holds.
//
// Two properties of that contract carry this whole module, and neither is
// written down in the PR:
//
//   1. `abstain` is fail-closed for a remote authorizer for free. When the
//      plane is unreachable we abstain; abstain is not a vote; the engine's
//      default-deny refuses the spend. No timeout branch to get wrong.
//   2. `commit` / `rollback` are the two-phase hooks a budget *ledger* needs.
//      Reserve at authorization, commit on confirmation, roll back on revert.
//
// We cannot import the draft, so this module carries its own copy of the
// contract's types and a small reference engine (`evaluatePolicies`) that
// implements the documented verdict semantics, so the properties above are
// tests rather than claims. Behind a flag until #88 lands.

import { AuthorizerRefused, AuthorizerUnreachable, type Authorizer } from './client';
import { extractEvmOperation, type EvmCall } from './extractors/evm';
import { extractBridge, extractSwap, type BridgeCall, type SwapCall } from './extractors/protocols';
import { extractTronOperation, type TronCall } from './extractors/tron';
import type { OperationRecord, SignedSpendAuthorization } from './types';

// ─── Flag ────────────────────────────────────────────────────────────────────

export const TRANSACTION_POLICY_FLAG = 'WALLET_POLICY_MODE';
export const TRANSACTION_POLICY_MODE = 'transaction-policy';

/** True when the deployment has opted into the PR #88 path. Default off. */
export function isTransactionPolicyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TRANSACTION_POLICY_FLAG] === TRANSACTION_POLICY_MODE;
}

// ─── Contract types ──────────────────────────────────────────────────────────

export type PolicyVerdict = { type: 'allow' } | { type: 'deny'; reason: string } | { type: 'abstain'; reason?: string };

export interface OperationRaw {
  walletType: string;
  method: string;
  args: unknown[];
  account?: unknown;
  derivationPath?: string;
  index?: number;
}

export type PolicyOperationRecord = Omit<OperationRecord, 'raw'> & { raw: OperationRaw };

export interface CommitResult {
  txHash: string;
}

export interface RollbackReason {
  /** Present when the transaction was broadcast and reverted; absent when it was never sent. */
  txHash?: string;
  reason: string;
}

export abstract class TransactionPolicy {
  abstract readonly id: string;
  abstract match(op: PolicyOperationRecord): Promise<boolean>;
  abstract evaluate(op: PolicyOperationRecord): Promise<PolicyVerdict>;
  abstract commit(op: PolicyOperationRecord, result: CommitResult): Promise<void>;
  abstract rollback(op: PolicyOperationRecord, reason: RollbackReason): Promise<void>;
}

// ─── coerceAmount ────────────────────────────────────────────────────────────

/** Non-negative bigint, or undefined. Never a negative that could decrement a cap. */
export function coerceAmount(value: unknown): bigint | undefined {
  try {
    if (typeof value === 'bigint') return value < 0n ? undefined : value;
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? BigInt(value) : undefined;
    if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|0|[1-9][0-9]*)$/.test(value)) {
      const n = BigInt(value);
      return n < 0n ? undefined : n;
    }
  } catch {
    // fall through
  }
  return undefined;
}

// ─── AdapterRegistry ─────────────────────────────────────────────────────────

export class PolicyAdapterError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PolicyAdapterError';
  }
}

export interface CallShape {
  walletType: string;
  method: string;
  args: unknown[];
  /** `<family>:<chainId>` for the account the call is on. */
  chain: string;
  account?: unknown;
  derivationPath?: string;
  index?: number;
}

export type Extractor = (call: CallShape) => OperationRecord | null;

export class AdapterRegistry {
  private readonly packs = new Map<string, Map<string, Extractor>>();

  private key(walletType: string): Map<string, Extractor> {
    let pack = this.packs.get(walletType);
    if (!pack) {
      pack = new Map();
      this.packs.set(walletType, pack);
    }
    return pack;
  }

  /** Replaces the whole pack for a wallet type. */
  register(walletType: string, pack: Record<string, Extractor>): this {
    this.packs.set(walletType, new Map(Object.entries(pack)));
    return this;
  }

  /** Merges into the pack for a wallet type, method by method. */
  extend(walletType: string, pack: Record<string, Extractor>): this {
    const existing = this.key(walletType);
    for (const [method, extractor] of Object.entries(pack)) existing.set(method, extractor);
    return this;
  }

  /**
   * Turns a call into a PolicyOperationRecord. Throws PolicyAdapterError for a
   * missing extractor, a throwing one, or an incomplete record — every one of
   * which the engine treats as fail-closed.
   */
  toOperationRecord(call: CallShape): PolicyOperationRecord {
    const extractor = this.packs.get(call.walletType)?.get(call.method);
    if (!extractor) throw new PolicyAdapterError(`no extractor for ${call.walletType}.${call.method}`);
    let record: OperationRecord | null;
    try {
      record = extractor(call);
    } catch (err) {
      throw new PolicyAdapterError(`extractor for ${call.walletType}.${call.method} threw`, err);
    }
    if (!record || coerceAmount(record.amount) === undefined || !record.kind || !record.asset || !record.chain) {
      throw new PolicyAdapterError(`extractor for ${call.walletType}.${call.method} returned an incomplete record`);
    }
    return {
      ...record,
      raw: {
        walletType: call.walletType,
        method: call.method,
        args: call.args,
        account: call.account,
        derivationPath: call.derivationPath,
        index: call.index,
      },
    };
  }
}

/**
 * The EVM pack. `sendTransaction` re-derives from calldata; `swap` and
 * `bridge` re-derive from the protocol options (args[0]), since that is what
 * WDK's protocol methods receive. `transfer` is WDK's convenience for a
 * token transfer and is re-derived from its options the same way.
 */
export const evmExtractorPack: Record<string, Extractor> = {
  sendTransaction: (call) => {
    const [, chainId] = call.chain.split(':');
    const tx = call.args[0] as EvmCall | undefined;
    if (!chainId || !tx || typeof tx !== 'object') return null;
    return extractEvmOperation(chainId, tx);
  },
  transfer: (call) => {
    const [, chainId] = call.chain.split(':');
    const o = call.args[0] as { token?: unknown; recipient?: unknown; amount?: unknown } | undefined;
    if (!chainId || !o || typeof o !== 'object' || typeof o.token !== 'string' || typeof o.recipient !== 'string') return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.token) || !/^0x[0-9a-fA-F]{40}$/.test(o.recipient)) return null;
    const amount = coerceAmount(o.amount as string | number | bigint);
    if (amount === undefined) return null;
    return { kind: 'transfer', chain: call.chain, asset: o.token.toLowerCase(), amount: amount.toString(), destination: o.recipient.toLowerCase() };
  },
  swap: (call) => extractSwap(call.chain, { protocol: 'swap', options: call.args[0] as SwapCall['options'] }),
  bridge: (call) => extractBridge(call.chain, { protocol: 'bridge', options: call.args[0] as BridgeCall['options'] }),
};

/** The TRON pack: the native coin and TRC-20 transfers, by WDK's shared account shapes. */
export const tronExtractorPack: Record<string, Extractor> = {
  sendTransaction: (call) => {
    const [, chainId] = call.chain.split(':');
    const tx = call.args[0] as TronCall | undefined;
    if (!chainId || !tx || typeof tx !== 'object') return null;
    return extractTronOperation(chainId, tx);
  },
  transfer: (call) => {
    const [, chainId] = call.chain.split(':');
    const o = call.args[0] as TronCall | undefined;
    if (!chainId || !o || typeof o !== 'object') return null;
    return extractTronOperation(chainId, o);
  },
};

export function defaultAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry().register('evm', evmExtractorPack).register('tron', tronExtractorPack);
}

export { tronExtractorPack as tronPack };

// ─── The policy ──────────────────────────────────────────────────────────────

export interface SettlementSink {
  report(authorization: SignedSpendAuthorization, outcome: 'CONFIRMED' | 'REVERTED', txHash: string): Promise<void>;
}

export interface RemoteAuthorizationPolicyOptions {
  authorizer: Authorizer;
  /** Where commit/rollback report. Optional: without it the plane's expiry sweep releases budget. */
  settlement?: SettlementSink;
  /** Which kinds this policy speaks for. Default: all three. */
  kinds?: OperationRecord['kind'][];
}

function opKey(op: PolicyOperationRecord): string {
  return `${op.chain}|${op.kind}|${op.asset}|${op.destination ?? ''}|${op.amount}|${JSON.stringify(op.raw.args)}`;
}

export class RemoteAuthorizationPolicy extends TransactionPolicy {
  readonly id = 'flashyos-remote-authorization';
  /** Authorizations issued for operations this policy allowed, awaiting commit or rollback. */
  private readonly pending = new Map<string, SignedSpendAuthorization>();
  private readonly kinds: Set<string>;

  constructor(private readonly options: RemoteAuthorizationPolicyOptions) {
    super();
    this.kinds = new Set(options.kinds ?? ['transfer', 'swap', 'bridge']);
  }

  async match(op: PolicyOperationRecord): Promise<boolean> {
    return this.kinds.has(op.kind);
  }

  /**
   * allow  — the plane issued an authorization; it is held for commit/rollback.
   * deny   — the plane refused, or escalated to a human (a judgement, so a vote).
   * abstain — the plane could not be consulted. Not a vote; default-deny holds.
   */
  async evaluate(op: PolicyOperationRecord): Promise<PolicyVerdict> {
    const record: OperationRecord = { kind: op.kind, chain: op.chain, asset: op.asset, amount: op.amount, destination: op.destination };
    try {
      const verdict = await this.options.authorizer.propose(record);
      switch (verdict.verdict) {
        case 'ALLOW':
          this.pending.set(opKey(op), verdict.authorization);
          return { type: 'allow' };
        case 'DENY':
          return { type: 'deny', reason: `${verdict.code}: ${verdict.reason}` };
        case 'ESCALATE':
          return { type: 'deny', reason: `ESCALATED: decision ${verdict.decisionId} awaits a human at ${verdict.impact}` };
      }
    } catch (err) {
      if (err instanceof AuthorizerUnreachable) return { type: 'abstain', reason: `plane unreachable: ${err.message}` };
      if (err instanceof AuthorizerRefused) return { type: 'abstain', reason: `plane refused to answer: ${err.status}` };
      return { type: 'abstain', reason: `authorizer error: ${(err as Error)?.message ?? String(err)}` };
    }
  }

  async commit(op: PolicyOperationRecord, result: CommitResult): Promise<void> {
    const authorization = this.pending.get(opKey(op));
    this.pending.delete(opKey(op));
    if (authorization && this.options.settlement) {
      await this.options.settlement.report(authorization, 'CONFIRMED', result.txHash);
    }
  }

  async rollback(op: PolicyOperationRecord, reason: RollbackReason): Promise<void> {
    const authorization = this.pending.get(opKey(op));
    this.pending.delete(opKey(op));
    // Broadcast-and-reverted is a settlement the ledger must hear about.
    // Never-broadcast is not: the authorization simply expires unspent and
    // the plane's sweep returns the budget.
    if (authorization && reason.txHash && this.options.settlement) {
      await this.options.settlement.report(authorization, 'REVERTED', reason.txHash);
    }
  }

  /** Test seam and operator view: what is authorized but not yet settled. */
  pendingAuthorizations(): SignedSpendAuthorization[] {
    return [...this.pending.values()];
  }
}

// ─── Reference engine semantics ──────────────────────────────────────────────

export type EngineOutcome =
  | { execute: true }
  | { execute: false; code: 'RULE_DENIED' | 'NO_APPLICABLE_RULE'; reasons: string[] };

/**
 * The verdict semantics PR #88 documents, as a function, so the fail-closed
 * property is testable here rather than asserted about somebody else's code:
 * any deny refuses; otherwise at least one allow executes; abstains are not
 * votes, so a matched operation with nothing but abstains is NO_APPLICABLE_RULE.
 */
export async function evaluatePolicies(policies: TransactionPolicy[], op: PolicyOperationRecord): Promise<EngineOutcome> {
  const verdicts: PolicyVerdict[] = [];
  for (const policy of policies) {
    if (await policy.match(op)) verdicts.push(await policy.evaluate(op));
  }
  const denies = verdicts.filter((v): v is { type: 'deny'; reason: string } => v.type === 'deny');
  if (denies.length > 0) return { execute: false, code: 'RULE_DENIED', reasons: denies.map((d) => d.reason) };
  if (verdicts.some((v) => v.type === 'allow')) return { execute: true };
  return {
    execute: false,
    code: 'NO_APPLICABLE_RULE',
    reasons: verdicts.map((v) => (v.type === 'abstain' ? v.reason ?? 'abstained' : 'no vote')),
  };
}
