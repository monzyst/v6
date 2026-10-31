/**
 * V6-HF core types.
 *
 * INVARIANT OF THIS FILE: every economic quantity is a `bigint`.
 * `number` is permitted ONLY for non-economic values (indices, gas unit counts,
 * timestamps, decimals). Any `number` that reaches an accounting formula is a bug.
 */

/** Token base units (10^decimals per whole token). */
export type Raw = bigint;
/** Native gas-token base units (10^18 per native on Base). */
export type Wei = bigint;
/** Basis points, 1e4 = 100%. */
export type Bps = bigint;
/** WAD fixed point, 1e18 = 1.0. */
export type Wad = bigint;

export const BPS_DENOMINATOR = 10_000n;
export const WAD = 10n ** 18n;
export const ZERO = 0n;

export interface TokenMeta {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

export type DexKind = 0 | 1 | 2; // 0 = v2, 1 = v3, 2 = aerodrome

export interface Leg {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: Raw;
  amountInBps: Bps;
  minAmountOut: Raw;
  poolFee: number;
  dexKind: DexKind;
  stable: boolean;
  deadline: bigint;
}

export interface ExecutionPlan {
  loanAsset: string;
  loanAmount: Raw;
  minNetProfitRaw: Raw;
  maxFlashFeeRaw: Raw;
  gasBudgetWei: Wei;
  nonce: bigint;
  deadline: bigint;
  profitRecipient: string;
  legs: Leg[];
}

/** Result of the pure accounting evaluation, before any transaction is built. */
export interface Economics {
  /** L — loan principal, raw loan-asset units. */
  principal: Raw;
  /** B0 — executor balance of loanAsset before the pull. */
  preBalance: Raw;
  /** R — projected executor balance after swaps and before repayment. */
  postBalance: Raw;
  /** F — flash fee, raw units. */
  flashFee: Raw;
  /** S = R - B0 - L. */
  grossSurplus: Raw;
  /** N = S - F. */
  netProfit: Raw;
  /** Gas cost expressed in raw loan-asset units (ceiling). */
  gasCostRaw: Raw;
  /** N_eff = N - gasCostRaw. The quantity the submission gate tests. */
  netProfitAfterGas: Raw;
  /** P — the plan's declared floor. */
  profitFloor: Raw;
  /** True iff N_eff >= P. */
  gatePassed: boolean;
  /** True iff R >= B0 + L + F + P. */
  invariantHolds: boolean;
}

export type BreakerReason =
  | "INVARIANT"
  | "BUDGET"
  | "FEE_CAP"
  | "PROFIT_GATE"
  | "SWAP"
  | "MANUAL"
  | "HEALTH";

export const BREAKER_CODES: Record<BreakerReason, number> = {
  INVARIANT: 1,
  BUDGET: 2,
  FEE_CAP: 3,
  PROFIT_GATE: 4,
  SWAP: 5,
  MANUAL: 6,
  HEALTH: 7,
};
