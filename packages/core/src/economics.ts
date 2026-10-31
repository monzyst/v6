import {
  AccountingError,
  bpsOf,
  flashFeeRaw,
  rawFromNative,
} from "./units.js";
import type { Economics, ExecutionPlan, Leg, Raw, Wad, Wei } from "./types.js";

/**
 * V6-HF economics engine.
 *
 * This module is PURE: it takes a plan plus observed chain state and returns the
 * complete integer accounting picture. It performs no I/O, so it can be unit
 * tested exhaustively and reused identically by the Base lane, the Solana lane,
 * and the pre-flight simulator.
 *
 * -------------------------------------------------------------------------
 * THE FIVE QUANTITIES
 * -------------------------------------------------------------------------
 *   L  = plan.loanAmount                     raw loan-asset units
 *   B0 = executor balance before the pull    raw loan-asset units
 *   R  = executor balance after all legs     raw loan-asset units
 *   F  = ceil(L * feeWad / 1e18)             raw loan-asset units
 *   P  = plan.minNetProfitRaw                raw loan-asset units
 *
 * -------------------------------------------------------------------------
 * THE IDENTITIES
 * -------------------------------------------------------------------------
 *   (1) Gross surplus      S  = R - B0 - L
 *   (2) Net profit         N  = S - F
 *   (3) Gas cost in raw    G  = ceil(gasWei * rawPerNative / 1e18)
 *   (4) Effective profit   N' = N - G
 *   (5) Submission gate    N' >= P
 *   (6) Safety invariant   R  >= B0 + L + F + P
 *
 * Note (5) and (6) are NOT the same test. (6) is the on-chain assertion and is
 * evaluated against the pre-gas balance; (5) is the off-chain gate and is the
 * stricter of the two because it also charges gas. A plan can satisfy (6) and
 * still fail (5) — that is the normal case for a marginal opportunity, and it
 * must be rejected before broadcast.
 */

/** Gas units consumed by a cycle, as measured or estimated. */
export interface GasModel {
  /** Total gas units for the transaction (not wei). */
  readonly gasUnits: bigint;
  /** Effective gas price in wei per gas unit. */
  readonly gasPriceWei: Wei;
  /** Raw loan-asset units per 1 whole native token, on the 1e18 scale. */
  readonly rawPerNative: bigint;
}

/** Observed chain state needed to evaluate a plan. */
export interface ChainSnapshot {
  /** B0: executor's loan-asset balance before the pull. */
  readonly preBalance: Raw;
  /** Morpho's current fee ratio in WAD. */
  readonly morphoFeeWad: Wad;
  /** Current block timestamp (seconds). */
  readonly nowTs: bigint;
}

/**
 * Projects the executor's loan-asset balance after running every leg.
 *
 * Legs are applied in order. A leg with `amountIn == 0` consumes
 * `amountInBps` of the CURRENT balance of `tokenIn`, exactly as the contract
 * does, so the projection and the on-chain execution cannot diverge on sizing.
 *
 * The projection is deliberately conservative: it uses each leg's
 * `minAmountOut` as the realised output, not a quoted amount. A plan that only
 * passes the gate on quoted output is not a plan that passes on-chain.
 */
export function projectPostBalance(plan: ExecutionPlan, preBalance: Raw): Raw {
  const balances = new Map<string, Raw>();
  const key = (a: string) => a.toLowerCase();

  // The projection runs after the pull, so the loan asset starts at B0 + L.
  balances.set(key(plan.loanAsset), preBalance + plan.loanAmount);

  const get = (a: string): Raw => balances.get(key(a)) ?? 0n;
  const set = (a: string, v: Raw): void => {
    if (v < 0n) throw new AccountingError(`projectPostBalance: negative balance for ${a}`);
    balances.set(key(a), v);
  };

  for (let i = 0; i < plan.legs.length; i++) {
    const leg = plan.legs[i];
    if (!leg) throw new AccountingError(`projectPostBalance: missing leg ${i}`, { leg: String(i) });
    const available = get(leg.tokenIn);
    const amountIn = leg.amountIn === 0n ? bpsOf(available, leg.amountInBps) : leg.amountIn;

    if (amountIn === 0n) {
      throw new AccountingError(`projectPostBalance: leg ${i} sizes to zero`, { leg: String(i) });
    }
    if (amountIn > available) {
      throw new AccountingError(`projectPostBalance: leg ${i} over-spends tokenIn`, {
        leg: String(i),
        amountIn: amountIn.toString(),
        available: available.toString(),
      });
    }

    set(leg.tokenIn, available - amountIn);
    set(leg.tokenOut, get(leg.tokenOut) + leg.minAmountOut);
  }

  return get(plan.loanAsset);
}

/**
 * Full economic evaluation of a plan against a chain snapshot.
 *
 * Throws `AccountingError` if any identity is unsatisfiable (e.g. the plan
 * cannot even repay principal + fee). Returns a complete `Economics` record
 * otherwise, including both gate results.
 */
export function evaluatePlan(
  plan: ExecutionPlan,
  snapshot: ChainSnapshot,
  gas: GasModel,
): Economics {
  const principal = plan.loanAmount;
  const preBalance = snapshot.preBalance;

  if (principal <= 0n) throw new AccountingError("evaluatePlan: zero principal");
  if (plan.legs.length === 0) throw new AccountingError("evaluatePlan: empty legs");
  if (snapshot.nowTs > plan.deadline) {
    throw new AccountingError("evaluatePlan: plan expired", {
      deadline: plan.deadline.toString(),
      now: snapshot.nowTs.toString(),
    });
  }

  const postBalance = projectPostBalance(plan, preBalance);
  const flashFee = flashFeeRaw(principal, snapshot.morphoFeeWad);

  // (1) S = R - B0 - L
  const grossSurplus = postBalance - preBalance - principal;
  if (grossSurplus < 0n) {
    throw new AccountingError("evaluatePlan: negative gross surplus (cannot repay principal)", {
      postBalance: postBalance.toString(),
      preBalance: preBalance.toString(),
      principal: principal.toString(),
    });
  }

  // (2) N = S - F
  const netProfit = grossSurplus - flashFee;
  if (netProfit < 0n) {
    throw new AccountingError("evaluatePlan: net profit negative after flash fee", {
      grossSurplus: grossSurplus.toString(),
      flashFee: flashFee.toString(),
    });
  }

  // (3) G = ceil(gasWei * rawPerNative / 1e18)
  const gasWei = gas.gasUnits * gas.gasPriceWei;
  const gasCostRaw = rawFromNative(gasWei, gas.rawPerNative);

  // (4) N' = N - G  (may legitimately be negative; reported as-is)
  const netProfitAfterGas = netProfit - gasCostRaw;

  const profitFloor = plan.minNetProfitRaw;

  // (5) Submission gate: N' >= P
  const gatePassed = netProfitAfterGas >= profitFloor;

  // (6) Safety invariant: R >= B0 + L + F + P
  const invariantHolds = postBalance >= preBalance + principal + flashFee + profitFloor;

  return {
    principal,
    preBalance,
    postBalance,
    flashFee,
    grossSurplus,
    netProfit,
    gasCostRaw,
    netProfitAfterGas,
    profitFloor,
    gatePassed,
    invariantHolds,
  };
}

/**
 * Derives the maximum loan size that still satisfies the gate, given a per-unit
 * edge. Used by the sizing engine to avoid brute-force search.
 *
 * edgeBps is the round-trip edge in basis points (e.g. 12n = 0.12%).
 * Returns the largest L such that N'(L) >= P, or 0n if no positive L works.
 *
 *   N'(L) = floor(L * edgeBps / 1e4) - ceil(L * feeWad / 1e18) - G
 *
 * Both terms are monotone in L, so we solve the closed form and then walk down
 * by one unit to absorb the two different rounding directions.
 */
export function maxLoanForGate(
  edgeBps: bigint,
  feeWad: Wad,
  gasCostRaw: Raw,
  profitFloor: Raw,
  hardCap: Raw,
): Raw {
  if (edgeBps <= 0n) return 0n;

  // Per-unit net edge in WAD: edgeBps/1e4 - feeWad/1e18, expressed over 1e18.
  const edgeWad = (edgeBps * 10n ** 18n) / 10_000n;
  if (edgeWad <= feeWad) return 0n; // no positive edge after the flash fee

  const netPerUnitWad = edgeWad - feeWad;
  const target = profitFloor + gasCostRaw;

  // L <= target * 1e18 / netPerUnitWad
  let candidate = (target * 10n ** 18n) / netPerUnitWad;
  if (candidate > hardCap) candidate = hardCap;

  // Walk down to absorb rounding: at most a handful of iterations because the
  // two roundings differ by < 1 raw unit each.
  for (let i = 0; i < 8 && candidate > 0n; i++) {
    const gross = (candidate * edgeBps) / 10_000n;
    const fee = flashFeeRaw(candidate, feeWad);
    if (gross - fee - gasCostRaw >= profitFloor) return candidate;
    candidate -= 1n;
  }
  return 0n;
}
