import {
  AccountingError,
  Phase,
  STEP_REQUIRED_PHASE,
  PHASE2_STEP_ACTION,
  assertLegActions,
  evaluatePhase2Step,
  type Phase2ChainSnapshot,
  type Phase2Economics,
  type Phase2GasModel,
  type Phase2Plan,
  type Phase2Step,
} from "@v6hf/core";
import type { Phase2LaneConfig } from "./config.js";

/**
 * Phase 2 pre-flight gate.
 *
 * The last place a Phase 2 step can be rejected before a transaction is built.
 * Runs every check in a fixed order and returns a structured verdict rather than
 * throwing, so the supervisor can log exactly which gate rejected a step.
 *
 * Gate order is deliberate and mirrors the Phase 1 stack: cheap static checks
 * first, then the phase lock, then position consistency, then economics, then
 * budget. A step that fails a static check must never consume a reservation.
 *
 * The PHASE and LEG_ACTION gates are the off-chain half of the on-chain phase
 * lock. Running them here means a mis-phased or mis-tagged step is caught locally
 * instead of burning a transaction and tripping the on-chain breaker with code 8.
 */

export type Phase2GateName =
  | "STATIC"
  | "PHASE"
  | "POSITION"
  | "EXPIRY"
  | "LEG_ACTION"
  | "CARRY"
  | "BUDGET";

export interface Phase2GateVerdict {
  readonly passed: boolean;
  readonly failedGate: Phase2GateName | null;
  readonly reason: string;
  readonly economics: Phase2Economics | null;
}

export interface Phase2PreflightInput {
  readonly plan: Phase2Plan;
  readonly step: Phase2Step;
  readonly snapshot: Phase2ChainSnapshot;
  readonly gas: Phase2GasModel;
  readonly availableBudgetWei: bigint;
}

export function phase2Preflight(cfg: Phase2LaneConfig, input: Phase2PreflightInput): Phase2GateVerdict {
  const { plan, step, snapshot, gas, availableBudgetWei } = input;

  // ---- GATE 1: STATIC ----
  if (plan.deployedRaw <= 0n) return fail("STATIC", "deployedRaw must be positive", null);
  if (plan.deployedRaw > cfg.maxDeployedRaw) {
    return fail("STATIC", `deployedRaw ${plan.deployedRaw} exceeds maxDeployedRaw ${cfg.maxDeployedRaw}`, null);
  }
  if (plan.legs.length === 0) return fail("STATIC", "plan has no legs", null);
  if (plan.minCarryRaw < cfg.minCarryRaw) {
    return fail(
      "STATIC",
      `plan carry floor ${plan.minCarryRaw} is below the configured floor ${cfg.minCarryRaw}`,
      null,
    );
  }
  if (plan.maxCostRaw > cfg.maxCostRaw) {
    return fail("STATIC", `maxCostRaw ${plan.maxCostRaw} exceeds configured ${cfg.maxCostRaw}`, null);
  }
  if (plan.gasBudgetWei <= 0n) return fail("STATIC", "gasBudgetWei must be positive", null);

  // ---- GATE 2: PHASE (the phase lock) ----
  const required = STEP_REQUIRED_PHASE[step];
  if (!required.includes(snapshot.phase as Phase)) {
    return fail(
      "PHASE",
      `step '${step}' requires phase in [${required.join(",")}], executor is in ${snapshot.phase}`,
      null,
    );
  }

  // ---- GATE 3: POSITION consistency ----
  if (step === "open" && snapshot.positionOpen) {
    return fail("POSITION", "cannot open: a position is already open", null);
  }
  if ((step === "hedge" || step === "close") && !snapshot.positionOpen) {
    return fail("POSITION", `cannot ${step}: no position is open`, null);
  }
  if (step !== "open" && plan.deployedRaw !== snapshot.recordedDeployedRaw) {
    return fail(
      "POSITION",
      `deployedRaw ${plan.deployedRaw} does not match the recorded principal ${snapshot.recordedDeployedRaw}`,
      null,
    );
  }

  // ---- GATE 4: EXPIRY ----
  if (snapshot.nowTs > plan.deadline) {
    return fail("EXPIRY", `plan expired at ${plan.deadline}, now ${snapshot.nowTs}`, null);
  }
  for (let i = 0; i < plan.legs.length; i++) {
    const leg = plan.legs[i];
    if (!leg) return fail("STATIC", `missing leg ${i}`, null);
    if (snapshot.nowTs > leg.deadline) return fail("EXPIRY", `leg ${i} expired at ${leg.deadline}`, null);
  }

  // ---- GATE 5: LEG_ACTION (per-leg half of the phase lock) ----
  try {
    assertLegActions(plan.legs, PHASE2_STEP_ACTION[step]);
  } catch (err) {
    if (err instanceof AccountingError) return fail("LEG_ACTION", err.message, null);
    throw err;
  }

  // ---- GATE 6: CARRY (signed invariant + submission gate) ----
  let econ: Phase2Economics;
  try {
    econ = evaluatePhase2Step(plan, snapshot, gas, step);
  } catch (err) {
    if (err instanceof AccountingError) return fail("CARRY", err.message, null);
    throw err;
  }

  if (!econ.invariantHolds) {
    return fail(
      "CARRY",
      `carry ${econ.carryRaw} < floor ${econ.carryFloorRaw} (R=${econ.postBalance}, B0=${econ.preBalance}, D=${econ.deployedRaw})`,
      econ,
    );
  }
  if (!econ.gatePassed) {
    return fail(
      "CARRY",
      `carryNet ${econ.carryNetRaw} < floor ${econ.carryFloorRaw} (carry=${econ.carryRaw}, cost=${econ.costRaw})`,
      econ,
    );
  }

  // ---- GATE 7: BUDGET ----
  if (plan.gasBudgetWei > availableBudgetWei) {
    return fail("BUDGET", `reservation ${plan.gasBudgetWei} exceeds available ${availableBudgetWei}`, econ);
  }

  return { passed: true, failedGate: null, reason: "all gates passed", economics: econ };
}

function fail(gate: Phase2GateName, reason: string, economics: Phase2Economics | null): Phase2GateVerdict {
  return { passed: false, failedGate: gate, reason, economics };
}

/**
 * Gas budget ceiling for a Phase 2 step: gasUnits * gasPriceCeiling, with a safety
 * multiplier in bps. Must be an over-estimate, never an under-estimate.
 */
export function phase2GasBudgetCeilingWei(cfg: Phase2LaneConfig, safetyBps = 12_500n): bigint {
  const base = cfg.gasUnitsPerStep * cfg.gasPriceCeilingWei;
  return (base * safetyBps) / 10_000n;
}
