import {
  Phase2Strategy,
  buildPhase2Plan,
  evaluatePhase2Step,
  maxDeployedForGate,
  assertLegActions,
  carryMeetsFloor,
  signedDelta,
  carryToNativeWei,
  AccountingError,
  Phase,
  PhaseDomain,
  domainOf,
  isLegalTransition,
  legalEdges,
  hashPhase2Plan,
  hashP2Legs,
  P2_LEG_TYPE_STRING,
  PHASE2_PLAN_TYPE_STRING,
  keccak256Utf8,
  parseUnits,
  formatUnits,
} from "../dist/packages/core/src/index.js";
import {
  assertPhaseDomainsDisjoint as assertDisjointFromPhase2,
  assertPhaseGate as assertGateFromPhase2,
  PhaseBoundaryError as PhaseBoundaryErrorFromPhase2,
} from "../dist/packages/phase2/src/index.js";
import {
  CrossVenueBasisStrategy,
  LstRestakeLoopStrategy,
  OptionsHedgedMmStrategy,
  defaultStrategies,
  strategyByName,
  basisBps,
  healthFactorWad,
  callDeltaWad,
  annualToPeriod,
  rateToRaw,
  parseWad,
  formatWad,
  WAD,
  SECONDS_PER_YEAR,
} from "../dist/packages/phase2-lane/src/index.js";

// The boundary guards live in @v6hf/phase2; alias them to the names used below.
const assertPhaseDomainsDisjoint = assertDisjointFromPhase2;
const assertPhaseGate = assertGateFromPhase2;
const PhaseBoundaryError = PhaseBoundaryErrorFromPhase2;

const results = [];
const check = (name, cond, extra = "") => {
  results.push([name, cond]);
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  " + extra : ""));
};

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const V1 = "0x1111111111111111111111111111111111111111";
const V2 = "0x2222222222222222222222222222222222222222";
const V3 = "0x3333333333333333333333333333333333333333";
const V4 = "0x4444444444444444444444444444444444444444";
const RECIP = "0x9999999999999999999999999999999999999999";

// =====================================================================
// SECTION 1 — phase domain disjointness (exhaustive)
// =====================================================================
console.log("\n--- phase domain disjointness ---");
{
  let threw = false;
  try {
    assertPhaseDomainsDisjoint();
  } catch (e) {
    threw = true;
    console.log("   ", e.message);
  }
  check("assertPhaseDomainsDisjoint passes over the full state space", !threw);

  // Exhaustive: no cross-domain pair is legal.
  const all = [0, 1, 2, 3, 10, 11, 12, 13];
  let crossEdges = 0;
  for (const a of all) {
    for (const b of all) {
      if (domainOf(a) === domainOf(b)) continue;
      if (isLegalTransition(a, b)) crossEdges++;
    }
  }
  check("zero cross-domain legal edges (exhaustive 8x8)", crossEdges === 0, `found ${crossEdges}`);

  // Every legal edge stays inside one domain.
  let badEdge = null;
  for (const [f, t] of legalEdges()) {
    if (domainOf(f) !== domainOf(t)) badEdge = `${f}->${t}`;
  }
  check("every legal edge is intra-domain", badEdge === null, badEdge ?? "");

  check("Phase 1 states are domain PHASE1", domainOf(Phase.IDLE) === PhaseDomain.PHASE1 && domainOf(Phase.REPAYING) === PhaseDomain.PHASE1);
  check("Phase 2 states are domain PHASE2", domainOf(Phase.P2_IDLE) === PhaseDomain.PHASE2 && domainOf(Phase.P2_CLOSING) === PhaseDomain.PHASE2);
  check("unknown phase is domain NONE", domainOf(99) === PhaseDomain.NONE);

  // Phase gate refuses cross-domain action.
  let gateThrew = false;
  try {
    assertPhaseGate(PhaseDomain.PHASE1, Phase.P2_IDLE);
  } catch (e) {
    gateThrew = e instanceof PhaseBoundaryError;
  }
  check("phase gate refuses Phase 1 lane acting on a Phase 2 plan", gateThrew);

  let gateThrew2 = false;
  try {
    assertPhaseGate(PhaseDomain.PHASE2, Phase.IDLE);
  } catch (e) {
    gateThrew2 = e instanceof PhaseBoundaryError;
  }
  check("phase gate refuses Phase 2 lane acting on a Phase 1 plan", gateThrew2);

  let gateOk = true;
  try {
    assertPhaseGate(PhaseDomain.PHASE2, Phase.P2_IDLE);
    assertPhaseGate(PhaseDomain.PHASE1, Phase.IDLE);
  } catch {
    gateOk = false;
  }
  check("phase gate allows same-domain action", gateOk);
}

// =====================================================================
// SECTION 2 — signed carry arithmetic
// =====================================================================
console.log("\n--- signed carry arithmetic ---");
{
  check("signedDelta positive", signedDelta(100n, 40n) === 60n);
  check("signedDelta negative", signedDelta(40n, 100n) === -60n);
  check("signedDelta zero", signedDelta(7n, 7n) === 0n);

  check("carryMeetsFloor at equality", carryMeetsFloor(5n, 5n) === true);
  check("carryMeetsFloor below", carryMeetsFloor(4n, 5n) === false);
  check("carryMeetsFloor negative floor", carryMeetsFloor(-3n, -5n) === true);

  // carryToNativeWei: 80 USDC at 3000 USDC/ETH -> 80/3000 ETH
  const rawPerNative = 3000n * 10n ** 6n;
  const wei = carryToNativeWei(parseUnits("80", 6), rawPerNative);
  const expected = (parseUnits("80", 6) * 10n ** 18n) / rawPerNative;
  check("carryToNativeWei exact", wei === expected, `${wei}`);
  check("carryToNativeWei negative sign preserved", carryToNativeWei(-parseUnits("80", 6), rawPerNative) === -expected);
}

// =====================================================================
// SECTION 3 — step-aware carry formula
// =====================================================================
console.log("\n--- step-aware carry formula ---");
{
  const D = parseUnits("1000", 6);
  // At OPEN the executor must already hold the principal it is about to deploy.
  const B0_OPEN = parseUnits("1500", 6);
  // At CLOSE the executor must again hold the principal it is redeploying.
  const B0_CLOSE = parseUnits("1500", 6);
  const deadline = 2_000_000_000n;
  const snap = { preBalance: B0_OPEN, nowTs: 1_900_000_000n, phase: Phase.P2_IDLE, positionOpen: false, recordedDeployedRaw: 0n };
  const gas = { gasUnits: 300_000n, gasPriceWei: 1_000_000_000n, rawPerNative: 3000n * 10n ** 6n };

  // OPEN: D is converted. Legs consume D and return D + 20 (a 20 USDC gain).
  const openPlan = buildPhase2Plan({
    strategy: Phase2Strategy.CROSS_VENUE_BASIS,
    asset: USDC,
    deployedRaw: D,
    minCarryRaw: parseUnits("5", 6),
    maxCostRaw: parseUnits("1", 6),
    gasBudgetWei: 10n ** 15n,
    nonce: 1n,
    deadline,
    profitRecipient: RECIP,
    step: "open",
    legs: [
      { venue: V1, tokenIn: USDC, tokenOut: USDC, amountIn: D, minAmountOut: D + parseUnits("20", 6), deadline },
    ],
  });
  const openEcon = evaluatePhase2Step(openPlan, snap, gas, "open");
  // carry = R - B0 = (1500 - 1000 + 1020) - 1500 = 20
  check("OPEN carry = R - B0 (D converted, not subtracted)", openEcon.carryRaw === parseUnits("20", 6), formatUnits(openEcon.carryRaw, 6));
  check("OPEN gate passes", openEcon.gatePassed === true);
  check("OPEN invariant holds", openEcon.invariantHolds === true);

  // CLOSE: the venue adapter returns the accounting asset, so carry is again
  // just the step's P&L. B0 is whatever float the executor holds at that moment.
  const closeSnap = { preBalance: B0_CLOSE, nowTs: 1_900_000_000n, phase: Phase.P2_POSITION_OPEN, positionOpen: true, recordedDeployedRaw: D };
  const closePlan = buildPhase2Plan({
    strategy: Phase2Strategy.CROSS_VENUE_BASIS,
    asset: USDC,
    deployedRaw: D,
    minCarryRaw: parseUnits("5", 6),
    maxCostRaw: parseUnits("1", 6),
    gasBudgetWei: 10n ** 15n,
    nonce: 2n,
    deadline,
    profitRecipient: RECIP,
    step: "close",
    legs: [
      { venue: V1, tokenIn: USDC, tokenOut: USDC, amountIn: D, minAmountOut: D + parseUnits("20", 6), deadline },
    ],
  });
  const closeEcon = evaluatePhase2Step(closePlan, closeSnap, gas, "close");
  // R = 500 - 1000 + 1020 = 520; carry = 520 - 500 = 20
  check("CLOSE carry = R - B0 (step P&L)", closeEcon.carryRaw === parseUnits("20", 6), formatUnits(closeEcon.carryRaw, 6));
  check("CLOSE gate passes at a positive floor", closeEcon.gatePassed === true);

  // A close that returns only the principal: carry = 0, below a positive floor.
  const flatClosePlan = buildPhase2Plan({
    strategy: Phase2Strategy.CROSS_VENUE_BASIS,
    asset: USDC,
    deployedRaw: D,
    minCarryRaw: parseUnits("5", 6),
    maxCostRaw: parseUnits("1", 6),
    gasBudgetWei: 10n ** 15n,
    nonce: 2n,
    deadline,
    profitRecipient: RECIP,
    step: "close",
    legs: [{ venue: V1, tokenIn: USDC, tokenOut: USDC, amountIn: D, minAmountOut: D, deadline }],
  });
  const flatCloseEcon = evaluatePhase2Step(flatClosePlan, closeSnap, gas, "close");
  check("CLOSE at break-even has zero carry", flatCloseEcon.carryRaw === 0n, formatUnits(flatCloseEcon.carryRaw, 6));
  check("CLOSE at break-even fails a positive floor", flatCloseEcon.gatePassed === false);

  // Bounded-loss close: floor negative, loss within budget.
  const lossPlan = buildPhase2Plan({
    strategy: Phase2Strategy.CROSS_VENUE_BASIS,
    asset: USDC,
    deployedRaw: D,
    minCarryRaw: -parseUnits("50", 6),
    maxCostRaw: parseUnits("1", 6),
    gasBudgetWei: 10n ** 15n,
    nonce: 3n,
    deadline,
    profitRecipient: RECIP,
    step: "close",
    legs: [
      { venue: V1, tokenIn: USDC, tokenOut: USDC, amountIn: D, minAmountOut: D - parseUnits("30", 6), deadline },
    ],
  });
  const lossEcon = evaluatePhase2Step(lossPlan, closeSnap, gas, "close");
  // R = 500 - 1000 + 970 = 470; carry = 470 - 500 = -30
  check("bounded-loss close is flagged", lossEcon.isBoundedLoss === true);
  check("bounded-loss close within the floor passes", lossEcon.gatePassed === true, formatUnits(lossEcon.carryRaw, 6));

  // A loss BEYOND the floor is rejected.
  const bigLossPlan = buildPhase2Plan({
    strategy: Phase2Strategy.CROSS_VENUE_BASIS,
    asset: USDC,
    deployedRaw: D,
    minCarryRaw: -parseUnits("10", 6),
    maxCostRaw: parseUnits("1", 6),
    gasBudgetWei: 10n ** 15n,
    nonce: 4n,
    deadline,
    profitRecipient: RECIP,
    step: "close",
    legs: [
      { venue: V1, tokenIn: USDC, tokenOut: USDC, amountIn: D, minAmountOut: D - parseUnits("30", 6), deadline },
    ],
  });
  const bigLossEcon = evaluatePhase2Step(bigLossPlan, closeSnap, gas, "close");
  check("loss beyond the floor is rejected", bigLossEcon.gatePassed === false, formatUnits(bigLossEcon.carryRaw, 6));

  // A leg that over-spends the executor's float must fail the projection.
  const overspendPlan = buildPhase2Plan({
    strategy: Phase2Strategy.CROSS_VENUE_BASIS,
    asset: USDC,
    deployedRaw: D,
    minCarryRaw: 0n,
    maxCostRaw: 0n,
    gasBudgetWei: 10n ** 15n,
    nonce: 5n,
    deadline,
    profitRecipient: RECIP,
    step: "open",
    legs: [
      { venue: V1, tokenIn: USDC, tokenOut: USDC, amountIn: B0_OPEN + 1n, minAmountOut: 0n, deadline },
    ],
  });
  let unbackedThrew = false;
  try {
    evaluatePhase2Step(overspendPlan, snap, gas, "open");
  } catch (e) {
    unbackedThrew = e instanceof AccountingError;
  }
  check("over-spending leg fails the projection", unbackedThrew);
}

// =====================================================================
// SECTION 4 — leg action tags
// =====================================================================
console.log("\n--- leg action tags ---");
{
  const D = parseUnits("1000", 6);
  const deadline = 2_000_000_000n;
  const plan = buildPhase2Plan({
    strategy: Phase2Strategy.CROSS_VENUE_BASIS,
    asset: USDC,
    deployedRaw: D,
    minCarryRaw: 0n,
    maxCostRaw: 0n,
    gasBudgetWei: 10n ** 15n,
    nonce: 1n,
    deadline,
    profitRecipient: RECIP,
    step: "open",
    legs: [
      { venue: V1, tokenIn: USDC, tokenOut: USDC, amountIn: D, minAmountOut: D, deadline },
      { venue: V2, tokenIn: USDC, tokenOut: USDC, amountIn: D, minAmountOut: D, deadline },
    ],
  });
  check("buildPhase2Plan stamps every leg with the step action", plan.legs.every((l) => l.action === 1));

  let ok = true;
  try {
    assertLegActions(plan.legs, 1);
  } catch {
    ok = false;
  }
  check("assertLegActions accepts matching tags", ok);

  let threw = false;
  try {
    assertLegActions(plan.legs, 3);
  } catch (e) {
    threw = e instanceof AccountingError;
  }
  check("assertLegActions rejects a mismatched tag", threw);

  // A hand-built plan with a wrong tag must be caught.
  const bad = { ...plan, legs: [{ ...plan.legs[0], action: 3 }] };
  let threw2 = false;
  try {
    assertLegActions(bad.legs, 1);
  } catch {
    threw2 = true;
  }
  check("assertLegActions catches a hand-built mis-tag", threw2);
}

// =====================================================================
// SECTION 5 — strategy math
// =====================================================================
console.log("\n--- strategy math ---");
{
  // basisBps: spot 3000, perp 3009 -> +30 bps
  const spot = parseWad("3000");
  const perp = parseWad("3009");
  check("basisBps positive", basisBps(spot, perp) === 30n, `${basisBps(spot, perp)}`);
  check("basisBps negative", basisBps(spot, parseWad("2991")) === -30n, `${basisBps(spot, parseWad("2991"))}`);
  check("basisBps zero", basisBps(spot, spot) === 0n);

  // healthFactorWad: collateral 2000, debt 1000, threshold 80% -> HF = 1.6
  const hf = healthFactorWad(parseUnits("2000", 6), parseUnits("1000", 6), 8000n);
  check("healthFactorWad = 1.6", hf === (16n * WAD) / 10n, formatWad(hf));
  check("healthFactorWad infinite with no debt", healthFactorWad(parseUnits("1", 6), 0n, 8000n) === 2n ** 255n);

  // callDeltaWad: spot 3000, strike 3300 -> 0.909...
  const delta = callDeltaWad(parseWad("3000"), parseWad("3300"));
  check("callDeltaWad below 1 for OTM", delta < WAD && delta > 0n, formatWad(delta));
  check("callDeltaWad clamps to 1 for ITM", callDeltaWad(parseWad("3300"), parseWad("3000")) === WAD);

  // annualToPeriod: 5% annual over 30 days
  const period = annualToPeriod(parseWad("0.05"), 2_592_000n);
  const expectedPeriod = (parseWad("0.05") * 2_592_000n) / SECONDS_PER_YEAR;
  check("annualToPeriod exact", period === expectedPeriod, formatWad(period));

  // rateToRaw: 1000 USDC at 5% for 1 period
  const carry = rateToRaw(parseUnits("1000", 6), parseWad("0.05"), 1n);
  check("rateToRaw = 50 USDC", carry === parseUnits("50", 6), formatUnits(carry, 6));

  // maxDeployedForGate: floor 5, cost 1, edge 8bps -> D >= 6/0.0008 = 7500
  const maxD = maxDeployedForGate(8n, parseUnits("1", 6), parseUnits("5", 6), parseUnits("1000000", 6));
  check("maxDeployedForGate solves the closed form", maxD === parseUnits("7500", 6), formatUnits(maxD, 6));
  check("maxDeployedForGate respects the cap", maxDeployedForGate(8n, 0n, 0n, parseUnits("100", 6)) === parseUnits("100", 6));
  check("maxDeployedForGate returns 0 for no edge", maxDeployedForGate(0n, 0n, 0n, parseUnits("100", 6)) === 0n);
}

// =====================================================================
// SECTION 6 — strategies produce real proposals
// =====================================================================
console.log("\n--- strategies ---");
{
  const ctx = {
    view: { breakerOpen: false, availableBudgetWei: 10n ** 18n, minNetProfitRaw: 0n, maxLoanRaw: 0n, nowTs: 1_900_000_000n },
    market: {
      spotWad: parseWad("3000"),
      perpMarkWad: parseWad("3009"),
      fundingRateWad: parseWad("0.0001"),
      stakingYieldWad: parseWad("0.08"),
      impliedVolWad: parseWad("0.6"),
      optionPremiumWad: parseWad("0.02"),
      asOfTs: 1_900_000_000n,
    },
    asset: USDC,
    assetDecimals: 6,
    maxDeployedRaw: parseUnits("100000", 6),
    maxCostRaw: parseUnits("10", 6),
    gasBudgetWei: 10n ** 15n,
    minCarryRaw: parseUnits("5", 6),
    nonce: 1n,
    deadline: 2_000_000_000n,
    profitRecipient: RECIP,
    venues: { spot: V1, perp: V2, lst: V3, lending: V4, options: V1, hedge: V2 },
    params: {
      holdingSeconds: 2_592_000n,
      minBasisBps: 5n,
      fundingPeriods: 90n,
      spotSlippageBps: 10n,
      perpSlippageBps: 10n,
      borrowRateWad: parseWad("0.05"),
      liquidationThresholdBps: 8000n,
      minHealthFactorWad: parseWad("1.2"),
      maxLoops: 10n,
      stakeSlippageBps: 5n,
      borrowSlippageBps: 5n,
      strikeWad: parseWad("3300"),
      hedgeCostBps: 20n,
      writeSlippageBps: 10n,
      hedgeSlippageBps: 10n,
    },
  };

  const basis = await new CrossVenueBasisStrategy().propose(ctx);
  check("cross-venue-basis emits a proposal", basis.length === 1);
  check("cross-venue-basis proposal is an open step", basis[0]?.step === "open");
  check("cross-venue-basis legs carry action 1", basis[0]?.candidatePlan.legs.every((l) => l.action === 1) === true);
  check("cross-venue-basis expected carry is positive", (basis[0]?.expectedCarryRaw ?? 0n) > 0n, formatUnits(basis[0]?.expectedCarryRaw ?? 0n, 6));

  const lst = await new LstRestakeLoopStrategy().propose(ctx);
  check("lst-restake-loop emits a proposal", lst.length === 1);
  check("lst-restake-loop expected carry is positive", (lst[0]?.expectedCarryRaw ?? 0n) > 0n, formatUnits(lst[0]?.expectedCarryRaw ?? 0n, 6));

  const opt = await new OptionsHedgedMmStrategy().propose(ctx);
  check("options-hedged-mm emits a proposal", opt.length === 1);
  check("options-hedged-mm expected carry is positive", (opt[0]?.expectedCarryRaw ?? 0n) > 0n, formatUnits(opt[0]?.expectedCarryRaw ?? 0n, 6));

  // Negative paths: no edge -> no proposal (never a fabricated one).
  const flatCtx = { ...ctx, market: { ...ctx.market, perpMarkWad: parseWad("3000") } };
  const flat = await new CrossVenueBasisStrategy().propose(flatCtx);
  check("cross-venue-basis emits nothing with no basis", flat.length === 0);

  const itmCtx = { ...ctx, market: { ...ctx.market, spotWad: parseWad("3400") } };
  const itm = await new OptionsHedgedMmStrategy().propose(itmCtx);
  check("options-hedged-mm refuses an in-the-money strike", itm.length === 0);

  const noYieldCtx = { ...ctx, market: { ...ctx.market, stakingYieldWad: parseWad("0.01") } };
  const noYield = await new LstRestakeLoopStrategy().propose(noYieldCtx);
  check("lst-restake-loop emits nothing when yield < borrow cost", noYield.length === 0);

  const unsafeCtx = { ...ctx, params: { ...ctx.params, minHealthFactorWad: parseWad("0.7") } };
  const unsafe = await new LstRestakeLoopStrategy().propose(unsafeCtx);
  check("lst-restake-loop stands down when no leverage is safe", unsafe.length === 0);

  check("defaultStrategies returns 3", defaultStrategies().length === 3);
  check("strategyByName resolves", strategyByName("cross-venue-basis").id === Phase2Strategy.CROSS_VENUE_BASIS);
  let unknownThrew = false;
  try {
    strategyByName("nope");
  } catch {
    unknownThrew = true;
  }
  check("strategyByName throws on unknown", unknownThrew);
}

// =====================================================================
// SECTION 7 — EIP-712 Phase 2 digest
// =====================================================================
console.log("\n--- phase2 eip712 ---");
{
  const D = parseUnits("1000", 6);
  const deadline = 2_000_000_000n;
  const plan = buildPhase2Plan({
    strategy: Phase2Strategy.CROSS_VENUE_BASIS,
    asset: USDC,
    deployedRaw: D,
    minCarryRaw: -parseUnits("50", 6),
    maxCostRaw: parseUnits("1", 6),
    gasBudgetWei: 10n ** 15n,
    nonce: 7n,
    deadline,
    profitRecipient: RECIP,
    step: "close",
    legs: [{ venue: V1, tokenIn: USDC, tokenOut: USDC, amountIn: D, minAmountOut: D, deadline }],
  });

  const h1 = hashPhase2Plan(plan, { chainId: 8453n, verifyingContract: V1 });
  const h2 = hashPhase2Plan(plan, { chainId: 8453n, verifyingContract: V1 });
  check("phase2 digest is deterministic", h1 === h2);
  check("phase2 digest is 32 bytes", h1.length === 66);

  const hOther = hashPhase2Plan(plan, { chainId: 8453n, verifyingContract: V2 });
  check("phase2 digest binds the verifying contract", h1 !== hOther);

  const legsHash = hashP2Legs(plan.legs);
  check("legsHash is 32 bytes", legsHash.length === 66);

  // The signed int256 field must actually affect the digest.
  const plan2 = { ...plan, minCarryRaw: -parseUnits("51", 6) };
  check("phase2 digest binds the signed carry floor", hashPhase2Plan(plan2, { chainId: 8453n, verifyingContract: V1 }) !== h1);

  console.log("   P2_LEG_TYPEHASH      =", keccak256Utf8(P2_LEG_TYPE_STRING));
  console.log("   PHASE2_PLAN_TYPEHASH =", keccak256Utf8(PHASE2_PLAN_TYPE_STRING));
}

const failed = results.filter(([, c]) => !c);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED:", failed.map(([n]) => n).join(", "));
  process.exit(1);
}
