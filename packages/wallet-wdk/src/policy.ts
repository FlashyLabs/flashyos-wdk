// A WDK policy rule that defers to the FlashyOS authorization plane.
//
// Integration point (b) from the brief: for a process that calls core WDK
// directly rather than through the MCP toolkit, WDK's policy conditions may be
// async, so a rule can ask the plane before the proxy lets a write through.
// Shape follows WDK's documented registerPolicy():
//
//   { name, operation, action: 'ALLOW', conditions: [async (ctx) => boolean] }
//
// where ctx is a frozen { operation, wallet, account, args }. WDK intercepts
// protocol methods as well as account methods (verified against
// @tetherto/wdk beta.18: a registered swap protocol's `swap` reaches the
// engine as operation "swap"), so one rule covers sendTransaction, transfer,
// swap and bridge, and the AdapterRegistry's packs re-derive the record
// from whichever arguments the operation takes.
//
// Two properties matter. The condition never throws — a thrown condition is
// an undefined outcome inside somebody else's engine, and an undefined outcome
// is not a refusal. And it returns true only for ALLOW: unreachable, refused,
// escalated and denied all resolve to false, which under WDK's default-deny
// is a PolicyViolationError with GOVERNED_BUT_UNMATCHED.
//
// This rule is a second line inside the process that holds WDK. It is not
// the boundary; see docs/wallet/threat-model.md §4.

import { type Authorizer } from './client';
import { familyOf } from './extractors/address';
import { AdapterRegistry, PolicyAdapterError, defaultAdapterRegistry } from './transactionPolicy';
import type { SignedSpendAuthorization } from './types';

export interface WdkPolicyContext {
  operation: string;
  wallet: string;
  account: unknown;
  args: unknown[];
}

export interface WdkRule {
  name: string;
  operation: string | string[];
  action: 'ALLOW' | 'DENY';
  conditions: Array<(ctx: WdkPolicyContext) => boolean | Promise<boolean>>;
}

/** The operations the rule vouches for. Anything else on a governed account is denied by WDK itself. */
export const REMOTE_RULE_OPERATIONS = ['sendTransaction', 'transfer', 'swap', 'bridge'] as const;

export interface RemoteRuleOptions {
  authorizer: Authorizer;
  /** The chain the governed wallet is on. Either `chain` (`<family>:<id>`) or the EVM `chainId`. */
  chain?: string;
  chainId?: string | number;
  /** Extractor packs; defaults to the EVM and TRON packs. */
  registry?: AdapterRegistry;
  /** Receives every issued authorization so the caller can hand it to a settlement reporter. */
  onAuthorized?: (authorization: SignedSpendAuthorization) => void;
  /** Receives every non-ALLOW outcome, for logging. Must not throw. */
  onRefused?: (detail: { code: string; reason: string }) => void;
}

function chainOf(options: RemoteRuleOptions): string {
  if (options.chain) return options.chain;
  if (options.chainId !== undefined) return `evm:${options.chainId}`;
  throw new Error('remoteAuthorizationRule needs `chain` or `chainId`');
}

export function remoteAuthorizationRule(options: RemoteRuleOptions): WdkRule {
  const chain = chainOf(options);
  const walletType = familyOf(chain);
  if (!walletType) throw new Error(`remoteAuthorizationRule: ${chain} is not a <family>:<chainId>`);
  const registry = options.registry ?? defaultAdapterRegistry();
  return {
    name: 'flashyos-remote-authorization',
    operation: [...REMOTE_RULE_OPERATIONS],
    action: 'ALLOW',
    conditions: [
      async (ctx) => {
        try {
          let record;
          try {
            // The registry's record carries `raw` (the arguments, which may hold
            // bigints); the plane gets the five fields it decides on.
            const { raw: _raw, ...fields } = registry.toOperationRecord({ walletType, method: ctx.operation, args: ctx.args ?? [], chain });
            record = fields;
          } catch (err) {
            const reason = err instanceof PolicyAdapterError ? err.message : 'call is not an operation this rule can vouch for';
            options.onRefused?.({ code: 'UNRECOGNISED_CALL', reason });
            return false;
          }
          const verdict = await options.authorizer.propose(record);
          if (verdict.verdict === 'ALLOW') {
            options.onAuthorized?.(verdict.authorization);
            return true;
          }
          if (verdict.verdict === 'DENY') options.onRefused?.({ code: verdict.code, reason: verdict.reason });
          else options.onRefused?.({ code: 'ESCALATED', reason: `decision ${verdict.decisionId} pending` });
          return false;
        } catch (err) {
          options.onRefused?.({ code: 'AUTHORIZER_ERROR', reason: (err as Error)?.message ?? String(err) });
          return false;
        }
      },
    ],
  };
}

/** Registers the rule on a WDK instance as a project-scoped policy. Typed loosely: WDK's types are its own. */
export function registerRemotePolicy(
  wdk: { registerPolicy: (policy: { id: string; name: string; scope: 'project' | 'account'; rules: WdkRule[] }) => unknown },
  options: RemoteRuleOptions,
): void {
  wdk.registerPolicy({
    id: 'flashyos-remote',
    name: 'Defer every write to the FlashyOS authorization plane',
    scope: 'project',
    rules: [remoteAuthorizationRule(options)],
  });
}
