/**
 * Phase model — the off-chain mirror of `PhaseMachine.sol`.
 *
 * The single most important property of this module: the two phase domains are
 * DISJOINT VALUE SETS with DISJOINT TRANSITION TABLES. `isLegalTransition` is a
 * direct transcription of the Solidity `isLegal` table, and a property test
 * (`test/phase_separation.mjs`) proves no edge crosses domains in either direction.
 *
 *   Phase 1 (atomic, flash-funded, single transaction)
 *     IDLE(0) -> FLASH_ACTIVE(1) -> SWAPPING(2) -> REPAYING(3) -> IDLE(0)
 *
 *   Phase 2 (multi-transaction position lifecycle)
 *     P2_IDLE(10) -> P2_POSITION_OPEN(11) -> P2_HEDGING(12)
 *                  P2_POSITION_OPEN|P2_HEDGING -> P2_CLOSING(13) -> P2_IDLE(10)
 *
 * The numeric values are ABI: they appear in on-chain views, in breaker payloads
 * and in supervisor logs. Never renumber them.
 */

export enum Phase {
  // ---- Phase 1 ----
  IDLE = 0,
  FLASH_ACTIVE = 1,
  SWAPPING = 2,
  REPAYING = 3,

  // ---- Phase 2 (>= 10, disjoint) ----
  P2_IDLE = 10,
  P2_POSITION_OPEN = 11,
  P2_HEDGING = 12,
  P2_CLOSING = 13,
}

/** Matches `PhaseMachine.DOMAIN_NONE / DOMAIN_PHASE1 / DOMAIN_PHASE2`. */
export enum PhaseDomain {
  NONE = 0,
  PHASE1 = 1,
  PHASE2 = 2,
}

export const PHASE1_STATES: readonly Phase[] = [Phase.IDLE, Phase.FLASH_ACTIVE, Phase.SWAPPING, Phase.REPAYING];

export const PHASE2_STATES: readonly Phase[] = [
  Phase.P2_IDLE,
  Phase.P2_POSITION_OPEN,
  Phase.P2_HEDGING,
  Phase.P2_CLOSING,
];

/**
 * Domain of a phase value. Unknown numbers are `NONE`, never coerced into a
 * guess — a supervisor that receives an unrecognised phase must halt, not pick.
 */
export function domainOf(phase: number): PhaseDomain {
  if (phase === Phase.IDLE || phase === Phase.FLASH_ACTIVE || phase === Phase.SWAPPING || phase === Phase.REPAYING) {
    return PhaseDomain.PHASE1;
  }
  if (phase === Phase.P2_IDLE || phase === Phase.P2_POSITION_OPEN || phase === Phase.P2_HEDGING || phase === Phase.P2_CLOSING) {
    return PhaseDomain.PHASE2;
  }
  return PhaseDomain.NONE;
}

/**
 * The complete legal-transition table. Every row is an explicit pair; there is no
 * arithmetic rule that could accidentally synthesise an edge.
 */
const LEGAL_EDGES: ReadonlyArray<readonly [Phase, Phase]> = [
  // ---- Phase 1 component ----
  [Phase.IDLE, Phase.FLASH_ACTIVE],
  [Phase.FLASH_ACTIVE, Phase.SWAPPING],
  [Phase.SWAPPING, Phase.REPAYING],
  [Phase.REPAYING, Phase.IDLE],

  // ---- Phase 2 component ----
  [Phase.P2_IDLE, Phase.P2_POSITION_OPEN],
  [Phase.P2_POSITION_OPEN, Phase.P2_HEDGING],
  [Phase.P2_HEDGING, Phase.P2_POSITION_OPEN], // re-hedge
  [Phase.P2_POSITION_OPEN, Phase.P2_CLOSING],
  [Phase.P2_HEDGING, Phase.P2_CLOSING],
  [Phase.P2_CLOSING, Phase.P2_IDLE],
];

const EDGE_SET: ReadonlySet<string> = new Set(LEGAL_EDGES.map(([a, b]) => `${a}->${b}`));

export function isLegalTransition(from: Phase, to: Phase): boolean {
  return EDGE_SET.has(`${from}->${to}`);
}

/** Every legal edge, for property tests and for the supervisor's graph check. */
export function legalEdges(): ReadonlyArray<readonly [Phase, Phase]> {
  return LEGAL_EDGES;
}

/**
 * Throws unless the transition is legal. Mirrors `PhaseMachine.advance` /
 * `PhaseMismatch(expected, actual)`.
 */
export function assertTransition(from: Phase, to: Phase): void {
  if (!isLegalTransition(from, to)) {
    throw new PhaseError(`illegal phase transition ${Phase[from]}(${from}) -> ${Phase[to]}(${to})`);
  }
}

export class PhaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseError";
  }
}

/**
 * True iff `phase` belongs to the Phase 1 domain. Use this — never a numeric
 * range check — at any boundary that decides which lane may act.
 */
export function isPhase1(phase: number): boolean {
  return domainOf(phase) === PhaseDomain.PHASE1;
}

/** True iff `phase` belongs to the Phase 2 domain. */
export function isPhase2(phase: number): boolean {
  return domainOf(phase) === PhaseDomain.PHASE2;
}

/**
 * The phase each Phase 2 lifecycle step expects to find the machine in.
 * This is the off-chain half of the on-chain `requirePhaseExpected` check; the
 * submitter refuses to sign a step whose observed phase is not in the set.
 */
export const STEP_REQUIRED_PHASE: Readonly<Record<Phase2Step, readonly Phase[]>> = {
  open: [Phase.P2_IDLE],
  hedge: [Phase.P2_POSITION_OPEN],
  close: [Phase.P2_POSITION_OPEN, Phase.P2_HEDGING],
};

/** The phase the machine must reach after each step. */
export const STEP_RESULT_PHASE: Readonly<Record<Phase2Step, readonly Phase[]>> = {
  open: [Phase.P2_POSITION_OPEN],
  hedge: [Phase.P2_HEDGING, Phase.P2_POSITION_OPEN],
  close: [Phase.P2_IDLE],
};

export type { Phase2Step } from "./phase2-types.js";
import type { Phase2Step } from "./phase2-types.js";

export const PHASE2_STEP_ACTION: Readonly<Record<Phase2Step, number>> = {
  open: 1,
  hedge: 2,
  close: 3,
};

export function stepFromAction(action: number): Phase2Step | null {
  if (action === 1) return "open";
  if (action === 2) return "hedge";
  if (action === 3) return "close";
  return null;
}
