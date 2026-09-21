// The chains this signer will talk to. Testnets only, by decision.
//
// There is no environment variable, flag or option that widens this list.
// Enabling a mainnet is a change to this file, made in a pull request, after
// the pilot gate in docs/wallet/runbook.md §6 has been met — not a deploy-time
// setting someone can flip. Every chain backend refuses to construct for
// anything else, so a mainnet chain id cannot reach a seed by mistake.

export type TestnetFamily = 'evm' | 'tron';

export interface Testnet {
  /** `<family>:<id>`, the plane's chain identifier. */
  chain: string;
  family: TestnetFamily;
  name: string;
  /** Numeric chain id, for EVM wallet modules. Absent for families that do not use one. */
  chainId?: number;
  /** A public endpoint; operators should bring their own. */
  defaultRpcUrl: string;
  explorer: string;
  /** Where to get test funds. */
  faucet: string;
}

export const TESTNETS: readonly Testnet[] = [
  {
    chain: 'evm:84532',
    family: 'evm',
    name: 'Base Sepolia',
    chainId: 84532,
    defaultRpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    faucet: 'https://docs.base.org/base-chain/tools/network-faucets',
  },
  {
    chain: 'evm:11155111',
    family: 'evm',
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    defaultRpcUrl: 'https://rpc.sepolia.org',
    explorer: 'https://sepolia.etherscan.io',
    faucet: 'https://sepoliafaucet.com',
  },
  {
    chain: 'evm:421614',
    family: 'evm',
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    defaultRpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorer: 'https://sepolia.arbiscan.io',
    faucet: 'https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info',
  },
  {
    chain: 'evm:11155420',
    family: 'evm',
    name: 'OP Sepolia',
    chainId: 11155420,
    defaultRpcUrl: 'https://sepolia.optimism.io',
    explorer: 'https://sepolia-optimism.etherscan.io',
    faucet: 'https://docs.optimism.io/app-developers/tools/build/faucets',
  },
  {
    chain: 'tron:nile',
    family: 'tron',
    name: 'TRON Nile',
    defaultRpcUrl: 'https://nile.trongrid.io',
    explorer: 'https://nile.tronscan.org',
    faucet: 'https://nileex.io/join/getJoinPage',
  },
  {
    chain: 'tron:shasta',
    family: 'tron',
    name: 'TRON Shasta',
    defaultRpcUrl: 'https://api.shasta.trongrid.io',
    explorer: 'https://shasta.tronscan.org',
    faucet: 'https://shasta.tronex.io',
  },
] as const;

export class MainnetNotEnabled extends Error {
  readonly code = 'MAINNET_NOT_ENABLED' as const;
  constructor(readonly chain: string) {
    super(
      `${chain} is not an enabled testnet. This signer talks to testnets only; ` +
        `enabling another chain is a reviewed change to packages/signer/src/testnets.ts, not a setting.`,
    );
    this.name = 'MainnetNotEnabled';
  }
}

export function findTestnet(chain: string): Testnet | null {
  return TESTNETS.find((t) => t.chain === chain) ?? null;
}

/** Returns the testnet, or throws MainnetNotEnabled. Never returns for anything not listed above. */
export function assertTestnet(chain: string, family?: TestnetFamily): Testnet {
  const testnet = findTestnet(chain);
  if (!testnet) throw new MainnetNotEnabled(chain);
  if (family && testnet.family !== family) {
    throw new Error(`${chain} is a ${testnet.family} testnet; this backend is for ${family}`);
  }
  return testnet;
}
