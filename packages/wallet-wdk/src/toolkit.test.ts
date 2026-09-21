import { describe, it, expect } from 'vitest';
import { createToolkitElicitationClient, parseToolkitConfirmation, toPendingWrite, type ToolkitResolver } from './toolkit';
import type { Authorizer } from './client';
import type { SignedSpendAuthorization, Verdict } from './types';

// The two confirmation messages are copied verbatim from
// tetherto/wdk-mcp-toolkit src/tools/wallet/transfer.js and sendTransaction.js
// (main, 2026-09-19), with the template values filled the way those tools
// fill them. If the toolkit changes its wording these fixtures — and the
// parser — must change with it; that is the point of pinning them.

const USDT_BASE_SEPOLIA = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const VENDOR = '0x7f3C000000000000000000000000000000000001';

const TOKEN_MESSAGE = `⚠️  TOKEN TRANSFER CONFIRMATION REQUIRED

Token: USDT
To: ${VENDOR}
Amount: 12.5 USDT (12500000 base units)
Estimated Fee: 21000

This transfer is IRREVERSIBLE once broadcast to the base-sepolia network.

Do you want to proceed with this transfer?`;

const NATIVE_MESSAGE = `⚠️  TRANSACTION CONFIRMATION REQUIRED

To: ${VENDOR}
Amount: 1000000000000
Estimated Fee: 21000
Total: 1000000021000

This transaction is IRREVERSIBLE once broadcast to the base-sepolia network.

Do you want to proceed with this transaction?`;

const SIGN_MESSAGE = `⚠️  SIGNATURE CONFIRMATION REQUIRED

Message: hello

Do you want to sign this message?`;

const resolve: ToolkitResolver = {
  chainId: (chain) => ({ 'base-sepolia': 'evm:84532', base: 'evm:8453' })[chain] ?? null,
  tokenAddress: (chain, symbol) => (chain === 'base-sepolia' && symbol === 'USDT' ? USDT_BASE_SEPOLIA : null),
};

describe('parseToolkitConfirmation', () => {
  it('reads a token transfer: symbol, payee, base-unit amount, fee, chain', () => {
    expect(parseToolkitConfirmation(TOKEN_MESSAGE)).toEqual({
      chain: 'base-sepolia', kind: 'token-transfer', token: 'USDT', to: VENDOR, amount: '12500000', fee: '21000',
    });
  });

  it('reads a native transfer', () => {
    expect(parseToolkitConfirmation(NATIVE_MESSAGE)).toEqual({ chain: 'base-sepolia', kind: 'native-transfer', to: VENDOR, amount: '1000000000000', fee: '21000' });
  });

  it('does not mistake a signature confirmation, or anything else, for a transfer', () => {
    expect(parseToolkitConfirmation(SIGN_MESSAGE)).toBeNull();
    expect(parseToolkitConfirmation('Do you want to proceed?')).toBeNull();
    expect(parseToolkitConfirmation('')).toBeNull();
    expect(parseToolkitConfirmation(undefined as unknown as string)).toBeNull();
  });

  it('takes the base-unit amount, never the human one', () => {
    const tricky = TOKEN_MESSAGE.replace('12.5 USDT (12500000 base units)', '0.01 USDT (12500000 base units)');
    expect(parseToolkitConfirmation(tricky)?.amount).toBe('12500000');
  });
});

describe('toPendingWrite', () => {
  it('rebuilds the ERC-20 transfer call the toolkit will make', () => {
    const pending = toPendingWrite(parseToolkitConfirmation(TOKEN_MESSAGE)!, resolve);
    expect(pending).toEqual({
      chain: 'evm:84532',
      call: { to: USDT_BASE_SEPOLIA, value: '0', data: '0xa9059cbb' + VENDOR.slice(2).toLowerCase().padStart(64, '0') + (12_500_000n).toString(16).padStart(64, '0') },
    });
  });

  it('rebuilds a native send', () => {
    expect(toPendingWrite(parseToolkitConfirmation(NATIVE_MESSAGE)!, resolve)).toEqual({ chain: 'evm:84532', call: { to: VENDOR, value: '1000000000000' } });
  });

  it('is null — and so a decline — for a chain or token the operator did not map', () => {
    const onEthereum = parseToolkitConfirmation(TOKEN_MESSAGE.replace('base-sepolia', 'ethereum'))!;
    expect(toPendingWrite(onEthereum, resolve)).toBeNull();
    const unknownToken = parseToolkitConfirmation(TOKEN_MESSAGE.replace('Token: USDT', 'Token: XAUT').replace('12.5 USDT', '12.5 XAUT'))!;
    expect(toPendingWrite(unknownToken, resolve)).toBeNull();
    expect(toPendingWrite({ ...parseToolkitConfirmation(NATIVE_MESSAGE)!, to: 'not-an-address' }, resolve)).toBeNull();
  });
});

describe('createToolkitElicitationClient', () => {
  const authorization = { id: 'auth_1', sig: 'x' } as unknown as SignedSpendAuthorization;
  function authorizer(verdict: Verdict): Authorizer & { proposed: unknown[] } {
    const proposed: unknown[] = [];
    return {
      proposed,
      propose: async (record: unknown) => { proposed.push(record); return verdict; },
      authorizations: async () => [],
    } as unknown as Authorizer & { proposed: unknown[] };
  }

  it('answers accept + confirmed:true when the plane allows, with the record it re-derived', async () => {
    const a = authorizer({ verdict: 'ALLOW', authorization, decisionId: 'dec_1' });
    const answer = createToolkitElicitationClient({ authorizer: a, resolve });
    expect(await answer({ message: TOKEN_MESSAGE, requestedSchema: {} })).toEqual({ action: 'accept', content: { confirmed: true } });
    expect(a.proposed[0]).toEqual({ kind: 'transfer', chain: 'evm:84532', asset: USDT_BASE_SEPOLIA, amount: '12500000', destination: VENDOR.toLowerCase() });
  });

  it('declines on DENY, on ESCALATE without a wait, and on anything unparseable — never touching the plane for the last', async () => {
    const denied = authorizer({ verdict: 'DENY', code: 'PER_TX_CAP', reason: 'over' });
    expect(await createToolkitElicitationClient({ authorizer: denied, resolve })({ message: TOKEN_MESSAGE })).toEqual({ action: 'decline' });

    const escalated = authorizer({ verdict: 'ESCALATE', decisionId: 'dec_2', reservationId: 'rsv', impact: 'MEDIUM' });
    expect(await createToolkitElicitationClient({ authorizer: escalated, resolve })({ message: NATIVE_MESSAGE })).toEqual({ action: 'decline' });

    const untouched = authorizer({ verdict: 'ALLOW', authorization, decisionId: 'dec_1' });
    const decisions: unknown[] = [];
    const answer = createToolkitElicitationClient({ authorizer: untouched, resolve, onDecision: (_p, d) => decisions.push(d) });
    expect(await answer({ message: SIGN_MESSAGE })).toEqual({ action: 'decline' });
    expect(untouched.proposed).toHaveLength(0);
    expect(decisions[0]).toMatchObject({ action: 'decline', code: 'UNRECOGNISED_ELICITATION' });
  });

  it('declines when the plane is unreachable', async () => {
    const { AuthorizerUnreachable } = await import('./client');
    const down = { propose: async () => { throw new AuthorizerUnreachable('down'); }, authorizations: async () => [] } as unknown as Authorizer;
    expect(await createToolkitElicitationClient({ authorizer: down, resolve })({ message: TOKEN_MESSAGE })).toEqual({ action: 'decline' });
  });
});
