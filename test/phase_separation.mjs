import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Phase,
  PhaseDomain,
  domainOf,
  isLegalTransition,
  legalEdges,
  isPhase1,
  isPhase2,
  STEP_REQUIRED_PHASE,
  STEP_RESULT_PHASE,
  PHASE2_STEP_ACTION,
} from "../dist/packages/core/src/index.js";
import {
  Phase2Runtime,
  PHASE2_DEFAULT_CONFIG,
  assertNoPhase1Imports,
  assertPhaseDomainsDisjoint,
  assertPhaseGate,
  assertPlanShapesDisjoint,
  PhaseBoundaryError,
} from "../dist/packages/phase2/src/index.js";

/**
 * Phase separation suite.
 *
 * Proves, by construction and by exhaustive enumeration, that Phase 2 cannot
 * reach Phase 1 and vice versa. Three independent lines of evidence:
 *
 *   1. STATIC  — the real source tree is scanned; no Phase 2 file imports a
 *                Phase 1 lane package.
 *   2. ALGEBRAIC — the phase state spaces are enumerated exhaustively; no legal
 *                transition crosses domains.
 *   3. RUNTIME — the Phase 2 runtime is inert by default, silent when Phase 1 is
 *                unhealthy, and cannot act on a Phase 1 plan.
 */

const results = [];
const check = (name, cond, extra = "") => {
  results.push([name, cond]);
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  " + extra : ""));
};

// =====================================================================
// 1. STATIC — scan the real source tree
// =====================================================================
console.log("--- static: source-tree import scan ---");
{
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  };

  const phase2Files = [
    ...walk("packages/phase2/src"),
    ...walk("packages/phase2-lane/src"),
  ];
  check("Phase 2 source files were found", phase2Files.length > 0, `${phase2Files.length} files`);

  const specifiers = [];
  for (const file of phase2Files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
      specifiers.push(m[1]);
    }
  }

  const phase1Imports = specifiers.filter(
    (s) => s === "@v6hf/base-lane" || s.startsWith("@v6hf/base-lane/") ||
           s === "@v6hf/solana-lane" || s.startsWith("@v6hf/solana-lane/"),
  );
  check("no Phase 2 file imports a Phase 1 lane package", phase1Imports.length === 0, phase1Imports.join(","));

  // The guard itself must reject a forbidden import.
  let guardThrew = false;
  try {
    assertNoPhase1Imports(["@v6hf/core", "@v6hf/base-lane"]);
  } catch (e) {
    guardThrew = e instanceof Error;
  }
  check("assertNoPhase1Imports rejects a Phase 1 lane import", guardThrew);

  let guardOk = true;
  try {
    assertNoPhase1Imports(["@v6hf/core", "ethers", "zod"]);
  } catch {
    guardOk = false;
  }
  check("assertNoPhase1Imports accepts a core-only import set", guardOk);

  // Phase 2 must not import the Phase 1 executor contract's ABI either.
  const abiLeak = phase2Files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return src.includes("BaseFlashExecutor") || src.includes("IV6HFExecutor");
  });
  check("no Phase 2 file references the Phase 1 executor", abiLeak.length === 0, abiLeak.join(","));
}

// =====================================================================
// 2. ALGEBRAIC — exhaustive domain disjointness
// =====================================================================
console.log("\n--- algebraic: exhaustive disjointness ---");
{
  let threw = false;
  try {
    assertPhaseDomainsDisjoint();
  } catch (e) {
    threw = true;
    console.log("   ", e.message);
  }
  check("assertPhaseDomainsDisjoint passes", !threw);

  const all = [0, 1, 2, 3, 10, 11, 12, 13];
  let cross = 0;
  for (const a of all) for (const b of all) {
    if (domainOf(a) !== domainOf(b) && isLegalTransition(a, b)) cross++;
  }
  check("zero cross-domain legal edges (exhaustive)", cross === 0, `${cross}`);

  // Every Phase 1 state is < 10 and every Phase 2 state is >= 10: the numeric
  // separation is what makes the disjointness robust to table edits.
  const p1Max = Math.max(...all.filter(isPhase1));
  const p2Min = Math.min(...all.filter(isPhase2));
  check("Phase 1 states are all below Phase 2 states", p1Max < p2Min, `${p1Max} < ${p2Min}`);

  // The Phase 1 transition table is exactly the four original edges.
  const p1Edges = legalEdges().filter(([f]) => isPhase1(f));
  check("Phase 1 has exactly 4 transitions", p1Edges.length === 4, `${p1Edges.length}`);
  const p1EdgeSet = new Set(p1Edges.map(([f, t]) => `${f}->${t}`));
  check(
    "Phase 1 transitions are unchanged from the original release",
    p1EdgeSet.has("0->1") && p1EdgeSet.has("1->2") && p1EdgeSet.has("2->3") && p1EdgeSet.has("3->0"),
    [...p1EdgeSet].join(" "),
  );

  // Phase 2 has its own connected component.
  const p2Edges = legalEdges().filter(([f]) => isPhase2(f));
  check("Phase 2 has its own transition set", p2Edges.length === 6, `${p2Edges.length}`);
  check("every Phase 2 edge is intra-Phase-2", p2Edges.every(([f, t]) => isPhase2(f) && isPhase2(t)));

  // No Phase 1 state can reach a Phase 2 state by any path.
  const reach = new Map();
  for (const s of all) reach.set(s, new Set());
  for (const [f, t] of legalEdges()) reach.get(f).add(t);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of all) {
      for (const n of [...reach.get(s)]) {
        for (const m of reach.get(n)) {
          if (!reach.get(s).has(m)) {
            reach.get(s).add(m);
            changed = true;
          }
        }
      }
    }
  }
  let reachableCross = 0;
  for (const s of all.filter(isPhase1)) {
    for (const t of reach.get(s)) if (isPhase2(t)) reachableCross++;
  }
  check("no Phase 1 state can reach a Phase 2 state by any path", reachableCross === 0, `${reachableCross}`);

  let reachableCross2 = 0;
  for (const s of all.filter(isPhase2)) {
    for (const t of reach.get(s)) if (isPhase1(t)) reachableCross2++;
  }
  check("no Phase 2 state can reach a Phase 1 state by any path", reachableCross2 === 0, `${reachableCross2}`);
}

// =====================================================================
// 3. RUNTIME — the Phase 2 runtime is inert and isolated
// =====================================================================
console.log("\n--- runtime: inert by default ---");
{
  check("Phase 2 defaults to disabled", PHASE2_DEFAULT_CONFIG.enabled === false);
  check("Phase 2 defaults to no strategies", PHASE2_DEFAULT_CONFIG.strategies.length === 0);

  const view = {
    breakerOpen: false,
    availableBudgetWei: 10n ** 18n,
    minNetProfitRaw: 0n,
    maxLoanRaw: 0n,
    nowTs: 1_900_000_000n,
  };

  // A disabled runtime returns nothing, even with strategies registered.
  let called = 0;
  const spy = {
    id: "cross-venue-basis",
    async propose() {
      called++;
      return [];
    },
  };
  const disabled = new Phase2Runtime({ enabled: false, strategies: ["cross-venue-basis"], maxProposalsPerTick: 4 }, [spy]);
  const out1 = await disabled.tick(view);
  check("a disabled runtime emits nothing", out1.length === 0);
  check("a disabled runtime does not even call its strategies", called === 0);

  // An enabled runtime stays silent while Phase 1 is unhealthy.
  const enabled = new Phase2Runtime({ enabled: true, strategies: ["cross-venue-basis"], maxProposalsPerTick: 4 }, [spy]);
  const out2 = await enabled.tick({ ...view, breakerOpen: true });
  check("an enabled runtime stays silent when the Phase 1 breaker is open", out2.length === 0);
  check("the strategy is not called while Phase 1 is unhealthy", called === 0);

  // A throwing strategy is isolated.
  const thrower = {
    id: "cross-venue-basis",
    async propose() {
      throw new Error("strategy exploded");
    },
  };
  const isolated = new Phase2Runtime({ enabled: true, strategies: ["cross-venue-basis"], maxProposalsPerTick: 4 }, [thrower]);
  let isolatedThrew = false;
  let out3 = [];
  try {
    out3 = await isolated.tick(view);
  } catch {
    isolatedThrew = true;
  }
  check("a throwing strategy does not propagate", !isolatedThrew);
  check("a throwing strategy yields no proposals", out3.length === 0);

  // An undeclared strategy is refused at construction.
  let undeclaredThrew = false;
  try {
    new Phase2Runtime({ enabled: true, strategies: [], maxProposalsPerTick: 4 }, [spy]);
  } catch {
    undeclaredThrew = true;
  }
  check("an undeclared strategy is refused at construction", undeclaredThrew);

  // The proposal cap is honoured.
  const many = {
    id: "cross-venue-basis",
    async propose() {
      return Array.from({ length: 10 }, () => ({
        strategy: "cross-venue-basis",
        candidatePlan: {},
        rationale: "x",
        confidenceBps: 1n,
      }));
    },
  };
  const capped = new Phase2Runtime({ enabled: true, strategies: ["cross-venue-basis"], maxProposalsPerTick: 3 }, [many]);
  const out4 = await capped.tick(view);
  check("the proposal cap is honoured", out4.length === 3, `${out4.length}`);
}

// =====================================================================
// 4. RUNTIME — phase gate refuses cross-domain action
// =====================================================================
console.log("\n--- runtime: phase gate ---");
{
  let t1 = false;
  try {
    assertPhaseGate(PhaseDomain.PHASE1, Phase.P2_IDLE);
  } catch (e) {
    t1 = e instanceof PhaseBoundaryError;
  }
  check("Phase 1 lane refuses a Phase 2 plan", t1);

  let t2 = false;
  try {
    assertPhaseGate(PhaseDomain.PHASE2, Phase.IDLE);
  } catch (e) {
    t2 = e instanceof PhaseBoundaryError;
  }
  check("Phase 2 lane refuses a Phase 1 plan", t2);

  let t3 = false;
  try {
    assertPhaseGate(PhaseDomain.PHASE2, 99);
  } catch (e) {
    t3 = e instanceof PhaseBoundaryError;
  }
  check("an unrecognised phase is refused", t3);

  let ok1 = true;
  try {
    assertPhaseGate(PhaseDomain.PHASE1, Phase.FLASH_ACTIVE);
    assertPhaseGate(PhaseDomain.PHASE2, Phase.P2_HEDGING);
  } catch {
    ok1 = false;
  }
  check("same-domain action is allowed", ok1);

  // Plan shapes must not overlap on their discriminating fields.
  const p1 = { loanAsset: "0x1", loanAmount: 1n, minNetProfitRaw: 1n, maxFlashFeeRaw: 1n };
  const p2 = { strategy: 1, deployedRaw: 1n, minCarryRaw: 1n, maxCostRaw: 1n };
  let shapeOk = true;
  try {
    assertPlanShapesDisjoint(p1, p2);
  } catch {
    shapeOk = false;
  }
  check("Phase 1 and Phase 2 plan shapes are disjoint", shapeOk);

  let shapeThrew = false;
  try {
    assertPlanShapesDisjoint({ ...p1, strategy: 1 }, p2);
  } catch {
    shapeThrew = true;
  }
  check("a Phase 1 plan carrying a Phase 2 field is rejected", shapeThrew);
}

// =====================================================================
// 5. Step/phase consistency
// =====================================================================
console.log("\n--- step/phase consistency ---");
{
  check("open requires P2_IDLE", STEP_REQUIRED_PHASE.open.length === 1 && STEP_REQUIRED_PHASE.open[0] === Phase.P2_IDLE);
  check("hedge requires P2_POSITION_OPEN", STEP_REQUIRED_PHASE.hedge[0] === Phase.P2_POSITION_OPEN);
  check("close accepts OPEN or HEDGING", STEP_REQUIRED_PHASE.close.length === 2);
  check("open results in P2_POSITION_OPEN", STEP_RESULT_PHASE.open[0] === Phase.P2_POSITION_OPEN);
  check("close results in P2_IDLE", STEP_RESULT_PHASE.close[0] === Phase.P2_IDLE);

  // Every required phase must be able to REACH the step's result. A direct edge
  // is not required: `close` goes OPEN|HEDGING -> P2_CLOSING -> P2_IDLE, so the
  // result is reached through the CLOSING intermediate.
  const canReach = (from, to) => {
    if (from === to) return true;
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      for (const [f, t] of legalEdges()) {
        if (f !== cur || seen.has(t)) continue;
        if (t === to) return true;
        seen.add(t);
        queue.push(t);
      }
    }
    return false;
  };

  for (const step of ["open", "hedge", "close"]) {
    const req = STEP_REQUIRED_PHASE[step];
    const res = STEP_RESULT_PHASE[step];
    const allReachable = req.every((r) => res.some((x) => canReach(r, x)));
    check(`step '${step}' required phases can reach its result`, allReachable);
  }

  check("action tags are 1/2/3", PHASE2_STEP_ACTION.open === 1 && PHASE2_STEP_ACTION.hedge === 2 && PHASE2_STEP_ACTION.close === 3);

  // No step may require a Phase 1 phase.
  const anyPhase1Required = Object.values(STEP_REQUIRED_PHASE).some((phases) => phases.some(isPhase1));
  check("no Phase 2 step requires a Phase 1 phase", !anyPhase1Required);
}

const failed = results.filter(([, c]) => !c);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED:", failed.map(([n]) => n).join(", "));
  process.exit(1);
}
