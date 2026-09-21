// One event system. Every verb the object performs emits exactly one event
// with a JSON-serializable payload, so the thirtieth integration sees the
// same agent as the first, and so a log of events is a log of what the
// organization's agents did.

/** Every event the object can emit — published as docs/wallet/schema/events.json, drift-checked by test. */
export const FLASHY_EVENT_TYPES = [
  'agent.created',
  'envelope.set',
  'envelope.revoked',
  'delegation.created',
  'delegation.revoked',
  'wallet.proposed',
  'wallet.allowed',
  'wallet.escalated',
  'wallet.denied',
  'wallet.executed',
  'wallet.refused',
  'decision.resolved',
  'invoice.issued',
  'settlement.attempted',
  'memory.recorded',
  'identity.assigned',
  'meter.opened',
  'meter.ticked',
  'meter.closed',
  'meter.refused',
  'invoice.paid',
  'payment.signed',
  'provenance.sealed',
  'plane.trusted',
  'plane.revoked',
  'key.rotated',
  'invoice.signed',
  'invoice.voided',
  'receipt.accepted',
  'x402.received',
] as const;

export type FlashyEventType = (typeof FLASHY_EVENT_TYPES)[number];

export interface FlashyEvent {
  type: FlashyEventType;
  /** ISO timestamp. */
  at: string;
  orgId: string;
  agentName?: string;
  data: Record<string, unknown>;
}

export type FlashyEventHandler = (event: FlashyEvent) => void;

export class FlashyEvents {
  private readonly handlers = new Map<FlashyEventType | '*', Set<FlashyEventHandler>>();
  /** Every event emitted, in order. Bounded by `keep`; the oldest fall off. */
  readonly log: FlashyEvent[] = [];

  constructor(private readonly options: { keep?: number; now?: () => Date } = {}) {}

  on(type: FlashyEventType | '*', handler: FlashyEventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit(type: FlashyEventType, orgId: string, agentName: string | undefined, data: Record<string, unknown>): FlashyEvent {
    const event: FlashyEvent = { type, at: (this.options.now ?? (() => new Date()))().toISOString(), orgId, ...(agentName ? { agentName } : {}), data };
    this.log.push(event);
    const keep = this.options.keep ?? 10_000;
    if (this.log.length > keep) this.log.splice(0, this.log.length - keep);
    for (const handler of [...(this.handlers.get(type) ?? []), ...(this.handlers.get('*') ?? [])]) {
      // A listener's failure is its own; it never stops the verb that emitted.
      try {
        handler(event);
      } catch {
        /* deliberately swallowed */
      }
    }
    return event;
  }

  /** Counts by type — the shape a closing frame is made of. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.log) out[e.type] = (out[e.type] ?? 0) + 1;
    return out;
  }
}
