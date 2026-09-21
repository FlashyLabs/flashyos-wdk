// Phase 17 — the envelope tree, as the Safe transactions that mirror it.
//
// A human owns the Safe; this file never signs anything. It turns "these
// agents may spend this much per day of this token" into the exact
// `addDelegate` / `setAllowance` calls the Safe's owners execute, so the
// on-chain allowance is the envelope's mirror agent by agent — and so the
// plan is a JSON document a person can read, diff, and paste into the Safe
// transaction builder. Removals are emitted for agents whose envelope is
// gone, so a revoked agent loses its allowance on chain too.
//
// Selectors computed from the signatures with ethers.id, not recalled:
//   addDelegate(address)                                   0xe71bdf41
//   setAllowance(address,address,uint96,uint16,uint32)     0xbeaeb388
//   removeDelegate(address,bool)                           0xdd43a79f
//   deleteAllowance(address,address)                       0x885133e3

export const PLAN_SELECTORS = {
  addDelegate: '0xe71bdf41',
  setAllowance: '0xbeaeb388',
  removeDelegate: '0xdd43a79f',
  deleteAllowance: '0x885133e3',
} as const;

export interface PlanAgent {
  agentName: string;
  /** The agent's delegate address — its WDK account for the family. */
  address: string;
  /** Base units per day the envelope allows (after delegations: the effective daily). */
  dailyMax: string;
  /** Minutes before `spent` resets. 1440 mirrors the plane's UTC day; 0 means never. */
  resetTimeMin?: number;
}

export interface PlanInput {
  safeAddress: string;
  moduleAddress: string;
  token: string;
  agents: PlanAgent[];
  /** Delegates currently on the Safe that no longer have an envelope: removed, allowances deleted. */
  retire?: { agentName: string; address: string }[];
}

export interface PlanTransaction {
  op: 'addDelegate' | 'setAllowance' | 'removeDelegate' | 'deleteAllowance';
  agentName: string;
  to: string;
  value: '0';
  data: string;
  /** What the call does, for the person reading the plan. */
  summary: string;
}

export interface SafeAllowancePlan {
  version: 1;
  safeAddress: string;
  moduleAddress: string;
  token: string;
  transactions: PlanTransaction[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT96_MAX = (1n << 96n) - 1n;
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uint = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');

/** The plan for one token on one Safe. Deterministic; the same input yields the same document. */
export function safeAllowancePlan(input: PlanInput): SafeAllowancePlan {
  for (const [k, v] of Object.entries({ safeAddress: input.safeAddress, moduleAddress: input.moduleAddress, token: input.token })) {
    if (!ADDRESS_RE.test(v)) throw new Error(`safeAllowancePlan: ${k} is not an address`);
  }
  const transactions: PlanTransaction[] = [];
  const seen = new Set<string>();
  for (const agent of [...input.agents].sort((a, b) => a.agentName.localeCompare(b.agentName))) {
    if (!ADDRESS_RE.test(agent.address)) throw new Error(`safeAllowancePlan: ${agent.agentName} has no valid address`);
    if (seen.has(agent.address.toLowerCase())) throw new Error(`safeAllowancePlan: ${agent.address} is the delegate for two agents; one address per agent`);
    seen.add(agent.address.toLowerCase());
    const amount = BigInt(agent.dailyMax);
    if (amount < 0n || amount > UINT96_MAX) throw new Error(`safeAllowancePlan: ${agent.agentName}'s dailyMax does not fit uint96`);
    const resetTimeMin = agent.resetTimeMin ?? 1440;
    if (resetTimeMin < 0 || resetTimeMin > 0xffff) throw new Error(`safeAllowancePlan: resetTimeMin must fit uint16`);
    transactions.push({
      op: 'addDelegate', agentName: agent.agentName, to: input.moduleAddress, value: '0',
      data: PLAN_SELECTORS.addDelegate + pad(agent.address),
      summary: `Add ${agent.agentName} (${agent.address}) as a delegate of the Safe`,
    });
    transactions.push({
      op: 'setAllowance', agentName: agent.agentName, to: input.moduleAddress, value: '0',
      // resetBaseMin 0: the window is measured from the module's own first reset.
      data: PLAN_SELECTORS.setAllowance + pad(agent.address) + pad(input.token) + uint(amount) + uint(resetTimeMin) + uint(0),
      summary: `Allow ${agent.agentName} to spend ${agent.dailyMax} base units of ${input.token} per ${resetTimeMin} minutes`,
    });
  }
  for (const gone of [...(input.retire ?? [])].sort((a, b) => a.agentName.localeCompare(b.agentName))) {
    if (!ADDRESS_RE.test(gone.address)) throw new Error(`safeAllowancePlan: ${gone.agentName} has no valid address`);
    transactions.push({
      op: 'deleteAllowance', agentName: gone.agentName, to: input.moduleAddress, value: '0',
      data: PLAN_SELECTORS.deleteAllowance + pad(gone.address) + pad(input.token),
      summary: `Delete ${gone.agentName}'s allowance for ${input.token}`,
    });
    transactions.push({
      op: 'removeDelegate', agentName: gone.agentName, to: input.moduleAddress, value: '0',
      data: PLAN_SELECTORS.removeDelegate + pad(gone.address) + uint(1),
      summary: `Remove ${gone.agentName} (${gone.address}) as a delegate and every allowance it had`,
    });
  }
  return { version: 1, safeAddress: input.safeAddress, moduleAddress: input.moduleAddress, token: input.token, transactions };
}
