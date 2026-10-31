/**
 * Environment → config mapper, Phase 2 lane.
 *
 * Phase 2 is gated three ways; this mapper only supplies GATE 1 (`enabled`).
 * Gates 2 and 3 are on-chain (`PhaseRegistry.phase2Enabled`, per-strategy arm).
 * Setting `V6_P2_ENABLED=true` here is necessary but never sufficient — the
 * registry still refuses every step until the on-chain switches agree.
 */

import { reqBigInt, reqBool, reqSignedBigInt, reqString, type Env } from "@v6hf/core";
import { loadPhase2LaneConfig, type Phase2LaneConfig } from "./config.js";

/**
 * Builds a Phase 2 lane config from `V6_P2_*` variables.
 *
 * `V6_P2_STRATEGY_PARAMS` is a JSON object of `{ strategyName: { key: "value" } }`
 * where every value is an integer string. Using strings rather than numbers keeps
 * full precision through JSON parsing; `strategyParam()` converts at the point of
 * use.
 */
export function loadPhase2LaneConfigFromEnv(env: Env): Phase2LaneConfig {
  return loadPhase2LaneConfig({
    enabled: reqBool(env, "V6_P2_ENABLED"),

    chainId: Number(reqBigInt(env, "V6_P2_CHAIN_ID")),
    rpcUrl: reqString(env, "V6_P2_RPC_URL"),

    phase2Executor: reqString(env, "V6_P2_EXECUTOR"),
    phaseRegistry: reqString(env, "V6_P2_PHASE_REGISTRY"),

    executorPrivateKey: reqString(env, "V6_P2_EXECUTOR_PRIVATE_KEY"),
    authorizerPrivateKey: reqString(env, "V6_P2_AUTHORIZER_PRIVATE_KEY"),
    expectedAuthorizerAddress: reqString(env, "V6_P2_EXPECTED_AUTHORIZER"),

    asset: reqString(env, "V6_P2_ASSET"),
    assetDecimals: Number(reqBigInt(env, "V6_P2_ASSET_DECIMALS")),
    minCarryRaw: reqSignedBigInt(env, "V6_P2_MIN_CARRY_RAW").toString(),
    maxDeployedRaw: reqBigInt(env, "V6_P2_MAX_DEPLOYED_RAW").toString(),
    maxCostRaw: reqBigInt(env, "V6_P2_MAX_COST_RAW").toString(),
    gasUnitsPerStep: reqBigInt(env, "V6_P2_GAS_UNITS_PER_STEP").toString(),
    gasPriceCeilingWei: reqBigInt(env, "V6_P2_GAS_PRICE_CEILING_WEI").toString(),
    rawPerNative: reqBigInt(env, "V6_P2_RAW_PER_NATIVE").toString(),

    gasBudgetPoolWei: reqBigInt(env, "V6_P2_GAS_BUDGET_POOL_WEI").toString(),
    submitterMinBalanceWei: reqBigInt(env, "V6_P2_SUBMITTER_MIN_BALANCE_WEI").toString(),

    maxConsecutiveFailures: Number(reqBigInt(env, "V6_P2_MAX_CONSECUTIVE_FAILURES")),
    maxSlippageBps: reqBigInt(env, "V6_P2_MAX_SLIPPAGE_BPS").toString(),
    stalenessLimitSeconds: Number(reqBigInt(env, "V6_P2_STALENESS_LIMIT_SECONDS")),

    // A comma-separated allow-list. Empty is meaningful: no strategy may run, and
    // the lane sits idle rather than falling back to "all".
    strategies: parseStrategyList(env),
    strategyParams: parseStrategyParams(env),

    stepTtlSeconds: Number(reqBigInt(env, "V6_P2_STEP_TTL_SECONDS")),
    pollIntervalMs: Number(reqBigInt(env, "V6_P2_POLL_INTERVAL_MS")),
    dryRun: reqBool(env, "V6_P2_DRY_RUN"),
  });
}

/**
 * Parses the strategy allow-list.
 *
 * An explicitly empty value is allowed and yields `[]` — meaning "permitted to run
 * nothing", which is a legitimate posture. An ABSENT value is a configuration
 * error, because silence should not be read as either "all" or "none".
 */
function parseStrategyList(env: Env): string[] {
  const raw = env["V6_P2_STRATEGIES"];
  if (raw === undefined) {
    throw new Error(
      "environment variable V6_P2_STRATEGIES: is required (use an empty string to permit no strategies)",
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parses `V6_P2_STRATEGY_PARAMS`.
 *
 * Shape: `{"cross-venue-basis":{"holdingSeconds":"86400", ...}}`
 *
 * Values MUST be strings. The schema stores params as `Record<string, string>` so
 * they survive a JSON round-trip without precision loss; accepting JSON numbers
 * here would silently truncate anything above 2^53, which is every raw-unit value.
 */
function parseStrategyParams(env: Env): Record<string, Record<string, string>> {
  const raw = env["V6_P2_STRATEGY_PARAMS"];
  if (raw === undefined) {
    throw new Error(
      "environment variable V6_P2_STRATEGY_PARAMS: is required (use '{}' for none)",
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("environment variable V6_P2_STRATEGY_PARAMS: must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("environment variable V6_P2_STRATEGY_PARAMS: must be a JSON object");
  }

  const out: Record<string, Record<string, string>> = {};
  for (const [strategy, group] of Object.entries(parsed as Record<string, unknown>)) {
    if (group === null || typeof group !== "object" || Array.isArray(group)) {
      throw new Error(
        `environment variable V6_P2_STRATEGY_PARAMS: "${strategy}" must map to an object`,
      );
    }
    const inner: Record<string, string> = {};
    for (const [k, v] of Object.entries(group as Record<string, unknown>)) {
      if (typeof v === "number") {
        // Reject rather than stringify: a JSON number has already lost precision.
        throw new Error(
          `environment variable V6_P2_STRATEGY_PARAMS: "${strategy}.${k}" must be a STRING of digits (numbers lose precision)`,
        );
      }
      if (typeof v !== "string") {
        throw new Error(
          `environment variable V6_P2_STRATEGY_PARAMS: "${strategy}.${k}" must be a string`,
        );
      }
      if (!/^-?\d+$/.test(v.trim())) {
        throw new Error(
          `environment variable V6_P2_STRATEGY_PARAMS: "${strategy}.${k}" must be an integer string, got "${v}"`,
        );
      }
      inner[k] = v.trim();
    }
    out[strategy] = inner;
  }
  return out;
}

export type { Phase2LaneConfig };
