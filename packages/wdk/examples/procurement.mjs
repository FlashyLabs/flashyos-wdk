// A whole agent, in twenty lines. Run it:
//
//   FLASHYOS_API_URL=https://api.flashyos.com FLASHYOS_ORG_ID=org_… \
//   FLASHYOS_AGENT_NAME=procurement FLASHYOS_AGENT_TOKEN=… FLASHYOS_SIGNER_URL=http://signer.internal:8787 \
//   npx flashyos-run examples/procurement.mjs
//
// It pays the data vendor's monthly invoice — if the plane allows it — and
// writes what happened to the organization's memory. Every line it prints
// is one event; the plane's captures are the rest of the record.

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const VENDOR = '0x7f3c000000000000000000000000000000000001';
const calldata = (to, amount) => '0xa9059cbb' + to.slice(2).padStart(64, '0') + amount.toString(16).padStart(64, '0');

export default async function (agent) {
  const result = await agent.wallet.transact('evm:84532', { to: USDC, value: '0', data: calldata(VENDOR, 12_000_000n) }, { waitForDecision: { timeoutMs: 600_000, pollMs: 5_000 } });
  await agent.memory.record(`September data licence: ${result.status}${'reason' in result ? ` — ${result.reason}` : ''}`, 'notes/procurement');
  return result.status;
}
