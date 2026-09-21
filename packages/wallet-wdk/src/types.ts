// Wire types shared with the FlashyOS authorization plane.
//
// Kept as a small, dependency-free copy rather than imported from
// packages/api: this package is consumed by agent runtimes and signers that
// must not carry the API's dependencies. The JSON schemas under
// docs/wallet/schema/ are the contract both sides are tested against.

/** `meter` exists only at the plane (a reserved cap spent by the unit); a signer never sees one — the close is a transfer. */
export type OperationKind = 'transfer' | 'swap' | 'bridge' | 'meter';

export interface OperationRecord {
  kind: OperationKind;
  /** `<family>:<chainId>`, e.g. `evm:8453`. */
  chain: string;
  /** Exact contract address, or `native`. */
  asset: string;
  /** Non-negative integer in base units, as a decimal string. */
  amount: string;
  /** Exact address; `null` only for an internal swap. */
  destination: string | null;
  raw?: Record<string, unknown>;
}

export const NATIVE_ASSET = 'native' as const;

export type DenialCode =
  | 'SCOPE_MISSING'
  | 'NO_ENVELOPE'
  | 'ENVELOPE_INACTIVE'
  | 'KIND_NOT_PERMITTED'
  | 'ASSET_NOT_PERMITTED'
  | 'DESTINATION_NOT_PERMITTED'
  | 'PER_TX_CAP'
  | 'DAILY_CAP'
  | 'INVALID_AMOUNT'
  | 'INVALID_RECORD';

export type EscalationImpact = 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SignedSpendAuthorization {
  id: string;
  orgId: string;
  agentName: string;
  chain: string;
  kind: OperationKind;
  asset: string;
  maxAmount: string;
  destination: string | null;
  reservationId: string;
  decisionId: string;
  issuedAt: string;
  expiresAt: string;
  sig: string;
}

export type Verdict =
  | { verdict: 'ALLOW'; authorization: SignedSpendAuthorization; decisionId: string }
  | { verdict: 'ESCALATE'; decisionId: string; reservationId: string; impact: EscalationImpact }
  | { verdict: 'DENY'; code: DenialCode; reason: string };

export interface AuthorizationView {
  id: string;
  orgId: string;
  agentName: string;
  chain: string;
  kind: string;
  asset: string;
  maxAmount: string;
  destination: string | null;
  status: 'ISSUED' | 'SPENT' | 'EXPIRED' | 'REVOKED';
  decisionId: string;
  reservationId: string;
  issuedAt: string;
  expiresAt: string;
  spentAt: string | null;
  txHash: string | null;
  /** Present only on the owning agent's own listing. */
  sig?: string;
}
