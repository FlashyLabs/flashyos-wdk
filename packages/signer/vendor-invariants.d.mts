// Types for the vendored `invariants/1` harness beside this file.
//
// `vendor-invariants.mjs` is a byte-identical copy of spec-kit's harness and
// is never edited here; this declaration is package-local, written against
// the harness's documented exports so the signer's suite can drive it under
// `strict` without touching the copy. The drift test compares the copy to its
// source; nothing compares this file, so keep it to signatures only.

export declare const KIT: 'invariants/1';

export interface Rng {
  readonly seed: number;
  next(): number;
  int(n: number): number;
  pick<T>(xs: readonly T[]): T;
  bool(p?: number): boolean;
}
export declare function rng(seed?: number): Rng;

/** What an invariant check returns: reasons it is wrong, or nothing. */
export type Reasons = string | readonly string[] | null | undefined | void;

export interface Applied<A = unknown> {
  name: string;
  args: A;
  result: unknown;
  error?: string;
}

export interface Step<A = unknown> {
  name: string;
  args: A;
}

export declare class InvariantViolation extends Error {
  constructor(message: string, details?: Record<string, unknown>);
  readonly name: 'InvariantViolation';
  // interleave()
  failures?: { schedule: string; pattern: string; results: Settled[]; violations: string[] }[];
  schedules?: number;
  // property()
  seed?: number;
  run?: number;
  sequence?: Step[];
  violations?: string[];
  applied?: Applied[];
}

export interface PropertyCommand<S, A = unknown> {
  name: string;
  gen?: (r: Rng, seq: Step[]) => A | Promise<A>;
  run: (sys: S, args: A) => unknown;
}

export interface PropertySpec<S> {
  setup: () => S | Promise<S>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each command types its own args
  commands: PropertyCommand<S, any>[];
  invariants: (sys: S, ctx: { applied: Applied[]; step: number }) => Reasons | Promise<Reasons>;
  tick?: (sys: S) => unknown;
  runs?: number;
  maxLen?: number;
  seed?: number;
}
export declare function property<S>(spec: PropertySpec<S>): Promise<{ kit: string; seed: number; runs: number; commands: number }>;

export declare function shrink<T>(seq: T[], fails: (s: T[]) => boolean | Promise<boolean>): Promise<T[]>;

/** A settled op: a refusal is a result, never a harness failure. */
export type Settled<V = unknown> = { ok: true; value: V } | { ok: false; error: string };

export interface InterleaveOp<S, V = unknown> {
  name: string;
  run: (sys: S) => V | Promise<V>;
}

export interface InterleaveContext<V = unknown> {
  results: Settled<V>[];
  /** The schedule with op names substituted, e.g. `execute||signTypedData`. */
  schedule: string;
  a: string;
  b: string;
  /** The schedule's shape: `a;b`, `b;a`, `a||b`, `b||a`, `a|y|b`, `a;T;b`, `a||T||b`. */
  pattern: string;
}

export interface InterleaveSpec<S, V = unknown> {
  setup: () => S | Promise<S>;
  ops: InterleaveOp<S, V>[];
  invariants: (sys: S, ctx: InterleaveContext<V>) => Reasons | Promise<Reasons>;
  tick?: (sys: S) => unknown;
  pairs?: 'all' | 'distinct' | [string, string][];
}
export declare function interleave<S, V = unknown>(spec: InterleaveSpec<S, V>): Promise<{ kit: string; pairs: number; schedules: number }>;

export declare function expectViolation(fn: () => unknown, options?: { match?: RegExp }): Promise<InvariantViolation>;

export declare function checkInvariantsDoc(
  markdown: string,
  testSource: string,
): { valid: boolean; invariants: { id: string; name: string }[]; citations: string[]; problems: string[] };

export declare function cli(argv?: string[]): Promise<number>;
