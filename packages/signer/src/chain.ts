// Chain backends. The signer executes an already-authorized OperationRecord
// through one of these; the backend never sees an authorization and never
// decides anything.
//
// MockChain is the backend the tests and the demos run against. WdkChain is
// the real one: Tether WDK's EVM wallet module, testnets only, with a receipt
// poller so "hash" is not mistaken for "confirmed", and WDK's own policy
// engine registered as a second line inside the process that holds the seed.

import { extractEip3009Operation, extractOperation, isProtocolCall, recordWithinAuthorization, type Eip712TypedData, type OperationRecord, type SignerCall } from '@flashyos/wallet-wdk';
import { ReceiptPoller, type Receipt } from './receipts';
import { assertTestnet, type Testnet } from './testnets';

export type ChainOutcome = 'CONFIRMED' | 'REVERTED';

export interface ChainResult {
  txHash: string;
  outcome: ChainOutcome;
}

export interface ChainBackend {
  readonly chain: string;
  /**
   * Executes a record the signer has already verified. `call` is the
   * original request, needed for swaps and bridges (the record deliberately
   * omits tokenOut, minAmountOut and the like); a backend must never take
   * amount, asset or destination from it — those come from `record`.
   * `options.accountIndex` selects which derived account acts — one per
   * agent (Phase 17); absent means the backend's default.
   */
  execute(record: OperationRecord, call?: SignerCall, options?: ExecuteOptions): Promise<ChainResult>;
  /**
   * Signs EIP-712 typed data the signer has already re-derived and matched
   * (Phase 18: an x402 payment is an EIP-3009 authorization signed off-chain).
   * Optional: a backend that cannot sign typed data leaves it undefined and
   * the signer refuses with TYPED_DATA_UNSUPPORTED.
   */
  signTypedData?(typedData: Eip712TypedData, options?: ExecuteOptions): Promise<TypedDataSignature>;
}

export interface ExecuteOptions {
  accountIndex?: number;
}

export interface TypedDataSignature {
  /** 65-byte secp256k1 signature, hex. */
  signature: string;
  /** The address that signed — the agent's account. */
  address: string;
}

/** Thrown by a backend whose account cannot sign typed data; the signer maps it to TYPED_DATA_UNSUPPORTED. */
export class TypedDataUnsupported extends Error {
  readonly code = 'TYPED_DATA_UNSUPPORTED' as const;
  constructor(detail: string) {
    super(`this backend cannot sign typed data: ${detail}`);
    this.name = 'TypedDataUnsupported';
  }
}

export interface MockChainOptions {
  chain?: string;
  /** Called per execution; return 'REVERTED' to simulate a failed transaction. */
  outcomeFor?: (record: OperationRecord, index: number) => ChainOutcome;
}

/** Records every execution and mints a deterministic tx hash. */
export class MockChain implements ChainBackend {
  readonly chain: string;
  readonly executions: { record: OperationRecord; result: ChainResult }[] = [];
  private readonly outcomeFor: NonNullable<MockChainOptions['outcomeFor']>;

  constructor(options: MockChainOptions = {}) {
    this.chain = options.chain ?? 'evm:8453';
    this.outcomeFor = options.outcomeFor ?? (() => 'CONFIRMED');
  }

  async execute(record: OperationRecord): Promise<ChainResult> {
    const index = this.executions.length;
    const result: ChainResult = {
      txHash: `0xmock${index.toString(16).padStart(60, '0')}`,
      outcome: this.outcomeFor(record, index),
    };
    this.executions.push({ record, result });
    return result;
  }

  /** Every typed-data signature the mock produced, with the index that "signed" it. */
  readonly signed: { typedData: Eip712TypedData; accountIndex: number; signature: string }[] = [];

  async signTypedData(typedData: Eip712TypedData, options: ExecuteOptions = {}): Promise<TypedDataSignature> {
    const accountIndex = options.accountIndex ?? 0;
    const n = this.signed.length;
    const signature = `0xmocksig${n.toString(16).padStart(56, '0')}${accountIndex.toString(16).padStart(2, '0')}`.padEnd(132, '0');
    this.signed.push({ typedData, accountIndex, signature });
    return { signature, address: `0x${accountIndex.toString(16).padStart(40, '0')}` };
  }
}

// ─── WDK ─────────────────────────────────────────────────────────────────────

/** The slice of WDK's surface this backend uses. Typed here so the package compiles without WDK installed. */
export interface WdkEvmTransaction {
  to: string;
  value: bigint;
  data?: string;
}

export interface WdkEvmAccount {
  getAddress(): Promise<string>;
  sendTransaction(tx: WdkEvmTransaction): Promise<{ hash: string; fee: bigint }>;
  /**
   * EIP-712. Present on WDK's EVM account; in wdk-wallet-evm beta.19 the
   * seed-derived signer throws NotImplementedError from it (verified in
   * signers/seed-signer-evm.js), which this backend reports as unsupported.
   */
  signTypedData?(typedData: { domain: object; types: object; message: object }): Promise<string>;
  /** Installed by WDK when a protocol is registered under that label. */
  getSwapProtocol?(label: string): WdkSwapProtocol;
  getBridgeProtocol?(label: string): WdkBridgeProtocol;
}

/** A WDK protocol to register for swaps or bridges: the class and its config, as `wdk.registerProtocol` takes them. */
export interface WdkProtocolRegistration {
  label: string;
  Protocol: unknown;
  config: object;
}

export interface WdkPolicyContext {
  operation: string;
  wallet: string;
  args: readonly unknown[];
}

export interface WdkSwapProtocol {
  swap(options: object): Promise<{ hash: string }>;
}
export interface WdkBridgeProtocol {
  bridge(options: object): Promise<{ hash: string }>;
}

export interface WdkInstance {
  registerWallet(blockchain: string, manager: unknown, config: object): WdkInstance;
  registerProtocol(blockchain: string, label: string, Protocol: unknown, config: object): WdkInstance;
  registerPolicy(policy: {
    id: string;
    name: string;
    scope: 'project';
    wallet: string;
    rules: { name: string; reason?: string; operation: string; action: 'ALLOW' | 'DENY'; conditions: ((ctx: WdkPolicyContext) => boolean | Promise<boolean>)[] }[];
  }): WdkInstance;
  getAccount(blockchain: string, index: number): Promise<WdkEvmAccount>;
  dispose(): void;
}

export interface WdkModules {
  WDK: new (seed: string, options?: object) => WdkInstance;
  WalletManagerEvm: unknown;
}

export interface WdkChainOptions {
  /** Must be one of TESTNETS; anything else throws at construction. */
  chain: string;
  /** BIP-39 seed phrase. Tier 0 sourcing; see docs/wallet/runbook.md for Tier 1+. */
  seedPhrase: string;
  /** Defaults to the testnet's public endpoint. Bring your own for anything that matters. */
  rpcUrl?: string;
  accountIndex?: number;
  receipts?: { confirmations?: number; pollMs?: number; timeoutMs?: number };
  /** Protocols for swaps and bridges. Without them, a swap or bridge record is refused by this backend. */
  protocols?: { swap?: WdkProtocolRegistration; bridge?: WdkProtocolRegistration };
  /** Test seam: supplies WDK instead of importing @tetherto/wdk. */
  modules?: () => Promise<WdkModules>;
  /** Test seam: replaces the JSON-RPC receipt poller. */
  poller?: { wait(txHash: string): Promise<Receipt> };
}

/** WDK's policy engine refused a call this backend made — which means this backend has a bug. Never a normal outcome. */
export class SecondLineRefusal extends Error {
  readonly code = 'SECOND_LINE_REFUSAL' as const;
  constructor(readonly denialCode: string, detail: string) {
    super(`WDK policy engine refused the signer's own call (${denialCode}): ${detail}`);
    this.name = 'SecondLineRefusal';
  }
}

export const SECOND_LINE_POLICY_ID = 'flashyos-signer-second-line';

const ERC20_TRANSFER = '0xa9059cbb';

/**
 * Executes through @tetherto/wdk with the EVM wallet module, on a testnet.
 *
 * Two lines of defence live here. The first is the signer's re-derivation,
 * which runs before this backend is called. The second is WDK's own policy
 * engine: this backend registers exactly one ALLOW rule — "sendTransaction,
 * and only the operation the signer is executing right now" — which makes
 * the account governed, and a governed WDK account is deny-by-default for
 * every other write: approve, transfer, signTypedData, delegate, anything.
 * A bug in this backend that tried to send something other than the
 * authorized record would meet that proxy and stop.
 *
 * Neither line is the boundary; see docs/wallet/threat-model.md §4.
 */
export class WdkChain implements ChainBackend {
  readonly chain: string;
  readonly testnet: Testnet;
  private wdkInstance: Promise<WdkInstance> | null = null;
  private readonly accounts = new Map<number, Promise<WdkEvmAccount>>();
  private wdk: WdkInstance | null = null;
  private inFlight: OperationRecord | null = null;
  private readonly poller: { wait(txHash: string): Promise<Receipt> };

  constructor(private readonly options: WdkChainOptions) {
    this.testnet = assertTestnet(options.chain, 'evm');
    this.chain = options.chain;
    this.poller = options.poller ?? new ReceiptPoller({ rpcUrl: options.rpcUrl ?? this.testnet.defaultRpcUrl, ...options.receipts });
  }

  private async modules(): Promise<WdkModules> {
    if (this.options.modules) return this.options.modules();
    try {
      const [wdk, evm] = await Promise.all([import('@tetherto/wdk' as string), import('@tetherto/wdk-wallet-evm' as string)]);
      return { WDK: wdk.default, WalletManagerEvm: evm.default };
    } catch (err) {
      throw new Error(`WdkChain requires @tetherto/wdk and @tetherto/wdk-wallet-evm to be installed: ${(err as Error).message}`);
    }
  }

  /**
   * True when what WDK is about to do is the operation this backend is
   * executing right now, and nothing else. The engine hands the rule the
   * operation name and its arguments; the same extractors the signer used
   * re-derive a record from them, and it must sit within the in-flight one.
   */
  private isInFlight(operation: string, arg: unknown): boolean {
    const current = this.inFlight;
    if (!current || !arg || typeof arg !== 'object') return false;
    if (operation === 'signTypedData') {
      // WDK's account takes { domain, types, message }; the primary type is implied by the single type in `types`.
      const record = extractEip3009Operation(this.chain, { primaryType: 'TransferWithAuthorization', ...(arg as object) });
      return record !== null && record.amount === current.amount && recordWithinAuthorization(record, { chain: current.chain, kind: current.kind, asset: current.asset, destination: current.destination, maxAmount: current.amount });
    }
    const call =
      operation === 'swap' ? { protocol: 'swap', options: arg }
      : operation === 'bridge' ? { protocol: 'bridge', options: arg }
      : (() => {
          const t = arg as { to?: unknown; value?: unknown; data?: unknown };
          return { to: t.to, value: typeof t.value === 'bigint' ? t.value.toString() : t.value, data: t.data };
        })();
    const record = extractOperation(this.chain, call);
    return (
      record !== null &&
      record.kind === current.kind &&
      record.amount === current.amount &&
      recordWithinAuthorization(record, { chain: current.chain, kind: current.kind, asset: current.asset, destination: current.destination, maxAmount: current.amount })
    );
  }

  private async instance(): Promise<WdkInstance> {
    if (!this.wdkInstance) {
      this.wdkInstance = (async () => {
        const { WDK, WalletManagerEvm } = await this.modules();
        const wdk = new WDK(this.options.seedPhrase).registerWallet('evm', WalletManagerEvm, {
          provider: this.options.rpcUrl ?? this.testnet.defaultRpcUrl,
          chainId: this.testnet.chainId!,
        });
        const { swap, bridge } = this.options.protocols ?? {};
        if (swap) wdk.registerProtocol('evm', swap.label, swap.Protocol, swap.config);
        if (bridge) wdk.registerProtocol('evm', bridge.label, bridge.Protocol, bridge.config);
        // WDK governs protocol methods too (verified: `swap` on a registered
        // protocol is intercepted as operation "swap"), so one rule per
        // operation the signer can execute, each conditioned on "in flight".
        wdk.registerPolicy({
          id: SECOND_LINE_POLICY_ID,
          name: 'Only the operation the FlashyOS signer is executing right now',
          scope: 'project',
          wallet: 'evm',
          rules: ['sendTransaction', 'swap', 'bridge', 'signTypedData'].map((operation) => ({
            name: `only-the-authorized-${operation}`,
            reason: 'the signer executes exactly one re-derived operation at a time; nothing else is permitted',
            operation,
            action: 'ALLOW' as const,
            conditions: [(ctx: WdkPolicyContext) => this.isInFlight(operation, ctx.args[0])],
          })),
        });
        this.wdk = wdk;
        return wdk;
      })();
    }
    return this.wdkInstance;
  }

  /**
   * The governed account for an index — one per agent (Phase 17), the
   * backend's default when none is given. Exposed so an operator (or a
   * test) can see the second line refuse, and read an agent's address.
   */
  async account(index: number = this.options.accountIndex ?? 0): Promise<WdkEvmAccount> {
    let account = this.accounts.get(index);
    if (!account) {
      account = this.instance().then((wdk) => wdk.getAccount('evm', index));
      this.accounts.set(index, account);
    }
    return account;
  }

  /** The address an index derives — what a Safe's owners add as that agent's delegate. */
  async address(index: number): Promise<string> {
    return (await this.account(index)).getAddress();
  }

  /** The transaction that performs a transfer record. */
  static transactionFor(record: OperationRecord): WdkEvmTransaction {
    if (record.kind !== 'transfer' || !record.destination) {
      throw new Error(`WdkChain: transactionFor is for transfers; ${record.kind} goes through a protocol`);
    }
    if (record.asset === 'native') return { to: record.destination, value: BigInt(record.amount) };
    return {
      to: record.asset,
      value: 0n,
      data: ERC20_TRANSFER + record.destination.replace(/^0x/, '').padStart(64, '0') + BigInt(record.amount).toString(16).padStart(64, '0'),
    };
  }

  /** Sends the in-flight operation through the right WDK surface. */
  private async broadcast(account: WdkEvmAccount, record: OperationRecord, call: SignerCall | undefined): Promise<string> {
    if (record.kind === 'transfer') return (await account.sendTransaction(WdkChain.transactionFor(record))).hash;
    // Swaps and bridges execute from the *call's* options — the record has no
    // tokenOut — but only after the options re-derive to the record, which
    // the signer already checked and the second line checks again.
    if (!call || !isProtocolCall(call) || call.protocol !== record.kind) {
      throw new Error(`WdkChain: a ${record.kind} needs its protocol call to execute`);
    }
    const registration = this.options.protocols?.[record.kind];
    if (!registration) throw new Error(`WdkChain: no ${record.kind} protocol registered for ${this.chain}`);
    if (record.kind === 'swap') {
      if (!account.getSwapProtocol) throw new Error('WdkChain: the account exposes no swap protocols');
      return (await account.getSwapProtocol(registration.label).swap(call.options)).hash;
    }
    if (!account.getBridgeProtocol) throw new Error('WdkChain: the account exposes no bridge protocols');
    return (await account.getBridgeProtocol(registration.label).bridge(call.options)).hash;
  }

  async execute(record: OperationRecord, call?: SignerCall, options: ExecuteOptions = {}): Promise<ChainResult> {
    if (record.chain !== this.chain) throw new Error(`WdkChain for ${this.chain} was handed a record for ${record.chain}`);
    const account = await this.account(options.accountIndex);

    let hash: string;
    this.inFlight = record;
    try {
      hash = await this.broadcast(account, record, call);
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      if (e?.name === 'PolicyViolationError') throw new SecondLineRefusal(e.code ?? 'UNKNOWN', e.message ?? '');
      throw err;
    } finally {
      this.inFlight = null;
    }

    // ReceiptTimeout propagates with the hash on it: broadcast, unconfirmed,
    // for the operator to reconcile. The signer records it as pending.
    const receipt = await this.poller.wait(hash);
    return { txHash: hash, outcome: receipt.outcome };
  }

  /**
   * Signs an EIP-3009 authorization the signer has matched. The typed data
   * re-derives to a record, which becomes the in-flight operation so the
   * second line admits exactly this signature and nothing else the account
   * could sign. Reports TypedDataUnsupported when the WDK account cannot.
   */
  async signTypedData(typedData: Eip712TypedData, options: ExecuteOptions = {}): Promise<TypedDataSignature> {
    const record = extractEip3009Operation(this.chain, typedData);
    if (!record) throw new Error('WdkChain: typed data is not a TransferWithAuthorization for this chain');
    const account = await this.account(options.accountIndex);
    if (!account.signTypedData) throw new TypedDataUnsupported('the account has no signTypedData');
    this.inFlight = record;
    try {
      const signature = await account.signTypedData({ domain: typedData.domain, types: typedData.types, message: typedData.message });
      return { signature, address: await account.getAddress() };
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      if (e?.name === 'PolicyViolationError') throw new SecondLineRefusal(e.code ?? 'UNKNOWN', e.message ?? '');
      if (e?.name === 'NotImplementedError' || /not implemented/i.test(e?.message ?? '')) throw new TypedDataUnsupported(e.message ?? 'NotImplementedError');
      throw err;
    } finally {
      this.inFlight = null;
    }
  }

  dispose(): void {
    this.wdk?.dispose();
    this.wdk = null;
    this.wdkInstance = null;
    this.accounts.clear();
  }
}
