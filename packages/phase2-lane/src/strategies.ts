import {
  AccountingError,
  Phase2Strategy,
  buildPhase2Plan,
  maxDeployedForGate,
  projectPhase2PostBalance,
  type Phase2Plan,
  type Phase2Proposal,
  type Raw,
  type SignedRaw,
} from "@v6hf/core";
import {
  annualToPeriod,
  basisBps,
  bpsOfRaw,
  callDeltaWad,
  healthFactorWad,
  rateToRaw,
  requirePositive,
  SECONDS_PER_YEAR,
  type Phase2StrategyRunner,
  type Phase2StrategyContext,
} from "./strategy-base.js";
import { WAD } from "./market.js";

/**
 * Builds the legs of a two-stage Phase 2 chain such that the PROJECTED carry
 * equals `carryNetRaw` EXACTLY.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * A strategy computes an edge, then has to express it in the plan. If the legs
 * encode only slippage — `minAmountOut = amountIn - slip` — then the projection
 * sees `R = B0 - totalSlippage` and reports a LOSS, no matter how good the edge
 * was. The gate then rejects a plan the strategy itself called profitable.
 * `expectedCarryRaw` is a rationale field; it is not what the chain enforces.
 * Only `minAmountOut` is enforceable, so the edge MUST live there.
 *
 * THE ENCODING
 * ------------
 * Given `D` deployed and a net carry `C` (edge minus every slippage/cost term,
 * already folded in by the caller), emit:
 *
 *   leg A : spend D            -> receive D - slipA
 *   leg B : spend 100% of rest -> receive D + C
 *
 * Projection (balance sheet, B0 = D):
 *   after A:  D - D            = 0 ... then + (D - slipA)  = D - slipA
 *   after B:  (D - slipA) - (D - slipA) + (D + C)          = D + C
 *   carry  :  (D + C) - B0                                 = C        QED
 *
 * Leg B is sized with `amountInBps = 10_000` rather than an absolute amount. That
 * is what makes the chain expressible at all: B consumes exactly what A produced
 * without declaring a second notional, so a two-leg plan needs only `D` of float
 * instead of `2D`.
 *
 * Leg A's `minAmountOut` still carries `slipA`, because A is a genuine fill that
 * can slip. B's `minAmountOut` carries the whole net carry `C`, which is where
 * `slipB` was already subtracted.
 */
export function buildChainLegs(opts: {
  venueA: string;
  venueB: string;
  asset: string;
  counterAsset: string;
  deployedRaw: Raw;
  carryNetRaw: SignedRaw;
  slipA: Raw;
  deadline: bigint;
}): Array<{
  venue: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: Raw;
  amountInBps: Raw;
  minAmountOut: Raw;
  deadline: bigint;
}> {
  const { venueA, venueB, asset, counterAsset, deployedRaw, carryNetRaw, slipA, deadline } = opts;

  if (counterAsset.toLowerCase() === asset.toLowerCase()) {
    // A same-token leg is rejected by `Phase2Executor._executeLeg`, because
    // `minAmountOut` would then mean "net gain" rather than "gross output".
    throw new AccountingError("buildChainLegs: counterAsset must differ from asset", {
      asset,
      counterAsset,
    });
  }

  if (slipA >= deployedRaw) {
    throw new AccountingError("buildChainLegs: slipA consumes the whole notional", {
      slipA: slipA.toString(),
      deployed: deployedRaw.toString(),
    });
  }

  const finalOut = deployedRaw + carryNetRaw;
  if (finalOut < 0n) {
    throw new AccountingError("buildChainLegs: net carry drives the redemption negative", {
      carryNet: carryNetRaw.toString(),
    });
  }

  return [
    {
      // Leg A: buy the counter-asset. `minAmountOut` is a GROSS output bound, which
      // is only meaningful because tokenIn != tokenOut — see the guard above.
      venue: venueA,
      tokenIn: asset,
      tokenOut: counterAsset,
      amountIn: deployedRaw,
      amountInBps: 0n,
      minAmountOut: deployedRaw - slipA,
      deadline,
    },
    {
      // Leg B: sell 100% of the counter-asset back into the accounting asset.
      venue: venueB,
      tokenIn: counterAsset,
      tokenOut: asset,
      amountIn: 0n,
      amountInBps: 10_000n,
      minAmountOut: finalOut,
      deadline,
    },
  ];
}

/**
 * Projects a plan's signed carry at the minimum viable float (`preBalance = D`).
 *
 * This is the SAME arithmetic the executor performs, evaluated at the smallest
 * float the plan is allowed to assume: a Phase 2 step may only touch a float
 * segment of `D`, so a plan that needs more than `D` is not executable.
 */
export function projectedCarry(plan: Phase2Plan): SignedRaw {
  // No `extraBalances`: a chained plan's second leg SELLS the counter-asset the
  // first leg bought, so that token correctly starts at zero and leg A funds it.
  // Seeding it would let a plan claim carry it never earned.
  const post = projectPhase2PostBalance(plan, plan.deployedRaw);
  return post >= plan.deployedRaw ? post - plan.deployedRaw : -(plan.deployedRaw - post);
}

/**
 * Asserts a plan is gateable under the executor's own projection, using the
 * MINIMUM viable float (`preBalance = deployedRaw`).
 *
 * WHY THIS EXISTS. A strategy's `minAmountOut` values are what the projection
 * actually believes; the separate `expectedCarryRaw` figure is only a rationale
 * string. If the legs encode only slippage while the strategy advertises a
 * premium, the plan projects a loss and the gate rejects it — the strategy was
 * lying about its own plan. Rather than trust that every leg is encoded
 * correctly, strategies project here and stand down if it is not.
 *
 * `preBalance = deployedRaw` is the structural minimum: a Phase 2 step may only
 * touch a float segment of `D`, so the plan must be solvable with exactly that
 * much. A larger float only ever makes the projection more favourable.
 */
export function assertSelfGateable(plan: Phase2Plan): void {
  const carry = projectedCarry(plan);
  if (carry < plan.minCarryRaw) {
    throw new AccountingError(
      `strategy emitted an ungateable plan: projected carry ${carry} < floor ${plan.minCarryRaw}`,
      { carry: carry.toString(), floor: plan.minCarryRaw.toString() },
    );
  }
}

/**
 * The three Phase 2 strategies.
 *
 * Each is a pure function of (read-only Phase 1 view, market snapshot, params).
 * None of them can execute anything: they return `Phase2Proposal`s that must pass
 * the Phase 2 gate and then be signed by the cold key. A strategy that cannot find
 * an edge returns `[]` — it never fabricates one.
 *
 * Every carry figure below is an integer in asset raw units. The WAD rates from
 * the market snapshot are converted to raw amounts by `rateToRaw` / `annualToPeriod`,
 * which divide last so no precision is lost early.
 */

// =====================================================================
// 1. CROSS-VENUE BASIS
// =====================================================================
//
// Cash-and-carry: buy spot, short the perp, collect the basis convergence plus
// funding. The carry over the holding period is
//
//   carry = notional * (basisBps/1e4) + notional * fundingPerPeriod * periods
//
// where `basisBps` is the signed (perp - spot)/spot in bps. A negative basis
// (perp below spot) is a valid reverse cash-and-carry, so the strategy does not
// reject it — it simply produces a smaller or negative expected carry, which the
// gate then judges. That is the correct division of labour: the strategy measures,
// the gate decides.

export class CrossVenueBasisStrategy implements Phase2StrategyRunner {
  readonly id = Phase2Strategy.CROSS_VENUE_BASIS;
  readonly name = "cross-venue-basis";

  async propose(ctx: Phase2StrategyContext): Promise<Phase2Proposal[]> {
    const { market, params } = ctx;

    const holdingSeconds = params["holdingSeconds"];
    const minBasisBps = params["minBasisBps"];
    const fundingPeriods = params["fundingPeriods"];
    if (holdingSeconds === undefined || minBasisBps === undefined || fundingPeriods === undefined) {
      throw new AccountingError("cross-venue-basis: missing holdingSeconds/minBasisBps/fundingPeriods");
    }
    void holdingSeconds; // used implicitly via fundingPeriods; kept as an explicit param

    const basis = basisBps(market.spotWad, market.perpMarkWad);

    // The strategy's own entry filter. It is NOT the submission gate: it exists so
    // the strategy does not emit proposals that are obviously below the floor.
    if (basis < minBasisBps) return [];

    // Per-unit GROSS edge in bps: basis convergence + funding carry over the period.
    const fundingBps = (market.fundingRateWad * fundingPeriods * 10_000n) / WAD;
    const edgeBps = basis + fundingBps;
    if (edgeBps <= 0n) return [];

    // Per-unit NET edge in bps: the gross edge has to pay for BOTH legs' slippage.
    // Sizing on the gross edge would size a position whose net carry is negative
    // once the fills are charged, and the gate would then correctly reject it.
    const slipBps = (params["spotSlippageBps"] ?? 10n) + (params["perpSlippageBps"] ?? 10n);
    const netEdgeBps = edgeBps - slipBps;
    if (netEdgeBps <= 0n) return []; // the fills cost more than the edge earns

    // Size so the gate is reachable, then clamp to the configured cap.
    const deployed = maxDeployedForGate(netEdgeBps, ctx.maxCostRaw, ctx.minCarryRaw, ctx.maxDeployedRaw);
    if (deployed <= 0n) return [];
    requirePositive(deployed, "cross-venue-basis deployed");

    // Net carry at that size, with slippage folded in exactly as the legs encode it.
    const slipA = bpsOfRaw(deployed, params["spotSlippageBps"] ?? 10n);
    const slipB = bpsOfRaw(deployed, params["perpSlippageBps"] ?? 10n);
    const grossCarry = bpsOfRaw(deployed, edgeBps);
    const carryNet = grossCarry - slipA - slipB;

    const spotVenue = ctx.venues["spot"];
    const perpVenue = ctx.venues["perp"];
    if (!spotVenue || !perpVenue) {
      throw new AccountingError("cross-venue-basis: venues.spot and venues.perp must both be configured");
    }

    const plan = buildPhase2Plan({
      strategy: this.id,
      asset: ctx.asset,
      deployedRaw: deployed,
      minCarryRaw: ctx.minCarryRaw,
      maxCostRaw: ctx.maxCostRaw,
      gasBudgetWei: ctx.gasBudgetWei,
      nonce: ctx.nonce,
      deadline: ctx.deadline,
      profitRecipient: ctx.profitRecipient,
      step: "open",
      legs: buildChainLegs({
        venueA: spotVenue,
        venueB: perpVenue,
        asset: ctx.asset,
        counterAsset: ctx.counterAsset,
        deployedRaw: deployed,
        carryNetRaw: carryNet,
        slipA,
        deadline: ctx.deadline,
      }),
    });

    // Project what the executor will actually evaluate. Stand down rather than emit
    // a plan the gate is guaranteed to reject.
    const realised = projectedCarry(plan);
    if (realised < ctx.minCarryRaw) return [];

    return [
      {
        strategy: this.id,
        step: "open",
        candidatePlan: plan,
        rationale:
          `basis ${basis}bps + funding ${fundingBps}bps - slip ${slipBps}bps ` +
          `= ${netEdgeBps}bps over ${fundingPeriods} periods; ` +
          `deployed ${deployed} raw; projected carry ${realised} raw`,
        confidenceBps: netEdgeBps > 100n ? 8_000n : 5_000n,
        expectedCarryRaw: realised,
      },
    ];
  }
}

// =====================================================================
// 2. LST RESTAKE LOOP
// =====================================================================
//
// Deposit LST collateral, borrow the underlying, restake, repeat. The carry is
// the staking yield on the levered notional minus the borrow cost:
//
//   carry = notional * L * (stakingYield_period - borrowRate_period)
//
// where L is the loop count. The binding constraint is not the carry but the
// HEALTH FACTOR: the loop must stop while HF stays above the configured floor.
// We compute the maximum safe loop count from the liquidation threshold and the
// borrow rate, then size the position so the resulting HF clears the floor.

export class LstRestakeLoopStrategy implements Phase2StrategyRunner {
  readonly id = Phase2Strategy.LST_RESTAKE_LOOP;
  readonly name = "lst-restake-loop";

  async propose(ctx: Phase2StrategyContext): Promise<Phase2Proposal[]> {
    const { market, params } = ctx;

    const holdingSeconds = params["holdingSeconds"];
    const borrowRateWad = params["borrowRateWad"];
    const liquidationThresholdBps = params["liquidationThresholdBps"];
    const minHealthFactorWad = params["minHealthFactorWad"];
    const maxLoops = params["maxLoops"];
    if (
      holdingSeconds === undefined ||
      borrowRateWad === undefined ||
      liquidationThresholdBps === undefined ||
      minHealthFactorWad === undefined ||
      maxLoops === undefined
    ) {
      throw new AccountingError("lst-restake-loop: missing required params");
    }

    const stakingPeriod = annualToPeriod(market.stakingYieldWad, holdingSeconds);
    const borrowPeriod = annualToPeriod(borrowRateWad, holdingSeconds);
    if (stakingPeriod <= borrowPeriod) return []; // no positive carry

    // Per-unit edge in bps over the period, applied to the levered notional.
    const netPeriodWad = stakingPeriod - borrowPeriod;
    const edgeBps = (netPeriodWad * 10_000n) / WAD;
    if (edgeBps <= 0n) return [];

    // ---- Maximum safe loop count ----
    // With loop count L, collateral = D * L and debt = D * (L - 1).
    //   HF = (D*L * threshold) / (D*(L-1)) = L*T / (L-1)
    // Require HF >= H:
    //   L*T >= H*(L-1)  =>  L*(T - H) >= -H  =>  L <= H / (H - T)
    // (in WAD terms). The guard below is `H > T`: if the health floor is at or
    // below the liquidation threshold, no leverage is safe and we stand down.
    //
    // The closed form is a REAL-number bound. `healthFactorWad` floors twice
    // (once in the threshold weighting, once in the final division), so the
    // computed HF at the closed-form L can land a few wei BELOW the floor. We
    // therefore walk down until the COMPUTED HF clears — the same bounded
    // walk-down `maxDeployedForGate` uses. Trusting the closed form alone would
    // emit a proposal the gate then rejects.
    const thresholdWad = (liquidationThresholdBps * WAD) / 10_000n;
    if (minHealthFactorWad <= thresholdWad) return []; // no leverage is safe
    const closedFormLoops = minHealthFactorWad / (minHealthFactorWad - thresholdWad);
    let loops = closedFormLoops < maxLoops ? closedFormLoops : maxLoops;
    if (loops < 2n) return []; // a loop needs at least one borrow

    // ---- Size ----
    // The levered notional is D * loops, so the effective edge is edgeBps * loops.
    // The fills cost `stakeSlippageBps + borrowSlippageBps` on the DEPLOYED
    // notional, so sizing must use the LEVERED edge net of slippage, not the gross
    // one — otherwise the position is sized to a carry the fills already ate.
    const leveredEdgeBps = edgeBps * loops;
    const slipBps = (params["stakeSlippageBps"] ?? 5n) + (params["borrowSlippageBps"] ?? 5n);
    const netLeveredEdgeBps = leveredEdgeBps - slipBps;
    if (netLeveredEdgeBps <= 0n) return [];

    const deployed = maxDeployedForGate(netLeveredEdgeBps, ctx.maxCostRaw, ctx.minCarryRaw, ctx.maxDeployedRaw);
    if (deployed <= 0n) return [];
    requirePositive(deployed, "lst-restake-loop deployed");

    // ---- Verify the health factor at the chosen size, walking down if needed ----
    let hf = healthFactorWad(deployed * loops, deployed * (loops - 1n), liquidationThresholdBps);
    while (hf < minHealthFactorWad && loops > 2n) {
      loops -= 1n;
      hf = healthFactorWad(deployed * loops, deployed * (loops - 1n), liquidationThresholdBps);
    }
    if (hf < minHealthFactorWad) return [];

    // Net carry: the levered yield on the period, minus both fills' slippage.
    const slipA = bpsOfRaw(deployed, params["stakeSlippageBps"] ?? 5n);
    const borrowSlip = bpsOfRaw(deployed, params["borrowSlippageBps"] ?? 5n);
    const grossCarry = rateToRaw(deployed * loops, netPeriodWad, 1n);
    const carryNet = grossCarry - slipA - borrowSlip;

    const lstVenue = ctx.venues["lst"];
    const lendingVenue = ctx.venues["lending"];
    if (!lstVenue || !lendingVenue) {
      throw new AccountingError("lst-restake-loop: venues.lst and venues.lending must both be configured");
    }

    const plan = buildPhase2Plan({
      strategy: this.id,
      asset: ctx.asset,
      deployedRaw: deployed,
      minCarryRaw: ctx.minCarryRaw,
      maxCostRaw: ctx.maxCostRaw,
      gasBudgetWei: ctx.gasBudgetWei,
      nonce: ctx.nonce,
      deadline: ctx.deadline,
      profitRecipient: ctx.profitRecipient,
      step: "open",
      legs: buildChainLegs({
        venueA: lstVenue,
        venueB: lendingVenue,
        asset: ctx.asset,
        counterAsset: ctx.counterAsset,
        deployedRaw: deployed,
        carryNetRaw: carryNet,
        slipA,
        deadline: ctx.deadline,
      }),
    });

    const realised = projectedCarry(plan);
    if (realised < ctx.minCarryRaw) return [];

    return [
      {
        strategy: this.id,
        step: "open",
        candidatePlan: plan,
        rationale:
          `loops ${loops} (closed form ${closedFormLoops}), HF ${hf} (floor ${minHealthFactorWad}); ` +
          `levered edge ${leveredEdgeBps}bps - slip ${slipBps}bps; ` +
          `projected carry ${realised} raw`,
        confidenceBps: hf > minHealthFactorWad * 2n ? 7_500n : 4_000n,
        expectedCarryRaw: realised,
      },
    ];
  }
}

// =====================================================================
// 3. OPTIONS-HEDGED MARKET MAKING
// =====================================================================
//
// Sell a covered call against inventory and delta-hedge the residual exposure.
// The carry is the premium collected minus the hedge cost:
//
//   carry = notional * premiumWad - hedgeNotional * hedgeCostBps/1e4
//
// where hedgeNotional = notional * delta. The delta is the first-order moneyness
// approximation from `callDeltaWad`. The strategy refuses to sell a call whose
// strike is below spot (that is not market making, it is a directional bet).

export class OptionsHedgedMmStrategy implements Phase2StrategyRunner {
  readonly id = Phase2Strategy.OPTIONS_HEDGED_MM;
  readonly name = "options-hedged-mm";

  async propose(ctx: Phase2StrategyContext): Promise<Phase2Proposal[]> {
    const { market, params } = ctx;

    const strikeWad = params["strikeWad"];
    const hedgeCostBps = params["hedgeCostBps"];
    if (strikeWad === undefined || hedgeCostBps === undefined) {
      throw new AccountingError("options-hedged-mm: missing strikeWad/hedgeCostBps");
    }

    // Refuse to write a call that is already in the money.
    if (strikeWad <= market.spotWad) return [];

    const delta = callDeltaWad(market.spotWad, strikeWad);
    const premiumWad = market.optionPremiumWad;
    if (premiumWad <= 0n) return [];

    // Per-unit edge in bps: premium received minus the delta-weighted hedge cost.
    const premiumBps = (premiumWad * 10_000n) / WAD;
    const hedgeBps = (delta * hedgeCostBps) / WAD;
    const edgeBps = premiumBps - hedgeBps;
    if (edgeBps <= 0n) return [];

    // Size on the NET edge: the write and the hedge both slip, and those fills are
    // charged against the premium. Sizing on the gross premium would size a
    // position whose net carry the fills had already consumed.
    const slipBps = (params["writeSlippageBps"] ?? 10n) + (params["hedgeSlippageBps"] ?? 10n);
    const netEdgeBps = edgeBps - slipBps;
    if (netEdgeBps <= 0n) return [];

    const deployed = maxDeployedForGate(netEdgeBps, ctx.maxCostRaw, ctx.minCarryRaw, ctx.maxDeployedRaw);
    if (deployed <= 0n) return [];
    requirePositive(deployed, "options-hedged-mm deployed");

    const premiumCarry = rateToRaw(deployed, premiumWad, 1n);
    const hedgeNotional = (deployed * delta) / WAD;
    const hedgeCost = bpsOfRaw(hedgeNotional, hedgeCostBps);
    const slipA = bpsOfRaw(deployed, params["writeSlippageBps"] ?? 10n);
    const hedgeSlip = bpsOfRaw(hedgeNotional, params["hedgeSlippageBps"] ?? 10n);
    // Everything the chain must earn, net of both fills and the hedge premium.
    const carryNet = premiumCarry - hedgeCost - slipA - hedgeSlip;

    const optionsVenue = ctx.venues["options"];
    const hedgeVenue = ctx.venues["hedge"];
    if (!optionsVenue || !hedgeVenue) {
      throw new AccountingError("options-hedged-mm: venues.options and venues.hedge must both be configured");
    }

    const plan = buildPhase2Plan({
      strategy: this.id,
      asset: ctx.asset,
      deployedRaw: deployed,
      minCarryRaw: ctx.minCarryRaw,
      maxCostRaw: ctx.maxCostRaw,
      gasBudgetWei: ctx.gasBudgetWei,
      nonce: ctx.nonce,
      deadline: ctx.deadline,
      profitRecipient: ctx.profitRecipient,
      step: "open",
      // The chain's second leg carries the NET carry, which already includes the
      // premium credit and both debits (hedge cost, both fills). Encoding only
      // slippage would make the plan project a pure loss however large the
      // premium, and the gate would reject the strategy's own best trade.
      legs: buildChainLegs({
        venueA: optionsVenue,
        venueB: hedgeVenue,
        asset: ctx.asset,
        counterAsset: ctx.counterAsset,
        deployedRaw: deployed,
        carryNetRaw: carryNet,
        slipA,
        deadline: ctx.deadline,
      }),
    });

    const realised = projectedCarry(plan);
    if (realised < ctx.minCarryRaw) return [];

    return [
      {
        strategy: this.id,
        step: "open",
        candidatePlan: plan,
        rationale:
          `strike ${strikeWad} vs spot ${market.spotWad}, delta ${delta}; ` +
          `premium ${premiumBps}bps - hedge ${hedgeBps}bps = ${edgeBps}bps; ` +
          `projected carry ${realised} raw`,
        confidenceBps: edgeBps > 50n ? 7_000n : 4_500n,
        expectedCarryRaw: realised,
      },
    ];
  }
}

/** The default strategy set, in deterministic order. */
export function defaultStrategies(): Phase2StrategyRunner[] {
  return [new CrossVenueBasisStrategy(), new LstRestakeLoopStrategy(), new OptionsHedgedMmStrategy()];
}

/** Resolves a strategy by its config name. Throws on an unknown name. */
export function strategyByName(name: string): Phase2StrategyRunner {
  for (const s of defaultStrategies()) {
    if (s.name === name) return s;
  }
  throw new AccountingError(`unknown Phase 2 strategy '${name}'`);
}

/** Re-exported so callers do not need to import from two modules. */
export { SECONDS_PER_YEAR };
export type { Phase2StrategyRunner, Phase2StrategyContext };
export type { Raw, SignedRaw };
