// Answering Tether's MCP elicitation with a verdict instead of a click.
//
// @tetherto/wdk-mcp-toolkit stops before every write and asks its client to
// approve. Today a person answers. This handler answers instead: it derives
// the OperationRecord from the pending call, proposes it to the FlashyOS
// authorization plane, and turns the verdict into accept or decline. A human
// is still consulted — through the plane's Decision ladder — but only for the
// writes that grade high enough to warrant it.
//
// Fail closed, always. An unreachable plane, an unrecognised call, an
// escalation that does not resolve in time: every one of those is a decline.
// The handler has no path by which an error becomes an approval.
//
// The toolkit's exact elicitation message shape is confirmed at integration
// time, not assumed here; this handler is shaped around the fields any write
// needs (which chain, what call), and an adapter maps the toolkit's message
// onto PendingWrite.

import { AuthorizerRefused, AuthorizerUnreachable, type Authorizer } from './client';
import { extractOperation, type SignerCall } from './extractors/index';
import type { OperationRecord, SignedSpendAuthorization } from './types';

export interface PendingWrite {
  /** `<family>:<chainId>`, e.g. `evm:8453`. */
  chain: string;
  /** An EVM or TRON transaction, or a swap/bridge protocol call; see extractors/. */
  call: SignerCall;
}

export type ElicitationDecision =
  | { action: 'accept'; authorization: SignedSpendAuthorization }
  | { action: 'decline'; code: string; reason: string; decisionId?: string };

export interface ElicitationHandlerOptions {
  authorizer: Authorizer;
  /** Override the extractor, e.g. to add a chain family. Default handles evm:*. */
  extract?: (pending: PendingWrite) => OperationRecord | null;
  /**
   * When set, an ESCALATE verdict is followed by polling the agent's own
   * authorizations until one for that decision is ISSUED, or until timeout.
   * Unset, an escalation is an immediate decline carrying the decisionId, and
   * the caller decides when to ask again.
   */
  waitForDecision?: { timeoutMs: number; pollMs: number };
  /** Injectable clock and sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function defaultExtract(pending: PendingWrite): OperationRecord | null {
  return extractOperation(pending.chain, pending.call);
}

export function createElicitationHandler(options: ElicitationHandlerOptions) {
  const extract = options.extract ?? defaultExtract;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function awaitIssued(decisionId: string): Promise<SignedSpendAuthorization | null> {
    const wait = options.waitForDecision;
    if (!wait) return null;
    const deadline = now() + wait.timeoutMs;
    while (now() < deadline) {
      let list;
      try {
        list = await options.authorizer.authorizations({ limit: 50 });
      } catch {
        return null; // unreachable while waiting: fail closed
      }
      const issued = list.find((a) => a.decisionId === decisionId && a.status === 'ISSUED' && a.sig);
      if (issued && issued.sig) {
        // Every field the plane signed, including orgId: the signer
        // canonicalizes exactly this object, so a missing field is a bad
        // signature.
        return {
          id: issued.id,
          orgId: issued.orgId,
          agentName: issued.agentName,
          chain: issued.chain,
          kind: issued.kind as SignedSpendAuthorization['kind'],
          asset: issued.asset,
          maxAmount: issued.maxAmount,
          destination: issued.destination,
          reservationId: issued.reservationId,
          decisionId: issued.decisionId,
          issuedAt: issued.issuedAt,
          expiresAt: issued.expiresAt,
          sig: issued.sig,
        };
      }
      if (list.some((a) => a.decisionId === decisionId && a.status !== 'ISSUED')) return null;
      await sleep(wait.pollMs);
    }
    return null;
  }

  return async function handleElicitation(pending: PendingWrite): Promise<ElicitationDecision> {
    const record = extract(pending);
    if (!record) {
      return { action: 'decline', code: 'UNRECOGNISED_CALL', reason: 'the pending call is not an operation this handler can vouch for' };
    }

    let verdict;
    try {
      verdict = await options.authorizer.propose(record);
    } catch (err) {
      if (err instanceof AuthorizerUnreachable) {
        return { action: 'decline', code: 'AUTHORIZER_UNREACHABLE', reason: err.message };
      }
      if (err instanceof AuthorizerRefused) {
        return { action: 'decline', code: 'AUTHORIZER_REFUSED', reason: `${err.status}: ${err.message}` };
      }
      throw err;
    }

    switch (verdict.verdict) {
      case 'ALLOW':
        return { action: 'accept', authorization: verdict.authorization };
      case 'DENY':
        return { action: 'decline', code: verdict.code, reason: verdict.reason };
      case 'ESCALATE': {
        const issued = await awaitIssued(verdict.decisionId);
        if (issued) return { action: 'accept', authorization: issued };
        return {
          action: 'decline',
          code: 'ESCALATED',
          reason: `awaiting a human decision at ${verdict.impact}`,
          decisionId: verdict.decisionId,
        };
      }
    }
  };
}
