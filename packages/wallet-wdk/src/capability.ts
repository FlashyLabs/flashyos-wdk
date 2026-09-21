// The AAO WalletCapability.
//
// Deliberately thin, and deliberately shaped by the one real implementation
// rather than by a guess at three. The operation vocabulary is Tether's
// OperationRecord; what this interface adds is exactly what a wallet SDK does
// not and should not define — organizational authorization and its audit.
//
// Two things are missing on purpose. Setting an envelope and revoking one are
// administrative acts taken by a human with an org role; they have no agent
// path in FlashyOS by design, so they are not on the agent-facing capability.

import type { Authorizer } from './client';
import type { AuthorizationView, OperationRecord, Verdict } from './types';

export interface WalletCapability {
  /** Ask. The answer is a verdict, never a transaction. */
  propose(record: OperationRecord): Promise<Verdict>;
  /** What this agent has been authorized to do, most recent first. */
  authorizations(options?: { limit?: number }): Promise<AuthorizationView[]>;
}

/** The capability string registered against an agent in FlashyOS's AgentCapability table. */
export const WALLET_CAPABILITY = 'wallet' as const;

export class FlashyOSWalletCapability implements WalletCapability {
  constructor(private readonly authorizer: Authorizer) {}

  propose(record: OperationRecord): Promise<Verdict> {
    return this.authorizer.propose(record);
  }

  authorizations(options: { limit?: number } = {}): Promise<AuthorizationView[]> {
    return this.authorizer.authorizations(options);
  }
}
