// Phase 22 — `flashyos-run agent.mjs`: the object, pre-wired from the
// environment, handed to a module's default export.
//
//   export default async function (agent, org) { … }
//
// Five variables, each used only where it belongs:
//
//   FLASHYOS_API_URL        where FlashyOS is
//   FLASHYOS_ORG_ID         which organization
//   FLASHYOS_AGENT_NAME     which agent the module runs as
//   FLASHYOS_AGENT_TOKEN    that agent's token (agent verbs)
//   FLASHYOS_SESSION_TOKEN  optional — a human's session (human verbs)
//   FLASHYOS_SIGNER_URL     optional — the signer (execution)
//   FLASHYOS_AGENT_TOKENS   optional — `name=token,name=token` for more agents
//
// Every event the run emits is written to stdout as one JSON line, so a run
// is its own log. Nothing here holds authority: a missing token means the
// verbs that need it throw NO_CREDENTIAL, and the plane decides the rest.

import { FlashyEvents, type FlashyEvent } from './events';
import { HttpTransport } from './http';
import { FlashyOrganization } from './organization';
import type { FlashyAgent } from './agent';
import type { Transport } from './transport';

export interface RunEnv {
  FLASHYOS_API_URL?: string;
  FLASHYOS_ORG_ID?: string;
  FLASHYOS_AGENT_NAME?: string;
  FLASHYOS_AGENT_TOKEN?: string;
  FLASHYOS_SESSION_TOKEN?: string;
  FLASHYOS_SIGNER_URL?: string;
  FLASHYOS_AGENT_TOKENS?: string;
  FLASHYOS_EVENTS?: 'stdout' | 'silent';
}

export class RunConfigError extends Error {
  constructor(public readonly variable: string, detail: string) {
    super(`${variable}: ${detail}`);
    this.name = 'RunConfigError';
  }
}

export interface RunConfig {
  baseUrl: string;
  orgId: string;
  agentName: string;
  agentTokens: Record<string, string>;
  sessionToken?: string;
  signerUrl?: string;
  events: 'stdout' | 'silent';
}

/** Reads and validates the environment. Throws RunConfigError naming the first missing or malformed variable. */
export function configFromEnv(env: RunEnv): RunConfig {
  const need = (k: keyof RunEnv): string => {
    const v = env[k];
    if (typeof v !== 'string' || v.trim() === '') throw new RunConfigError(k, 'is required');
    return v.trim();
  };
  const baseUrl = need('FLASHYOS_API_URL');
  if (!/^https?:\/\//.test(baseUrl)) throw new RunConfigError('FLASHYOS_API_URL', 'must be an http(s) URL');
  const orgId = need('FLASHYOS_ORG_ID');
  const agentName = need('FLASHYOS_AGENT_NAME');
  const agentTokens: Record<string, string> = {};
  if (env.FLASHYOS_AGENT_TOKENS) {
    for (const pair of env.FLASHYOS_AGENT_TOKENS.split(',')) {
      const [name, token] = pair.split('=').map((s) => s.trim());
      if (!name || !token) throw new RunConfigError('FLASHYOS_AGENT_TOKENS', 'must be name=token pairs separated by commas');
      agentTokens[name] = token;
    }
  }
  if (env.FLASHYOS_AGENT_TOKEN) agentTokens[agentName] = env.FLASHYOS_AGENT_TOKEN.trim();
  if (!agentTokens[agentName] && !env.FLASHYOS_SESSION_TOKEN) {
    throw new RunConfigError('FLASHYOS_AGENT_TOKEN', `no token for ${agentName} and no FLASHYOS_SESSION_TOKEN; the run could do nothing`);
  }
  const events = env.FLASHYOS_EVENTS === 'silent' ? 'silent' : 'stdout';
  return { baseUrl, orgId, agentName, agentTokens, sessionToken: env.FLASHYOS_SESSION_TOKEN?.trim() || undefined, signerUrl: env.FLASHYOS_SIGNER_URL?.trim() || undefined, events };
}

export type AgentModule = { default: (agent: FlashyAgent, org: FlashyOrganization) => Promise<unknown> | unknown; agentName?: string };

export interface RunOptions {
  /** Replaces the HTTP transport — tests, or an in-process caller. */
  transport?: Transport;
  /** Where event lines go. Default: process.stdout when events are 'stdout'. */
  write?: (line: string) => void;
  fetch?: typeof fetch;
}

export interface RunResult {
  result: unknown;
  events: FlashyEvent[];
}

/**
 * Builds the organization and the agent from the config and runs the
 * module's default export with them. The module may export `agentName` to
 * run as a different agent than the environment names, provided the
 * transport holds that agent's token.
 */
export async function runAgentModule(mod: AgentModule, config: RunConfig, options: RunOptions = {}): Promise<RunResult> {
  if (typeof mod?.default !== 'function') throw new RunConfigError('module', 'must have a default export: async (agent, org) => …');
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const events = new FlashyEvents();
  if (config.events === 'stdout') events.on('*', (e) => write(JSON.stringify(e)));
  const transport = options.transport ?? new HttpTransport({ baseUrl: config.baseUrl, orgId: config.orgId, sessionToken: config.sessionToken, agentTokens: config.agentTokens, signerUrl: config.signerUrl, fetch: options.fetch });
  const org = new FlashyOrganization(transport, { events });
  const agentName = mod.agentName ?? config.agentName;
  const agent = org.agents.get(agentName);
  const result = await mod.default(agent, org);
  return { result, events: events.log };
}
