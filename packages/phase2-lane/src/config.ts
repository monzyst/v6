import { z } from "zod";

/**
 * Phase 2 lane configuration.
 *
 * Same discipline as `base-lane/src/config.ts`: every value that affects money is
 * REQUIRED, with no default. A missing value is a startup failure, never a silent
 * fallback. Only operational knobs (poll intervals, arm delay) carry defaults.
 *
 * The Phase 2 lane is DISABLED by default (`enabled: false`). That default is the
 * first of three independent gates; the other two are the on-chain
 * `PhaseRegistry.phase2Enabled` switch and the per-strategy arm bit.
 */

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address");
const bigintStr = z.string().regex(/^-?\d+$/, "must be an integer string").transform((s) => BigInt(s));
const uintStr = z.string().regex(/^\d+$/, "must be a non-negative integer string").transform((s) => BigInt(s));

export const Phase2LaneConfigSchema = z.object({
  // ---- master switch (gate 1 of 3) ----
  enabled: z.boolean().default(false),

  // ---- chain ----
  chainId: z.literal(8453),
  rpcUrl: z.string().url(),

  // ---- contracts ----
  phase2Executor: address,
  phaseRegistry: address,

  // ---- signer isolation (same S1-S3 rules as Phase 1) ----
  /** Hot key. Submits Phase 2 steps. Holds gas only. */
  executorPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Cold key. Signs Phase2Plan digests. MUST NOT be the executor key. */
  authorizerPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  expectedAuthorizerAddress: address,

  // ---- economics ----
  /** Accounting asset (the asset carry is measured in). */
  asset: address,
  assetDecimals: z.number().int().min(0).max(18),
  /** Minimum carry per step, asset raw units. May be negative for close steps. */
  minCarryRaw: bigintStr,
  /** Hard cap on deployed principal, asset raw units. */
  maxDeployedRaw: uintStr,
  /** Hard cap on declared cost per step, asset raw units. */
  maxCostRaw: uintStr,
  /** Gas units assumed for the budget reservation. */
  gasUnitsPerStep: uintStr,
  /** Gas price ceiling, wei. Above this the breaker trips. */
  gasPriceCeilingWei: uintStr,
  /** Raw asset units per 1 whole native token, 1e18 scale. */
  rawPerNative: uintStr,

  // ---- budget ----
  gasBudgetPoolWei: uintStr,
  submitterMinBalanceWei: uintStr,

  // ---- breaker ----
  maxConsecutiveFailures: z.number().int().positive().default(3),
  maxSlippageBps: bigintStr.default("50"),
  stalenessLimitSeconds: z.number().int().positive().default(900),

  // ---- strategies ----
  /** Strategies this process is permitted to run. Must be a subset of the armed set. */
  strategies: z.array(z.enum(["cross-venue-basis", "lst-restake-loop", "options-hedged-mm"])).default([]),
  /** Per-strategy parameters, keyed by strategy name. */
  strategyParams: z.record(z.string(), z.record(z.string(), z.string())).default({}),

  // ---- operational ----
  stepTtlSeconds: z.number().int().positive().default(30),
  pollIntervalMs: z.number().int().positive().default(1000),
  dryRun: z.boolean().default(true),
});

export type Phase2LaneConfig = z.infer<typeof Phase2LaneConfigSchema>;

export function loadPhase2LaneConfig(raw: unknown): Phase2LaneConfig {
  const parsed = Phase2LaneConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Phase2LaneConfig invalid: ${issues}`);
  }
  return parsed.data;
}

/**
 * Reads a strategy parameter as a bigint, with a required presence check.
 * Strategy params are strings in config so they survive JSON round-trips without
 * precision loss; this is the single place they become integers.
 */
export function strategyParam(
  cfg: Phase2LaneConfig,
  strategy: string,
  key: string,
): bigint {
  const group = cfg.strategyParams[strategy];
  if (!group) throw new Error(`Phase2LaneConfig: no params for strategy '${strategy}'`);
  const value = group[key];
  if (value === undefined) throw new Error(`Phase2LaneConfig: strategy '${strategy}' missing param '${key}'`);
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Phase2LaneConfig: strategy '${strategy}' param '${key}' is not an integer: '${value}'`);
  }
  return BigInt(value);
}
