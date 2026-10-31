import { z } from "zod";

/**
 * Base lane configuration.
 *
 * Every value here is REQUIRED at deployment. There are no defaults for
 * anything that affects money: a missing value is a startup failure, not a
 * silent fallback. Values that are merely operational (poll intervals) have
 * documented defaults.
 */

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address");
const bigintStr = z.string().regex(/^\d+$/, "must be a non-negative integer string").transform((s) => BigInt(s));

export const BaseLaneConfigSchema = z.object({
  // ---- chain ----
  // 8453 = Base mainnet, 84532 = Base Sepolia (staging).
  chainId: z.union([z.literal(8453), z.literal(84532)]),
  rpcUrl: z.string().url(),
  wsUrl: z.string().url().optional(),

  // ---- contracts ----
  executor: address,
  morpho: address,
  nativeToken: address, // WETH on Base

  // ---- signer isolation ----
  /** Hot key. Submits `execute`. Holds gas only. */
  executorPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Cold key. Signs plans. MUST NOT be the executor key. */
  authorizerPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Expected on-chain authorizer, checked at startup against the cold key. */
  expectedAuthorizerAddress: address,

  // ---- economics ----
  /** P: minimum net profit per cycle, raw loan-asset units. */
  minNetProfitRaw: bigintStr,
  /** Hard cap on loan size, raw loan-asset units. */
  maxLoanRaw: bigintStr,
  /** Absolute flash-fee ceiling, raw loan-asset units. */
  maxFlashFeeRaw: bigintStr,
  /** Gas units assumed for the budget reservation. */
  gasUnitsPerCycle: bigintStr,
  /** Gas price ceiling, wei. Above this the breaker trips. */
  gasPriceCeilingWei: bigintStr,
  /** Raw loan-asset units per 1 whole native token, 1e18 scale. */
  rawPerNative: bigintStr,

  // ---- budget ----
  /** Native wei funded into the on-chain gas budget pool per epoch. */
  gasBudgetPoolWei: bigintStr,
  /** Minimum native balance the hot submitter must retain, wei. */
  submitterMinBalanceWei: bigintStr,

  // ---- breaker ----
  maxConsecutiveFailures: z.number().int().positive().default(3),
  maxSlippageBps: bigintStr.default("50"),
  stalenessLimitSeconds: z.number().int().positive().default(300),

  // ---- operational ----
  planTtlSeconds: z.number().int().positive().default(12),
  pollIntervalMs: z.number().int().positive().default(250),
  /**
   * SAFE BY DEFAULT. `false` means LIVE — it submits transactions that spend
   * real money. A config that omits this field must never be able to trade, so
   * the default is `true` and going live is an explicit, deliberate act.
   *
   * (An earlier revision defaulted to `false`, i.e. live — a silent money path.)
   */
  dryRun: z.boolean().default(true),
});

export type BaseLaneConfig = z.infer<typeof BaseLaneConfigSchema>;

export function loadBaseLaneConfig(raw: unknown): BaseLaneConfig {
  const parsed = BaseLaneConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`BaseLaneConfig invalid: ${issues}`);
  }
  return parsed.data;
}
