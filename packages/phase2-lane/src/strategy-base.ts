import {
  AccountingError,
  Phase2Strategy,
  type Phase2Proposal,
  type Phase1ReadOnlyView,
  type Raw,
  type SignedRaw,
} from "@v6hf/core";
import { WAD, floorDivSigned, type MarketSnapshot } from "./market.js";

/**
 * Phase 2 strategy interface.
 *
 * A strategy is PURE with respect to Phase 1: it receives a read-only view and a
 * market snapshot, and returns proposals. It holds no submitter, no ledger and no
 * breaker. That is what makes the Phase 2 boundary structural rather than a
 * convention — see `packages/phase2/src/boundary.ts`.
 *
 * NOTE ON NAMING: the interface is `Phase2StrategyRunner`, not `Phase2Strategy`,
 * because `Phase2Strategy` is the numeric strategy-id enum in `@v6hf/core`. The
 * two are different kinds of thing and must not share a name.
 */
export interface Phase2StrategyContext {
  readonly view: Phase1ReadOnlyView;
  readonly market: MarketSnapshot;
  readonly asset: string;
  readonly assetDecimals: number;
  readonly maxDeployedRaw: Raw;
  readonly maxCostRaw: Raw;
  readonly gasBudgetWei: bigint;
  readonly minCarryRaw: SignedRaw;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly profitRecipient: string;
  /** Venue addresses, resolved from config. */
  readonly venues: Readonly<Record<string, string>>;
  /** Strategy parameters, already parsed to bigint. */
  readonly params: Readonly<Record<string, bigint>>;
}

export interface Phase2StrategyRunner {
  readonly id: Phase2Strategy;
  readonly name: string;
  /** Returns zero or more proposals. Must be pure with respect to Phase 1. */
  propose(ctx: Phase2StrategyContext): Promise<Phase2Proposal[]>;
}

/** bps of a WAD value, floored. */
export function bpsOfWad(value: bigint, bps: bigint): bigint {
  return (value * bps) / 10_000n;
}

/** bps of a raw amount, floored. */
export function bpsOfRaw(value: Raw, bps: bigint): Raw {
  return (value * bps) / 10_000n;
}

/**
 * Converts a WAD rate applied over `periods` to a raw amount of `notional`.
 *   amount = floor(notional * rateWad / 1e18 * periods)
 * Integer throughout; the division is last so precision is not lost early.
 */
export function rateToRaw(notional: Raw, rateWad: bigint, periods: bigint): Raw {
  if (periods < 0n) throw new AccountingError("rateToRaw: negative periods");
  return (notional * rateWad * periods) / WAD;
}

export const SECONDS_PER_YEAR = 31_536_000n;

/**
 * Annualised WAD rate over a holding period expressed in seconds.
 *   periodRate = floor(annualWad * seconds / SECONDS_PER_YEAR)
 */
export function annualToPeriod(annualWad: bigint, seconds: bigint): bigint {
  if (seconds < 0n) throw new AccountingError("annualToPeriod: negative seconds");
  return (annualWad * seconds) / SECONDS_PER_YEAR;
}

/**
 * Signed basis in bps: (perp - spot) / spot * 1e4, floored toward -inf.
 * Positive means the perp trades above spot (a cash-and-carry opportunity).
 */
export function basisBps(spotWad: bigint, perpWad: bigint): bigint {
  if (spotWad <= 0n) throw new AccountingError("basisBps: non-positive spot");
  return floorDivSigned((perpWad - spotWad) * 10_000n, spotWad);
}

/**
 * Health factor in WAD for a leveraged position.
 *   HF = (collateral * liquidationThreshold) / debt
 * A position is safe iff HF >= 1e18. Returns a very large value when debt is 0.
 */
export function healthFactorWad(collateralRaw: Raw, debtRaw: Raw, liquidationThresholdBps: bigint): bigint {
  if (debtRaw === 0n) return 2n ** 255n;
  const weighted = bpsOfRaw(collateralRaw, liquidationThresholdBps);
  return (weighted * WAD) / debtRaw;
}

/**
 * Delta of a short call position, in WAD, approximated by the moneyness ratio.
 *   delta = clamp(spot / strike, 0, 1) for a call
 * This is the standard first-order approximation used for sizing a hedge; it is
 * deliberately conservative (it over-hedges slightly when spot < strike).
 */
export function callDeltaWad(spotWad: bigint, strikeWad: bigint): bigint {
  if (strikeWad <= 0n) throw new AccountingError("callDeltaWad: non-positive strike");
  const ratio = (spotWad * WAD) / strikeWad;
  if (ratio > WAD) return WAD;
  return ratio;
}

/** Shared guard: a strategy must never propose a plan with a zero principal. */
export function requirePositive(value: bigint, label: string): void {
  if (value <= 0n) throw new AccountingError(`${label} must be positive`);
}
