import { describe, it, expect } from 'vitest';
import { FlashyOSAuthorizer, AuthorizerRefused, AuthorizerUnreachable } from './client';

const record = { kind: 'transfer' as const, chain: 'evm:8453', asset: 'native', amount: '1', destination: '0x7f3c000000000000000000000000000000000001' };

function fakeFetch(status: number, body: unknown, capture?: (input: string, init: RequestInit) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    capture?.(String(input), init ?? {});
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('FlashyOSAuthorizer', () => {
  it('posts the record to the org\'s proposals route with the bearer token', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const client = new FlashyOSAuthorizer({
      baseUrl: 'https://api.flashyos.com/',
      orgId: 'org_1',
      agentToken: 'tok',
      fetch: fakeFetch(200, { verdict: 'DENY', code: 'NO_ENVELOPE', reason: 'none' }, (url, init) => { seen = { url, init }; }),
    });
    await client.propose(record);
    expect(seen!.url).toBe('https://api.flashyos.com/api/v1/orgs/org_1/wallet/proposals');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(seen!.init.body as string)).toEqual(record);
  });

  it.each([200, 201, 202])('treats HTTP %s as a verdict', async (status) => {
    const client = new FlashyOSAuthorizer({ baseUrl: 'x', orgId: 'o', agentToken: 't', fetch: fakeFetch(status, { verdict: 'DENY', code: 'DAILY_CAP', reason: 'r' }) });
    await expect(client.propose(record)).resolves.toMatchObject({ verdict: 'DENY' });
  });

  it('surfaces any other status as AuthorizerRefused, never as a verdict', async () => {
    const client = new FlashyOSAuthorizer({ baseUrl: 'x', orgId: 'o', agentToken: 't', fetch: fakeFetch(401, { error: 'bad token' }) });
    await expect(client.propose(record)).rejects.toBeInstanceOf(AuthorizerRefused);
  });

  it('surfaces a network failure as AuthorizerUnreachable', async () => {
    const client = new FlashyOSAuthorizer({
      baseUrl: 'x', orgId: 'o', agentToken: 't',
      fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    });
    await expect(client.propose(record)).rejects.toBeInstanceOf(AuthorizerUnreachable);
  });

  it('abandons a request that exceeds the timeout', async () => {
    const client = new FlashyOSAuthorizer({
      baseUrl: 'x', orgId: 'o', agentToken: 't', timeoutMs: 20,
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as typeof fetch,
    });
    await expect(client.propose(record)).rejects.toBeInstanceOf(AuthorizerUnreachable);
  });

  it('reads the audit listing and the public key', async () => {
    const client = new FlashyOSAuthorizer({ baseUrl: 'x', orgId: 'o', agentToken: 't', fetch: fakeFetch(200, { authorizations: [{ id: 'a' }], publicKey: '-----BEGIN PUBLIC KEY-----' }) });
    expect(await client.authorizations()).toEqual([{ id: 'a' }]);
    expect(await client.publicKeyPem()).toContain('BEGIN PUBLIC KEY');
  });
});
