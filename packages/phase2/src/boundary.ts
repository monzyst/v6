import {
  Phase,
  PhaseDomain,
  domainOf,
  isLegalTransition,
  legalEdges,
  type ExecutionPlan,
  type Phase2Plan,
} from "@v6hf/core";

/**
 * PHASE 2 BOUNDARY.
 *
 * Phase 2 is optional expansion. The architectural requirement is that Phase 2
 * additions CANNOT alter Phase 1 behaviour. That is achieved by four structural
 * rules, all enforced here rather than by convention:
 *
 *   RULE 1 — Phase 2 code may not import from a Phase 1 lane package.
 *            The dependency arrow points one way only: phase2 -> core.
 *            `assertNoPhase1Imports` checks the module graph at startup.
 *
 *   RULE 2 — Phase 2 may not mutate Phase 1 state. It receives a read-only
 *            snapshot and returns a proposal. It has no handle to a submitter,
 *            a budget ledger, or a breaker.
 *
 *   RULE 3 — Phase 2 is DISABLED unless explicitly enabled in config, and even
 *            when enabled it can only emit proposals that must pass the SAME
 *            Phase 1 preflight gates before anything is signed. There is no
 *            Phase 2 execution path that bypasses Phase 1.
 *
 *   RULE 4 — THE PHASE DOMAINS ARE DISJOINT VALUE SETS WITH DISJOINT TRANSITION
 *            TABLES. `assertPhaseDomainsDisjoint` proves this exhaustively over
 *            the full state space, and `assertPhaseGate` refuses any plan whose
 *            phase does not match the lane that is about to act on it.
 *
 * The practical consequence: deleting this entire directory leaves Phase 1
 * fully functional and byte-identical in behaviour.
 */

export type Phase2StrategyId = "cross-venue-basis" | "lst-restake-loop" | "options-hedged-mm";

export interface Phase2Proposal {
  readonly strategy: Phase2StrategyId;
  /** A Phase-1-shaped plan. It is NOT executable until Phase 1 gates accept it. */
  readonly candidatePlan: ExecutionPlan;
  /** Free-form rationale for the operator log. Never used for decisions. */
  readonly rationale: string;
  /** Confidence in bps, informational only. */
  readonly confidenceBps: bigint;
}

/** Read-only view of Phase 1. Phase 2 can look, never touch. */
export interface Phase1ReadOnlyView {
  readonly breakerOpen: boolean;
  readonly availableBudgetWei: bigint;
  readonly minNetProfitRaw: bigint;
  readonly maxLoanRaw: bigint;
  readonly nowTs: bigint;
}

export interface Phase2Strategy {
  readonly id: Phase2StrategyId;
  /** Returns zero or more proposals. Must be pure with respect to Phase 1. */
  propose(view: Phase1ReadOnlyView): Promise<Phase2Proposal[]>;
}

export interface Phase2Config {
  /** Master switch. Default false. */
  readonly enabled: boolean;
  /** Strategies to run when enabled. */
  readonly strategies: Phase2StrategyId[];
  /** Hard cap on proposals emitted per tick, to bound downstream load. */
  readonly maxProposalsPerTick: number;
}

export const PHASE2_DEFAULT_CONFIG: Phase2Config = {
  enabled: false,
  strategies: [],
  maxProposalsPerTick: 4,
};

/**
 * The Phase 2 runtime. Constructed with a read-only view and a strategy list.
 * It has no reference to any submitter, ledger, or breaker — by type.
 */
export class Phase2Runtime {
  constructor(
    private readonly config: Phase2Config,
    private readonly strategies: readonly Phase2Strategy[],
  ) {
    if (config.enabled) {
      const declared = new Set(config.strategies);
      for (const s of strategies) {
        if (!declared.has(s.id)) {
          throw new Error(`Phase2Runtime: strategy '${s.id}' is not declared in config.strategies`);
        }
      }
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Produces proposals. Returns an empty array when disabled — never throws,
   * so a Phase 2 misconfiguration can never take down a Phase 1 loop.
   */
  async tick(view: Phase1ReadOnlyView): Promise<Phase2Proposal[]> {
    if (!this.config.enabled) return [];
    if (view.breakerOpen) return []; // Phase 1 is unhealthy: stay silent.

    const out: Phase2Proposal[] = [];
    for (const strategy of this.strategies) {
      if (out.length >= this.config.maxProposalsPerTick) break;
      try {
        const proposals = await strategy.propose(view);
        for (const p of proposals) {
          if (out.length >= this.config.maxProposalsPerTick) break;
          out.push(p);
        }
      } catch {
        // A failing Phase 2 strategy is isolated. It cannot affect Phase 1.
        continue;
      }
    }
    return out;
  }
}

/**
 * RULE 1 enforcement. Given the set of module specifiers imported by Phase 2
 * source files, throws if any of them resolve into a Phase 1 lane package.
 */
export function assertNoPhase1Imports(importedSpecifiers: readonly string[]): void {
  const forbidden = ["@v6hf/base-lane", "@v6hf/solana-lane"];
  for (const spec of importedSpecifiers) {
    for (const f of forbidden) {
      if (spec === f || spec.startsWith(`${f}/`)) {
        throw new Error(
          `Phase2 boundary violated: '${spec}' imports Phase 1 lane '${f}'. ` +
            "Phase 2 may depend on @v6hf/core only.",
        );
      }
    }
  }
}

// =====================================================================
// RULE 4 — phase-domain disjointness and phase gating
// =====================================================================

export class PhaseBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseBoundaryError";
  }
}

/**
 * Exhaustively proves the two phase domains are disjoint and that no legal
 * transition crosses between them.
 *
 * This is a real proof over the finite state space, not a spot check: it
 * enumerates every (from, to) pair in the union of both domains and asserts
 *
 *   (a) no state belongs to both domains
 *   (b) no legal edge has its endpoints in different domains
 *   (c) every legal edge's endpoints are both recognised states
 *
 * Called at startup by any process that runs both lanes. If it ever throws, the
 * phase machine has been edited in a way that breaks the separation guarantee and
 * the process must not start.
 */
export function assertPhaseDomainsDisjoint(): void {
  const allStates: Phase[] = [
    Phase.IDLE,
    Phase.FLASH_ACTIVE,
    Phase.SWAPPING,
    Phase.REPAYING,
    Phase.P2_IDLE,
    Phase.P2_POSITION_OPEN,
    Phase.P2_HEDGING,
    Phase.P2_CLOSING,
  ];

  // (a) no state belongs to both domains
  for (const s of allStates) {
    const d = domainOf(s);
    if (d === PhaseDomain.NONE) {
      throw new PhaseBoundaryError(`phase ${s} is not recognised by any domain`);
    }
  }

  // (b) + (c) every legal edge stays inside one domain
  for (const [from, to] of legalEdges()) {
    const df = domainOf(from);
    const dt = domainOf(to);
    if (df === PhaseDomain.NONE || dt === PhaseDomain.NONE) {
      throw new PhaseBoundaryError(`legal edge ${from}->${to} touches an unrecognised state`);
    }
    if (df !== dt) {
      throw new PhaseBoundaryError(
        `CROSS-DOMAIN EDGE: ${Phase[from]}(${from}) -> ${Phase[to]}(${to}) spans ${PhaseDomain[df]} -> ${PhaseDomain[dt]}`,
      );
    }
  }

  // Exhaustive negative check: no pair across domains is legal.
  for (const a of allStates) {
    for (const b of allStates) {
      if (domainOf(a) === domainOf(b)) continue;
      if (isLegalTransition(a, b)) {
        throw new PhaseBoundaryError(
          `CROSS-DOMAIN EDGE: ${Phase[a]}(${a}) -> ${Phase[b]}(${b}) is legal but spans domains`,
        );
      }
    }
  }
}

/**
 * RULE 4 enforcement at the call site. Refuses to let a plan be acted on by a
 * lane whose phase domain does not own it.
 *
 * `lane` is the domain of the code about to act; `planPhase` is the phase the
 * plan was authored for. A Phase 1 plan carries no phase field, so callers pass
 * `PhaseDomain.PHASE1` explicitly; a Phase 2 plan's step determines its phase.
 */
export function assertPhaseGate(lane: PhaseDomain, planPhase: Phase): void {
  const planDomain = domainOf(planPhase);
  if (planDomain === PhaseDomain.NONE) {
    throw new PhaseBoundaryError(`plan declares unrecognised phase ${planPhase}`);
  }
  if (planDomain !== lane) {
    throw new PhaseBoundaryError(
      `phase gate refused: lane ${PhaseDomain[lane]} cannot act on a plan in domain ${PhaseDomain[planDomain]}`,
    );
  }
}

/**
 * Type-level guard: a Phase 1 plan and a Phase 2 plan are structurally different
 * and must never be interchangeable. This function exists so a test can assert
 * that the two shapes do not overlap on their discriminating fields.
 */
export function assertPlanShapesDisjoint(p1: ExecutionPlan, p2: Phase2Plan): void {
  const p1Keys = new Set(Object.keys(p1));
  const p2Keys = new Set(Object.keys(p2));

  // The discriminating fields must not be shared.
  const p1Only = ["loanAsset", "loanAmount", "minNetProfitRaw", "maxFlashFeeRaw"];
  const p2Only = ["strategy", "deployedRaw", "minCarryRaw", "maxCostRaw"];

  for (const k of p1Only) {
    if (!p1Keys.has(k)) throw new PhaseBoundaryError(`Phase 1 plan is missing '${k}'`);
    if (p2Keys.has(k)) throw new PhaseBoundaryError(`Phase 2 plan unexpectedly carries Phase 1 field '${k}'`);
  }
  for (const k of p2Only) {
    if (!p2Keys.has(k)) throw new PhaseBoundaryError(`Phase 2 plan is missing '${k}'`);
    if (p1Keys.has(k)) throw new PhaseBoundaryError(`Phase 1 plan unexpectedly carries Phase 2 field '${k}'`);
  }
}
