/**
 * Environment → config mappers, Phase 1 Solana lane.
 *
 * See `base-lane/src/from-env.ts` for the design rules. In short: no defaults for
 * money-affecting values, explicit boolean parsing, bigint throughout.
 */

import { optString, reqBigInt, reqBool, reqString, type Env } from "@v6hf/core";
import { loadSolanaLaneConfig, type SolanaLaneConfig } from "./config.js";

/**
 * Builds a Solana lane config from `V6_SOL_*` variables.
 *
 * `V6_SOL_COMMITMENT` is the only optional value: it selects a cluster
 * commitment rather than a money-affecting parameter. `V6_SOL_DRY_RUN` is
 * REQUIRED — the schema default protects hand-written objects, but an operator
 * driving from the environment must state intent explicitly.
 */
export function loadSolanaLaneConfigFromEnv(env: Env): SolanaLaneConfig {
  const commitment = optString(env, "V6_SOL_COMMITMENT");
  return loadSolanaLaneConfig({
    rpcUrl: reqString(env, "V6_SOL_RPC_URL"),
    ...(commitment ? { commitment } : {}),

    executorKeypairPath: reqString(env, "V6_SOL_EXECUTOR_KEYPAIR_PATH"),
    authorizerKeypairPath: reqString(env, "V6_SOL_AUTHORIZER_KEYPAIR_PATH"),
    expectedAuthorizer: reqString(env, "V6_SOL_EXPECTED_AUTHORIZER"),

    loanAssetMint: reqString(env, "V6_SOL_LOAN_ASSET_MINT"),
    loanAssetDecimals: Number(reqBigInt(env, "V6_SOL_LOAN_ASSET_DECIMALS")),
    minNetProfitRaw: reqBigInt(env, "V6_SOL_MIN_NET_PROFIT_RAW").toString(),
    maxLoanRaw: reqBigInt(env, "V6_SOL_MAX_LOAN_RAW").toString(),
    lamportsPerSignature: reqBigInt(env, "V6_SOL_LAMPORTS_PER_SIGNATURE").toString(),
    priorityFeeCeilingMicroLamports: reqBigInt(
      env,
      "V6_SOL_PRIORITY_FEE_CEILING_MICRO_LAMPORTS",
    ).toString(),
    computeUnitLimit: Number(reqBigInt(env, "V6_SOL_COMPUTE_UNIT_LIMIT")),
    rawPerNative: reqBigInt(env, "V6_SOL_RAW_PER_NATIVE").toString(),

    lamportBudgetPool: reqBigInt(env, "V6_SOL_LAMPORT_BUDGET_POOL").toString(),
    submitterMinBalanceLamports: reqBigInt(
      env,
      "V6_SOL_SUBMITTER_MIN_BALANCE_LAMPORTS",
    ).toString(),

    maxConsecutiveFailures: Number(reqBigInt(env, "V6_SOL_MAX_CONSECUTIVE_FAILURES")),
    maxSlippageBps: reqBigInt(env, "V6_SOL_MAX_SLIPPAGE_BPS").toString(),
    stalenessLimitSeconds: Number(reqBigInt(env, "V6_SOL_STALENESS_LIMIT_SECONDS")),

    intentTtlSeconds: Number(reqBigInt(env, "V6_SOL_INTENT_TTL_SECONDS")),
    dryRun: reqBool(env, "V6_SOL_DRY_RUN"),
  });
}

export type { SolanaLaneConfig };
