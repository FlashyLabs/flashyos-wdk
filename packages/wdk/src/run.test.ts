import { describe, it, expect } from 'vitest';
import { configFromEnv, runAgentModule, RunConfigError } from './run';
import type { Transport } from './transport';

// Phase 22 — the environment becomes a transport, the module gets the
// object, the run is its own log.

const env = { FLASHYOS_API_URL: 'https://api.flashyos.com', FLASHYOS_ORG_ID: 'org_1', FLASHYOS_AGENT_NAME: 'ops', FLASHYOS_AGENT_TOKEN: 'tok_ops' };

describe('configFromEnv', () => {
  it('reads the five variables and the optional ones', () => {
    const c = configFromEnv({ ...env, FLASHYOS_SIGNER_URL: 'http://signer:8787', FLASHYOS_AGENT_TOKENS: 'market=tok_m, treasury=tok_t', FLASHYOS_SESSION_TOKEN: 'sess' });
    expect(c).toEqual({ baseUrl: 'https://api.flashyos.com', orgId: 'org_1', agentName: 'ops', agentTokens: { market: 'tok_m', treasury: 'tok_t', ops: 'tok_ops' }, sessionToken: 'sess', signerUrl: 'http://signer:8787', events: 'stdout' });
    expect(configFromEnv({ ...env, FLASHYOS_EVENTS: 'silent' }).events).toBe('silent');
  });

  it('names the first missing or malformed variable', () => {
    expect(() => configFromEnv({})).toThrow(new RunConfigError('FLASHYOS_API_URL', 'is required'));
    expect(() => configFromEnv({ ...env, FLASHYOS_API_URL: 'api.flashyos.com' })).toThrow(/must be an http/);
    expect(() => configFromEnv({ ...env, FLASHYOS_AGENT_TOKEN: undefined })).toThrow(/no token for ops/);
    expect(() => configFromEnv({ ...env, FLASHYOS_AGENT_TOKENS: 'broken' })).toThrow(/name=token/);
    expect(() => configFromEnv({ ...env, FLASHYOS_AGENT_TOKEN: undefined, FLASHYOS_SESSION_TOKEN: 'sess' })).not.toThrow();
  });
});

describe('runAgentModule', () => {
  const transport = {
    orgId: 'org_1',
    propose: async () => ({ verdict: 'DENY' as const, code: 'NO_ENVELOPE', reason: 'none' }),
    capture: async () => {},
  } as unknown as Transport;

  it('hands the module the agent it names and the org, logs every event as a JSON line, and returns the result', async () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const mod = {
      default: async (agent: { name: string; wallet: { propose: (r: unknown) => Promise<unknown> }; memory: { record: (b: string) => Promise<void> } }, org: { orgId: string }) => {
        seen.push(agent.name, org.orgId);
        await agent.wallet.propose({ kind: 'transfer', chain: 'evm:84532', asset: 'native', amount: '1', destination: '0x7f3c000000000000000000000000000000000001' });
        await agent.memory.record('ran');
        return { done: true };
      },
    };
    const run = await runAgentModule(mod as never, configFromEnv(env), { transport, write: (l) => lines.push(l) });
    expect(seen).toEqual(['ops', 'org_1']);
    expect(run.result).toEqual({ done: true });
    expect(run.events.map((e) => e.type)).toEqual(['wallet.proposed', 'wallet.denied', 'memory.recorded']);
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['wallet.proposed', 'wallet.denied', 'memory.recorded']);
    expect(JSON.parse(lines[1])).toMatchObject({ orgId: 'org_1', agentName: 'ops', data: { code: 'NO_ENVELOPE' } });
  });

  it('a module may name its own agent; silent runs write nothing; a module without a default export is refused', async () => {
    const lines: string[] = [];
    const mod = { agentName: 'treasury', default: async (agent: { name: string }) => agent.name };
    const run = await runAgentModule(mod as never, { ...configFromEnv({ ...env, FLASHYOS_EVENTS: 'silent' }) }, { transport, write: (l) => lines.push(l) });
    expect(run.result).toBe('treasury');
    expect(lines).toEqual([]);
    await expect(runAgentModule({} as never, configFromEnv(env), { transport })).rejects.toThrow(/default export/);
  });

  it('without a transport it builds the HTTP one and a verb without its credential is NO_CREDENTIAL, before any request', async () => {
    let requests = 0;
    const fetchImpl = (async () => { requests += 1; return new Response('{}'); }) as unknown as typeof fetch;
    const mod = { default: async (_a: unknown, org: { authority: { list: () => Promise<unknown> } }) => org.authority.list() };
    await expect(runAgentModule(mod as never, configFromEnv({ ...env, FLASHYOS_EVENTS: 'silent' }), { fetch: fetchImpl })).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
    expect(requests).toBe(0);
  });
});
