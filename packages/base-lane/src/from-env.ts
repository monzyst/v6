/**
 * Environment → config mappers.
 *
 * These are the supported deployment path: an operator writes `.env`
 * (see `.env.example`), passes `process.env`, and gets a validated lane config.
 * Without them every lane config had to be assembled by hand, which meant
 * `.env.example` documented variables that no code read.
 *
 * Every mapper uses `@v6hf/core`'s strict accessors, so an unset money-affecting
 * variable throws with its own name at boot instead of defaulting.
 */

import { optString, reqBigInt, reqBool, reqString, type Env } from "@v6hf/core";
import { loadBaseLaneConfig, type BaseLaneConfig } from "./config.js";

/**
 * Builds a Base lane config from `V6_BASE_*` variables.
 *
 * `V6_BASE_DRY_RUN` is REQUIRED, not defaulted. The schema's safe default exists
 * so a hand-written object cannot go live by omission; an operator driving the
 * lane from the environment must state their intent explicitly.
 */
export function loadBaseLaneConfigFromEnv(env: Env): BaseLaneConfig {
  return loadBaseLaneConfig({
    chainId: Number(reqString(env, "V6_BASE_CHAIN_ID")),
    rpcUrl: reqString(env, "V6_BASE_RPC_URL"),
    wsUrl: optString(env, "V6_BASE_WS_URL"),

    executor: reqString(env, "V6_BASE_EXECUTOR"),
    morpho: reqString(env, "V6_BASE_MORPHO"),
    nativeToken: reqString(env, "V6_BASE_NATIVE_TOKEN"),

    executorPrivateKey: reqString(env, "V6_BASE_EXECUTOR_PRIVATE_KEY"),
    authorizerPrivateKey: reqString(env, "V6_BASE_AUTHORIZER_PRIVATE_KEY"),
    expectedAuthorizerAddress: reqString(env, "V6_BASE_EXPECTED_AUTHORIZER"),

    minNetProfitRaw: reqBigInt(env, "V6_BASE_MIN_NET_PROFIT_RAW").toString(),
    maxLoanRaw: reqBigInt(env, "V6_BASE_MAX_LOAN_RAW").toString(),
    maxFlashFeeRaw: reqBigInt(env, "V6_BASE_MAX_FLASH_FEE_RAW").toString(),
    gasUnitsPerCycle: reqBigInt(env, "V6_BASE_GAS_UNITS_PER_CYCLE").toString(),
    gasPriceCeilingWei: reqBigInt(env, "V6_BASE_GAS_PRICE_CEILING_WEI").toString(),
    rawPerNative: reqBigInt(env, "V6_BASE_RAW_PER_NATIVE").toString(),

    gasBudgetPoolWei: reqBigInt(env, "V6_BASE_GAS_BUDGET_POOL_WEI").toString(),
    submitterMinBalanceWei: reqBigInt(env, "V6_BASE_SUBMITTER_MIN_BALANCE_WEI").toString(),

    maxConsecutiveFailures: Number(reqBigInt(env, "V6_BASE_MAX_CONSECUTIVE_FAILURES")),
    maxSlippageBps: reqBigInt(env, "V6_BASE_MAX_SLIPPAGE_BPS").toString(),
    stalenessLimitSeconds: Number(reqBigInt(env, "V6_BASE_STALENESS_LIMIT_SECONDS")),

    planTtlSeconds: Number(reqBigInt(env, "V6_BASE_PLAN_TTL_SECONDS")),
    pollIntervalMs: Number(reqBigInt(env, "V6_BASE_POLL_INTERVAL_MS")),
    dryRun: reqBool(env, "V6_BASE_DRY_RUN"),
  });
}

export type { BaseLaneConfig };
