/**
 * Phase 2 types.
 *
 * Same invariant as `types.ts`: every economic quantity is a `bigint`. The one
 * addition is that Phase 2 carry is SIGNED (`bigint` may be negative), because a
 * position can be closed at a loss. `number` remains reserved for indices, gas
 * unit counts, decimals, timestamps and enum tags.
 */

import type { Raw, Wei } from "./types.js";

/** A signed raw amount. Negative values are meaningful only for carry/P&L. */
export type SignedRaw = bigint;

/** Phase 2 strategy ids — must match `PhaseRegistry.STRATEGY_*`. */
export enum Phase2Strategy {
  NONE = 0,
  CROSS_VENUE_BASIS = 1,
  LST_RESTAKE_LOOP = 2,
  OPTIONS_HEDGED_MM = 3,
}

export const PHASE2_STRATEGY_NAMES: Readonly<Record<Phase2Strategy, string>> = {
  [Phase2Strategy.NONE]: "none",
  [Phase2Strategy.CROSS_VENUE_BASIS]: "cross-venue-basis",
  [Phase2Strategy.LST_RESTAKE_LOOP]: "lst-restake-loop",
  [Phase2Strategy.OPTIONS_HEDGED_MM]: "options-hedged-mm",
};

/** Per-leg action tags — must match `Phase2Actions` in Solidity. */
export const PHASE2_ACTION: Readonly<Record<"open" | "hedge" | "close", number>> = {
  open: 1,
  hedge: 2,
  close: 3,
};

/**
 * A Phase 2 lifecycle step. The step determines the carry formula:
 *   open / hedge : carry = R - B0        (D is converted into the position)
 *   close        : carry = R - B0 - D    (D is returned by the redemption)
 */
export type Phase2Step = "open" | "hedge" | "close";

export interface P2Leg {
  venue: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: Raw;
  minAmountOut: Raw;
  action: number;
  deadline: bigint;
}

export interface Phase2Plan {
  strategy: number;
  asset: string;
  /** D — principal committed at open, or the principal to be returned at close. */
  deployedRaw: Raw;
  /** Signed carry floor. `>= 0` behaves exactly like Phase 1's profit floor. */
  minCarryRaw: SignedRaw;
  /** Fee + slippage ceiling in asset raw units. */
  maxCostRaw: Raw;
  gasBudgetWei: Wei;
  nonce: bigint;
  deadline: bigint;
  profitRecipient: string;
  legs: P2Leg[];
}

/**
 * Result of the pure Phase 2 carry evaluation.
 *
 * The identities, in order:
 *   (1) carry      = R - B0 - D                       signed
 *   (2) cost       = maxCostRaw (declared ceiling)    unsigned
 *   (3) carryNet   = carry - cost                     signed
 *   (4) gate       = carryNet >= minCarryRaw          signed comparison
 *   (5) invariant  = carry >= minCarryRaw             signed comparison
 *
 * (4) is the off-chain submission gate and is STRICTLY STRONGER than (5) because
 * it also charges the declared cost ceiling. A marginal position can satisfy the
 * on-chain invariant and still be correctly rejected before broadcast — the same
 * relationship Phase 1 has between `N' >= P` and `R >= B0 + L + F + P`.
 */
export interface Phase2Economics {
  /** D — principal. */
  deployedRaw: Raw;
  /** B0 — executor balance of `asset` before the step. */
  preBalance: Raw;
  /** R — executor balance of `asset` after the step's legs. */
  postBalance: Raw;
  /** carry = R - B0 - D. Signed. */
  carryRaw: SignedRaw;
  /** Declared cost ceiling. */
  costRaw: Raw;
  /** carryNet = carry - cost. Signed. */
  carryNetRaw: SignedRaw;
  /** The plan's signed floor. */
  carryFloorRaw: SignedRaw;
  /** True iff carryNet >= carryFloor. */
  gatePassed: boolean;
  /** True iff carry >= carryFloor. */
  invariantHolds: boolean;
  /** True iff the step is a de-risking close that realises a bounded loss. */
  isBoundedLoss: boolean;
}

/** A Phase 2 proposal emitted by a strategy, before gating. */
export interface Phase2Proposal {
  readonly strategy: Phase2Strategy;
  readonly step: "open" | "hedge" | "close";
  readonly candidatePlan: Phase2Plan;
  readonly rationale: string;
  readonly confidenceBps: bigint;
  /** Strategy-specific expected carry, for logging and for the gate's sanity check. */
  readonly expectedCarryRaw: SignedRaw;
}

/** Read-only view of Phase 1 handed to Phase 2. Phase 2 can look, never touch. */
export interface Phase1ReadOnlyView {
  readonly breakerOpen: boolean;
  readonly availableBudgetWei: bigint;
  readonly minNetProfitRaw: bigint;
  readonly maxLoanRaw: bigint;
  readonly nowTs: bigint;
}
