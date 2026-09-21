// The FlashyOS authorizer, as seen from an agent runtime or a signer.
//
// One deliberate property: an unreachable plane is a distinguishable error,
// not a verdict. Callers that must fail closed (the elicitation handler, the
// policy rule) catch AuthorizerUnreachable and refuse; they never treat a
// network failure as anything but a reason to do nothing.

import type { AuthorizationView, OperationRecord, Verdict } from './types';

export interface AuthorizerOptions {
  /** e.g. https://api.flashyos.com */
  baseUrl: string;
  orgId: string;
  /** An agent token holding wallet:propose (and wallet:read for the audit surface). */
  agentToken: string;
  /** Milliseconds before a request is abandoned. Default 10 000. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export class AuthorizerUnreachable extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AuthorizerUnreachable';
  }
}

export class AuthorizerRefused extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AuthorizerRefused';
  }
}

export interface Authorizer {
  propose(record: OperationRecord): Promise<Verdict>;
  authorizations(options?: { limit?: number }): Promise<AuthorizationView[]>;
  publicKeyPem(): Promise<string>;
}

export class FlashyOSAuthorizer implements Authorizer {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: AuthorizerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/api/v1/orgs/${this.options.orgId}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.agentToken}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new AuthorizerUnreachable(`authorization plane unreachable: ${(err as Error)?.message ?? err}`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async propose(record: OperationRecord): Promise<Verdict> {
    const res = await this.request('/wallet/proposals', { method: 'POST', body: JSON.stringify(record) });
    // 201 ALLOW, 202 ESCALATE, 200 DENY are all verdicts. Anything else is
    // the plane refusing to answer — a bad token, a rate limit — and is
    // surfaced as an error so a caller never mistakes it for a decision.
    if (res.status === 200 || res.status === 201 || res.status === 202) {
      return (await res.json()) as Verdict;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new AuthorizerRefused(res.status, body.error ?? `HTTP ${res.status}`);
  }

  async authorizations(options: { limit?: number } = {}): Promise<AuthorizationView[]> {
    const res = await this.request(`/wallet/authorizations?limit=${options.limit ?? 100}`);
    if (!res.ok) throw new AuthorizerRefused(res.status, `HTTP ${res.status}`);
    return ((await res.json()) as { authorizations: AuthorizationView[] }).authorizations;
  }

  async publicKeyPem(): Promise<string> {
    const res = await this.request('/wallet/authorizations?limit=1');
    if (!res.ok) throw new AuthorizerRefused(res.status, `HTTP ${res.status}`);
    return ((await res.json()) as { publicKey: string }).publicKey;
  }
}
