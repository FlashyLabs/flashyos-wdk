import { describe, it, expect } from 'vitest';
import { assertTestnet, findTestnet, MainnetNotEnabled, TESTNETS } from './testnets';

describe('testnets', () => {
  it('lists only chains whose ids are known testnets, each fully described', () => {
    const MAINNET_IDS = new Set([1, 8453, 42161, 10, 137, 56, 43114]);
    for (const t of TESTNETS) {
      if (t.family === 'evm') {
        expect(t.chain).toBe(`evm:${t.chainId}`);
        expect(MAINNET_IDS.has(t.chainId!)).toBe(false);
      } else {
        expect(t.chain).toMatch(/^tron:(nile|shasta)$/);
        expect(t.chainId).toBeUndefined();
      }
      expect(t.defaultRpcUrl).toMatch(/^https:\/\//);
      expect(t.explorer).toMatch(/^https:\/\//);
      expect(t.faucet).toMatch(/^https:\/\//);
    }
  });

  it('includes Base Sepolia and TRON Nile, and a family check refuses the wrong backend', () => {
    expect(findTestnet('evm:84532')).toMatchObject({ name: 'Base Sepolia', chainId: 84532, family: 'evm' });
    expect(findTestnet('tron:nile')).toMatchObject({ name: 'TRON Nile', family: 'tron' });
    expect(() => assertTestnet('tron:nile', 'evm')).toThrow(/tron testnet; this backend is for evm/);
    expect(() => assertTestnet('tron:mainnet', 'tron')).toThrow(MainnetNotEnabled);
  });

  it.each(['evm:8453', 'evm:1', 'tron:mainnet', '', 'evm:84532 '])('refuses %j', (chain) => {
    expect(() => assertTestnet(chain)).toThrow(MainnetNotEnabled);
    try {
      assertTestnet(chain);
    } catch (err) {
      expect((err as MainnetNotEnabled).code).toBe('MAINNET_NOT_ENABLED');
      expect((err as Error).message).toMatch(/reviewed change/);
    }
  });
});
