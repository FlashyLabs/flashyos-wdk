// The TRON backend: @tetherto/wdk-wallet-tron on a TRON testnet, with the
// same second line as the EVM backend. This is the Phase 14½ proof that a
// new chain is one extractor pack and one backend, and nothing else: the
// plane, the object and the signer's re-derivation did not change.
//
// TRON's write surface at the WDK boundary is the shared account shape —
// `sendTransaction({ to, value })` for TRX, `transfer({ token, recipient,
// amount })` for TRC-20 — and both are governed operations, so the
// second-line rule covers both by name. Receipts come from the account's
// own `waitForTransaction`, since TRON speaks no eth_getTransactionReceipt.

import { extractOperation, recordWithinAuthorization, type OperationRecord, type SignerCall } from '@flashyos/wallet-wdk';
import { SecondLineRefusal, SECOND_LINE_POLICY_ID, type ChainBackend, type ChainOutcome, type ChainResult, type ExecuteOptions, type WdkPolicyContext } from './chain';
import { assertTestnet, type Testnet } from './testnets';

export interface WdkTronAccount {
  getAddress(): Promise<string>;
  sendTransaction(tx: { to: string; value: bigint | number | string }): Promise<{ hash: string }>;
  transfer(options: { token: string; recipient: string; amount: bigint | number | string }): Promise<{ hash: string }>;
  waitForTransaction(hash: string, options?: object): Promise<{ success?: boolean }>;
}

export interface WdkTronInstance {
  registerWallet(blockchain: string, manager: unknown, config: object): WdkTronInstance;
  registerPolicy(policy: object): WdkTronInstance;
  getAccount(blockchain: string, index: number): Promise<WdkTronAccount>;
  dispose(): void;
}

export interface WdkTronModules {
  WDK: new (seed: string, options?: object) => WdkTronInstance;
  WalletManagerTron: unknown;
}

export interface WdkTronChainOptions {
  /** `tron:nile` or `tron:shasta`; anything else throws at construction. */
  chain: string;
  seedPhrase: string;
  rpcUrl?: string;
  accountIndex?: number;
  /** Test seam: supplies WDK instead of importing @tetherto/wdk and the TRON module. */
  modules?: () => Promise<WdkTronModules>;
  /** Test seam: replaces the account's waitForTransaction. */
  confirm?: (account: WdkTronAccount, hash: string) => Promise<ChainOutcome>;
}

export class WdkTronChain implements ChainBackend {
  readonly chain: string;
  readonly testnet: Testnet;
  private wdkInstance: Promise<WdkTronInstance> | null = null;
  private readonly accounts = new Map<number, Promise<WdkTronAccount>>();
  private wdk: WdkTronInstance | null = null;
  private inFlight: OperationRecord | null = null;

  constructor(private readonly options: WdkTronChainOptions) {
    this.testnet = assertTestnet(options.chain, 'tron');
    this.chain = options.chain;
  }

  private async modules(): Promise<WdkTronModules> {
    if (this.options.modules) return this.options.modules();
    try {
      const [wdk, tron] = await Promise.all([import('@tetherto/wdk' as string), import('@tetherto/wdk-wallet-tron' as string)]);
      return { WDK: wdk.default, WalletManagerTron: tron.default };
    } catch (err) {
      throw new Error(`WdkTronChain requires @tetherto/wdk and @tetherto/wdk-wallet-tron to be installed: ${(err as Error).message}`);
    }
  }

  /** True when what WDK is about to do is the operation in flight, re-derived by the TRON extractor. */
  private isInFlight(operation: string, arg: unknown): boolean {
    const current = this.inFlight;
    if (!current || !arg || typeof arg !== 'object') return false;
    const a = arg as Record<string, unknown>;
    const call: SignerCall | null =
      operation === 'transfer'
        ? { token: String(a.token), recipient: String(a.recipient), amount: typeof a.amount === 'bigint' ? a.amount.toString() : (a.amount as string) }
        : operation === 'sendTransaction'
          ? { to: String(a.to), value: typeof a.value === 'bigint' ? a.value.toString() : (a.value as string) }
          : null;
    if (!call) return false;
    const record = extractOperation(this.chain, call);
    return (
      record !== null &&
      record.kind === current.kind &&
      record.amount === current.amount &&
      recordWithinAuthorization(record, { chain: current.chain, kind: current.kind, asset: current.asset, destination: current.destination, maxAmount: current.amount })
    );
  }

  private async instance(): Promise<WdkTronInstance> {
    if (!this.wdkInstance) {
      this.wdkInstance = (async () => {
        const { WDK, WalletManagerTron } = await this.modules();
        // Finding, recorded for upstream: on a governed account WDK's engine
        // also intercepts `waitForTransaction` — a read — and refuses it with
        // NO_APPLICABLE_RULE, so a backend that waits for its own receipt is
        // blocked by its own second line. Excluding it here is the documented
        // consumer-side remedy (`policyExclusions`); the EVM backend polls
        // JSON-RPC directly and never hit it.
        const wdk = new WDK(this.options.seedPhrase, { policyExclusions: ['waitForTransaction'] }).registerWallet('tron', WalletManagerTron, {
          provider: this.options.rpcUrl ?? this.testnet.defaultRpcUrl,
        });
        wdk.registerPolicy({
          id: SECOND_LINE_POLICY_ID,
          name: 'Only the operation the FlashyOS signer is executing right now',
          scope: 'project',
          wallet: 'tron',
          rules: ['sendTransaction', 'transfer'].map((operation) => ({
            name: `only-the-authorized-${operation}`,
            reason: 'the signer executes exactly one re-derived operation at a time; nothing else is permitted',
            operation,
            action: 'ALLOW',
            conditions: [(ctx: WdkPolicyContext) => this.isInFlight(operation, ctx.args[0])],
          })),
        });
        this.wdk = wdk;
        return wdk;
      })();
    }
    return this.wdkInstance;
  }

  /** The governed account for an index — one per agent; the backend's default when none is given. */
  async account(index: number = this.options.accountIndex ?? 0): Promise<WdkTronAccount> {
    let account = this.accounts.get(index);
    if (!account) {
      account = this.instance().then((wdk) => wdk.getAccount('tron', index));
      this.accounts.set(index, account);
    }
    return account;
  }

  async address(index: number): Promise<string> {
    return (await this.account(index)).getAddress();
  }

  async execute(record: OperationRecord, _call?: unknown, options: ExecuteOptions = {}): Promise<ChainResult> {
    if (record.chain !== this.chain) throw new Error(`WdkTronChain for ${this.chain} was handed a record for ${record.chain}`);
    if (record.kind !== 'transfer' || !record.destination) throw new Error(`WdkTronChain: ${record.kind} is not implemented in this backend`);
    const account = await this.account(options.accountIndex);

    let hash: string;
    this.inFlight = record;
    try {
      ({ hash } =
        record.asset === 'native'
          ? await account.sendTransaction({ to: record.destination, value: BigInt(record.amount) })
          : await account.transfer({ token: record.asset, recipient: record.destination, amount: BigInt(record.amount) }));
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      if (e?.name === 'PolicyViolationError') throw new SecondLineRefusal(e.code ?? 'UNKNOWN', e.message ?? '');
      throw err;
    } finally {
      this.inFlight = null;
    }

    const confirm = this.options.confirm ?? (async (acct: WdkTronAccount, h: string): Promise<ChainOutcome> => ((await acct.waitForTransaction(h)).success === false ? 'REVERTED' : 'CONFIRMED'));
    return { txHash: hash, outcome: await confirm(account, hash) };
  }

  dispose(): void {
    this.wdk?.dispose();
    this.wdk = null;
    this.wdkInstance = null;
    this.accounts.clear();
  }
}
