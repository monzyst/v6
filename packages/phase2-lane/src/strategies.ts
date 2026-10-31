import {
  AccountingError,
  Phase2Strategy,
  buildPhase2Plan,
  maxDeployedForGate,
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

    const basis = basisBps(market.spotWad, market.perpMarkWad);

    // The strategy's own entry filter. It is NOT the submission gate: it exists so
    // the strategy does not emit proposals that are obviously below the floor.
    if (basis < minBasisBps) return [];

    // Per-unit edge in bps: basis convergence + funding carry over the period.
    const fundingBps = (market.fundingRateWad * fundingPeriods * 10_000n) / WAD;
    const edgeBps = basis + fundingBps;
    if (edgeBps <= 0n) return [];

    // Size so the gate is reachable, then clamp to the configured cap.
    const deployed = maxDeployedForGate(edgeBps, ctx.maxCostRaw, ctx.minCarryRaw, ctx.maxDeployedRaw);
    if (deployed <= 0n) return [];
    requirePositive(deployed, "cross-venue-basis deployed");

    // Expected carry at that size, for the rationale and the gate's sanity check.
    const basisCarry = bpsOfRaw(deployed, basis);
    const fundingCarry = rateToRaw(deployed, market.fundingRateWad, fundingPeriods);
    const expectedCarry = basisCarry + fundingCarry;

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
      legs: [
        {
          venue: spotVenue,
          tokenIn: ctx.asset,
          tokenOut: ctx.asset,
          amountIn: deployed,
          minAmountOut: deployed - bpsOfRaw(deployed, params["spotSlippageBps"] ?? 10n),
          deadline: ctx.deadline,
        },
        {
          venue: perpVenue,
          tokenIn: ctx.asset,
          tokenOut: ctx.asset,
          amountIn: deployed,
          minAmountOut: deployed - bpsOfRaw(deployed, params["perpSlippageBps"] ?? 10n),
          deadline: ctx.deadline,
        },
      ],
    });

    return [
      {
        strategy: this.id,
        step: "open",
        candidatePlan: plan,
        rationale:
          `basis ${basis}bps + funding ${fundingBps}bps over ${fundingPeriods} periods; ` +
          `deployed ${deployed} raw; expected carry ${expectedCarry} raw`,
        confidenceBps: edgeBps > 100n ? 8_000n : 5_000n,
        expectedCarryRaw: expectedCarry,
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
    const leveredEdgeBps = edgeBps * loops;
    const deployed = maxDeployedForGate(leveredEdgeBps, ctx.maxCostRaw, ctx.minCarryRaw, ctx.maxDeployedRaw);
    if (deployed <= 0n) return [];
    requirePositive(deployed, "lst-restake-loop deployed");

    // ---- Verify the health factor at the chosen size, walking down if needed ----
    let hf = healthFactorWad(deployed * loops, deployed * (loops - 1n), liquidationThresholdBps);
    while (hf < minHealthFactorWad && loops > 2n) {
      loops -= 1n;
      hf = healthFactorWad(deployed * loops, deployed * (loops - 1n), liquidationThresholdBps);
    }
    if (hf < minHealthFactorWad) return [];

    const expectedCarry = rateToRaw(deployed * loops, netPeriodWad, 1n);

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
      legs: [
        {
          venue: lstVenue,
          tokenIn: ctx.asset,
          tokenOut: ctx.asset,
          amountIn: deployed,
          minAmountOut: deployed - bpsOfRaw(deployed, params["stakeSlippageBps"] ?? 5n),
          deadline: ctx.deadline,
        },
        {
          venue: lendingVenue,
          tokenIn: ctx.asset,
          tokenOut: ctx.asset,
          amountIn: deployed,
          minAmountOut: deployed - bpsOfRaw(deployed, params["borrowSlippageBps"] ?? 5n),
          deadline: ctx.deadline,
        },
      ],
    });

    return [
      {
        strategy: this.id,
        step: "open",
        candidatePlan: plan,
        rationale:
          `loops ${loops} (closed form ${closedFormLoops}), HF ${hf} (floor ${minHealthFactorWad}); ` +
          `net period edge ${edgeBps}bps; expected carry ${expectedCarry} raw`,
        confidenceBps: hf > minHealthFactorWad * 2n ? 7_500n : 4_000n,
        expectedCarryRaw: expectedCarry,
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

    const deployed = maxDeployedForGate(edgeBps, ctx.maxCostRaw, ctx.minCarryRaw, ctx.maxDeployedRaw);
    if (deployed <= 0n) return [];
    requirePositive(deployed, "options-hedged-mm deployed");

    const premiumCarry = rateToRaw(deployed, premiumWad, 1n);
    const hedgeNotional = (deployed * delta) / WAD;
    const hedgeCost = bpsOfRaw(hedgeNotional, hedgeCostBps);
    const expectedCarry = premiumCarry - hedgeCost;

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
      legs: [
        {
          venue: optionsVenue,
          tokenIn: ctx.asset,
          tokenOut: ctx.asset,
          amountIn: deployed,
          minAmountOut: deployed - bpsOfRaw(deployed, params["writeSlippageBps"] ?? 10n),
          deadline: ctx.deadline,
        },
        {
          venue: hedgeVenue,
          tokenIn: ctx.asset,
          tokenOut: ctx.asset,
          amountIn: hedgeNotional,
          minAmountOut: hedgeNotional - bpsOfRaw(hedgeNotional, params["hedgeSlippageBps"] ?? 10n),
          deadline: ctx.deadline,
        },
      ],
    });

    return [
      {
        strategy: this.id,
        step: "open",
        candidatePlan: plan,
        rationale:
          `strike ${strikeWad} vs spot ${market.spotWad}, delta ${delta}; ` +
          `premium ${premiumBps}bps - hedge ${hedgeBps}bps = ${edgeBps}bps; ` +
          `expected carry ${expectedCarry} raw`,
        confidenceBps: edgeBps > 50n ? 7_000n : 4_500n,
        expectedCarryRaw: expectedCarry,
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
