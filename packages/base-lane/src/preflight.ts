import {
  AccountingError,
  evaluatePlan,
  type ChainSnapshot,
  type Economics,
  type ExecutionPlan,
  type GasModel,
} from "@v6hf/core";
import type { BaseLaneConfig } from "./config.js";

/**
 * Pre-flight gate.
 *
 * This is the LAST place a plan can be rejected before a transaction is built.
 * It runs every check in a fixed order and returns a structured verdict rather
 * than throwing, so the supervisor can log exactly which gate rejected a plan.
 *
 * Gate order is deliberate: cheap static checks first, then economics, then
 * budget. A plan that fails a static check must never consume a budget
 * reservation.
 */

export type GateName =
  | "STATIC"
  | "EXPIRY"
  | "FEE_CAP"
  | "INVARIANT"
  | "PROFIT_GATE"
  | "BUDGET";

export interface GateVerdict {
  readonly passed: boolean;
  readonly failedGate: GateName | null;
  readonly reason: string;
  readonly economics: Economics | null;
}

export interface PreflightInput {
  readonly plan: ExecutionPlan;
  readonly snapshot: ChainSnapshot;
  readonly gas: GasModel;
  /** Native wei currently available in the budget ledger. */
  readonly availableBudgetWei: bigint;
}

/**
 * Runs the full gate stack. Pure: no I/O, no mutation.
 */
export function preflight(cfg: BaseLaneConfig, input: PreflightInput): GateVerdict {
  const { plan, snapshot, gas, availableBudgetWei } = input;

  // ---- GATE 1: STATIC ----
  if (plan.loanAmount <= 0n) {
    return fail("STATIC", "loanAmount must be positive", null);
  }
  if (plan.loanAmount > cfg.maxLoanRaw) {
    return fail("STATIC", `loanAmount ${plan.loanAmount} exceeds maxLoanRaw ${cfg.maxLoanRaw}`, null);
  }
  if (plan.legs.length === 0) {
    return fail("STATIC", "plan has no legs", null);
  }
  if (plan.minNetProfitRaw < cfg.minNetProfitRaw) {
    return fail(
      "STATIC",
      `plan floor ${plan.minNetProfitRaw} is below the configured floor ${cfg.minNetProfitRaw}`,
      null,
    );
  }
  if (plan.gasBudgetWei <= 0n) {
    return fail("STATIC", "gasBudgetWei must be positive", null);
  }

  // ---- GATE 2: EXPIRY ----
  if (snapshot.nowTs > plan.deadline) {
    return fail("EXPIRY", `plan expired at ${plan.deadline}, now ${snapshot.nowTs}`, null);
  }
  for (let i = 0; i < plan.legs.length; i++) {
    const leg = plan.legs[i];
    if (!leg) return fail("STATIC", `missing leg ${i}`, null);
    if (snapshot.nowTs > leg.deadline) {
      return fail("EXPIRY", `leg ${i} expired at ${leg.deadline}`, null);
    }
  }

  // ---- GATE 3: FEE CAP ----
  // Evaluated inside evaluatePlan; we re-check the declared cap here so a plan
  // that declares an absurd cap is rejected before any arithmetic runs.
  if (plan.maxFlashFeeRaw > cfg.maxFlashFeeRaw) {
    return fail(
      "FEE_CAP",
      `declared fee cap ${plan.maxFlashFeeRaw} exceeds configured ${cfg.maxFlashFeeRaw}`,
      null,
    );
  }

  // ---- GATE 4/5: ECONOMICS (invariant + profit gate) ----
  let econ: Economics;
  try {
    econ = evaluatePlan(plan, snapshot, gas);
  } catch (err) {
    if (err instanceof AccountingError) {
      return fail("INVARIANT", err.message, null);
    }
    throw err;
  }

  if (econ.flashFee > plan.maxFlashFeeRaw) {
    return fail(
      "FEE_CAP",
      `actual flash fee ${econ.flashFee} exceeds plan cap ${plan.maxFlashFeeRaw}`,
      econ,
    );
  }

  if (!econ.invariantHolds) {
    return fail(
      "INVARIANT",
      `R=${econ.postBalance} < B0+L+F+P=${econ.preBalance + econ.principal + econ.flashFee + econ.profitFloor}`,
      econ,
    );
  }

  if (!econ.gatePassed) {
    return fail(
      "PROFIT_GATE",
      `N'=${econ.netProfitAfterGas} < P=${econ.profitFloor} (N=${econ.netProfit}, G=${econ.gasCostRaw})`,
      econ,
    );
  }

  // ---- GATE 6: BUDGET ----
  if (plan.gasBudgetWei > availableBudgetWei) {
    return fail(
      "BUDGET",
      `reservation ${plan.gasBudgetWei} exceeds available ${availableBudgetWei}`,
      econ,
    );
  }

  return { passed: true, failedGate: null, reason: "all gates passed", economics: econ };
}

function fail(gate: GateName, reason: string, economics: Economics | null): GateVerdict {
  return { passed: false, failedGate: gate, reason, economics };
}

/**
 * Computes the gas budget ceiling for a plan: gasUnits * gasPriceCeiling, with a
 * safety multiplier expressed in bps. This is the number reserved on-chain, so
 * it must be an over-estimate, never an under-estimate.
 */
export function gasBudgetCeilingWei(cfg: BaseLaneConfig, safetyBps = 12_500n): bigint {
  const base = cfg.gasUnitsPerCycle * cfg.gasPriceCeilingWei;
  return (base * safetyBps) / 10_000n;
}
