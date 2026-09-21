// The seam to @tetherto/wdk-mcp-toolkit's confirmation step.
//
// Verified against the toolkit's source (tetherto/wdk-mcp-toolkit, main,
// 2026-09-19): before every write, a tool calls
//
//   server.requestConfirmation(message, requestedSchema)
//     → this.server.elicitInput({ message, requestedSchema })
//
// and proceeds only when the reply is `{ action: 'accept', content: { confirmed: true } }`.
// The `message` is human-readable text; the transaction itself is not in
// the elicitation. This file parses the two message formats the wallet
// tools produce today (`transfer` for tokens, `sendTransaction` for native
// value), reconstructs the call they describe, and lets the FlashyOS
// elicitation handler answer.
//
// What this is and is not. In the toolkit path the toolkit holds the seed and
// broadcasts; the plane is a gate in front of it, and the signer's
// re-derivation is not in the loop. The message and the broadcast are built
// from the same tool arguments inside the toolkit, so they agree unless the
// toolkit itself is compromised — and a compromised toolkit already has the
// seed. The plane's verdict is the *only* line here; docs/wallet/testnet.md
// says so under "Two ways to run".

import { createElicitationHandler, type ElicitationDecision, type ElicitationHandlerOptions, type PendingWrite } from './elicitation';
import type { EvmCall } from './extractors/evm';

export interface ToolkitConfirmation {
  /** The toolkit's chain name as passed to registerWallet, e.g. "ethereum", "base-sepolia". */
  chain: string;
  kind: 'token-transfer' | 'native-transfer';
  to: string;
  /** Base units, decimal string. */
  amount: string;
  /** Estimated fee in base units, as the toolkit printed it. */
  fee: string;
  /** Token symbol, for token transfers. */
  token?: string;
}

const TOKEN_TRANSFER_RE =
  /TOKEN TRANSFER CONFIRMATION REQUIRED\s+Token:\s*(?<token>\S+)\s+To:\s*(?<to>\S+)\s+Amount:\s*\S+\s+\S+\s*\((?<base>\d+)\s+base units\)\s+Estimated Fee:\s*(?<fee>\d+)[\s\S]*?broadcast to the (?<chain>\S+) network/;

const NATIVE_TRANSFER_RE =
  /(?<!TOKEN )TRANSACTION CONFIRMATION REQUIRED\s+To:\s*(?<to>\S+)\s+Amount:\s*(?<amount>\d+)\s+Estimated Fee:\s*(?<fee>\d+)\s+Total:\s*\d+[\s\S]*?broadcast to the (?<chain>\S+) network/;

/** Parses a toolkit confirmation message. Null for anything it does not recognise, and null means decline. */
export function parseToolkitConfirmation(message: string): ToolkitConfirmation | null {
  if (typeof message !== 'string') return null;
  const token = TOKEN_TRANSFER_RE.exec(message);
  if (token?.groups) {
    const { token: symbol, to, base, fee, chain } = token.groups;
    return { chain, kind: 'token-transfer', to, amount: base, fee, token: symbol };
  }
  const native = NATIVE_TRANSFER_RE.exec(message);
  if (native?.groups) {
    const { to, amount, fee, chain } = native.groups;
    return { chain, kind: 'native-transfer', to, amount, fee };
  }
  return null;
}

export interface ToolkitResolver {
  /** Toolkit chain name → the plane's `<family>:<chainId>`, or null when the chain is not one the plane governs. */
  chainId(chain: string): string | null;
  /** Token symbol on a chain → contract address, or null when unknown. The toolkit resolves symbols from its own list; this must agree with it. */
  tokenAddress(chain: string, symbol: string): string | null;
}

const ERC20_TRANSFER = '0xa9059cbb';

/** Reconstructs the call the toolkit is about to make. Null when anything needed is unknown. */
export function toPendingWrite(confirmation: ToolkitConfirmation, resolve: ToolkitResolver): PendingWrite | null {
  const chain = resolve.chainId(confirmation.chain);
  if (!chain) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(confirmation.to)) return null;
  let amount: bigint;
  try {
    amount = BigInt(confirmation.amount);
  } catch {
    return null;
  }
  if (confirmation.kind === 'native-transfer') {
    return { chain, call: { to: confirmation.to, value: amount.toString() } };
  }
  const token = resolve.tokenAddress(confirmation.chain, confirmation.token ?? '');
  if (!token) return null;
  const call: EvmCall = {
    to: token,
    value: '0',
    data: ERC20_TRANSFER + confirmation.to.slice(2).toLowerCase().padStart(64, '0') + amount.toString(16).padStart(64, '0'),
  };
  return { chain, call };
}

/** The reply shape `server.elicitInput` resolves with, per the MCP elicitation spec as the toolkit consumes it. */
export type ToolkitElicitationReply =
  | { action: 'accept'; content: { confirmed: true } }
  | { action: 'decline'; content?: undefined };

export interface ToolkitElicitationParams {
  message: string;
  requestedSchema?: unknown;
}

export interface ToolkitClientOptions extends ElicitationHandlerOptions {
  resolve: ToolkitResolver;
  /** Sees every decision, for the operator's log. Must not throw. */
  onDecision?: (params: ToolkitElicitationParams, decision: ElicitationDecision | { action: 'decline'; code: string; reason: string }) => void;
}

/**
 * Builds the function an MCP client installs to answer the toolkit's
 * elicitations. Fail closed: anything unparseable, unresolvable or refused
 * is a decline, and the toolkit then reports "cancelled by user. No funds
 * were spent."
 */
export function createToolkitElicitationClient(options: ToolkitClientOptions) {
  const handle = createElicitationHandler(options);
  return async function answerElicitation(params: ToolkitElicitationParams): Promise<ToolkitElicitationReply> {
    const confirmation = parseToolkitConfirmation(params?.message);
    if (!confirmation) {
      options.onDecision?.(params, { action: 'decline', code: 'UNRECOGNISED_ELICITATION', reason: 'not a confirmation message this client can vouch for' });
      return { action: 'decline' };
    }
    const pending = toPendingWrite(confirmation, options.resolve);
    if (!pending) {
      options.onDecision?.(params, { action: 'decline', code: 'UNRESOLVED_WRITE', reason: `cannot resolve ${confirmation.kind} on ${confirmation.chain}` });
      return { action: 'decline' };
    }
    const decision = await handle(pending);
    options.onDecision?.(params, decision);
    return decision.action === 'accept' ? { action: 'accept', content: { confirmed: true } } : { action: 'decline' };
  };
}
