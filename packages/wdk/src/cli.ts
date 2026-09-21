#!/usr/bin/env node
// flashyos-run <module> — run an agent module with the object pre-wired
// from the environment. See ./run.ts for the variables. A TypeScript module
// runs under a loader that handles it (`node --import tsx`), or compiled.

import { pathToFileURL } from 'url';
import { resolve } from 'path';
import { configFromEnv, runAgentModule, RunConfigError, type AgentModule } from './run';

async function main(argv: string[]): Promise<number> {
  const target = argv[2];
  if (!target || target === '--help' || target === '-h') {
    process.stderr.write(
      [
        'usage: flashyos-run <agent-module>',
        '',
        '  The module\'s default export is called as (agent, org).',
        '  Environment: FLASHYOS_API_URL, FLASHYOS_ORG_ID, FLASHYOS_AGENT_NAME, FLASHYOS_AGENT_TOKEN',
        '  Optional:    FLASHYOS_SESSION_TOKEN, FLASHYOS_SIGNER_URL, FLASHYOS_AGENT_TOKENS, FLASHYOS_EVENTS=silent',
        '',
      ].join('\n'),
    );
    return target ? 0 : 2;
  }
  let config;
  try {
    config = configFromEnv(process.env as Record<string, string | undefined>);
  } catch (err) {
    if (err instanceof RunConfigError) {
      process.stderr.write(`flashyos-run: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  const mod = (await import(pathToFileURL(resolve(process.cwd(), target)).href)) as AgentModule;
  const { result } = await runAgentModule(mod, config);
  if (result !== undefined) process.stdout.write(JSON.stringify({ type: 'run.result', result }) + '\n');
  return 0;
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`flashyos-run: ${(err as Error)?.stack ?? err}\n`);
    process.exit(1);
  },
);
