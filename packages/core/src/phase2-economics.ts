import { AccountingError, ceilDiv } from "./units.js";
import { BPS_DENOMINATOR, type Raw, type Wei } from "./types.js";
import type { Phase2Economics, Phase2Plan, Phase2Step, P2Leg, SignedRaw } from "./phase2-types.js";

/**
 * Phase 2 economics engine — SIGNED carry.
 *
 * Pure: no I/O, no mutation. Reused identically by every Phase 2 strategy, by the
 * Phase 2 gate, and by the Phase 2 submitter, so the three can never disagree.
 *
 * -------------------------------------------------------------------------
 * THE QUANTITIES
 * -------------------------------------------------------------------------
 *   D  = plan.deployedRaw        principal committed (open) / returned (close)
 *   B0 = executor balance of `asset` before the step
 *   R  = executor balance of `asset` after the step's legs
 *   C  = plan.maxCostRaw         declared fee + slippage ceiling
 *   F  = plan.minCarryRaw        SIGNED carry floor
 *
 * -------------------------------------------------------------------------
 * THE IDENTITIES
 * -------------------------------------------------------------------------
 *   (1) carry     = R - B0                         signed, step-independent
 *   (2) carryNet  = carry - C                      signed
 *   (3) gate      = carryNet >= F                  off-chain submission gate
 *   (4) invariant = carry    >= F                  on-chain assertion
 *
 * -------------------------------------------------------------------------
 * WHY SIGNED, AND WHY (3) IS STRICTER THAN (4)
 * -------------------------------------------------------------------------
 * Phase 1's invariant `R >= B0 + L + F + P` is unsigned: a Phase 1 plan can never
 * authorise a loss. Phase 2 unwinds a position over several transactions, so a
 * de-risking close must be able to realise a BOUNDED loss — that is the whole
 * point of an emergency exit. Hence `F` is `int256` and `carry` is signed.
 *
 * With `F >= 0` the two forms are algebraically identical:
 *     carry >= F   <=>   R - B0 >= F   <=>   R >= B0 + F
 * which is exactly Phase 1's invariant with `F` in place of `P`. The signed form
 * is a strict generalisation, not a different rule.
 *
 * (3) is strictly stronger than (4) because it also charges the declared cost
 * ceiling `C`. A marginal position can satisfy the on-chain invariant and still
 * be correctly rejected before broadcast. Both are computed here; neither is
 * derived from the other.
 */

/** Gas model for a Phase 2 step. Mirrors the Phase 1 `GasModel`. */
export interface Phase2GasModel {
  readonly gasUnits: bigint;
  readonly gasPriceWei: Wei;
  /** Raw asset units per 1 whole native token, on the 1e18 scale. */
  readonly rawPerNative: bigint;
}

/** Observed chain state needed to evaluate a Phase 2 step. */
export interface Phase2ChainSnapshot {
  /** B0: executor's `asset` balance before the step. */
  readonly preBalance: Raw;
  /** Current block timestamp (seconds). */
  readonly nowTs: bigint;
  /** Phase the executor's machine is currently in (a `Phase` value). */
  readonly phase: number;
  /** True iff the executor has a position recorded as open. */
  readonly positionOpen: boolean;
  /** D recorded at open, when a position is open. */
  readonly recordedDeployedRaw: Raw;
  /**
   * Balances of any non-asset tokens the step's legs consume — typically the
   * position token redeemed at close. Keyed by token address (case-insensitive).
   * Absent tokens are treated as zero, which makes an unbacked redemption fail
   * the projection rather than silently pass.
   */
  readonly extraBalances?: Readonly<Record<string, Raw>>;
}

/**
 * Projects the executor's `asset` balance after running every leg.
 *
 * Legs are applied in order. Unlike Phase 1 there is no borrow step, so the
 * projection starts from B0 alone. Each leg's realised output is taken to be its
 * `minAmountOut` — the conservative choice. A plan that only passes the gate on
 * quoted output is not a plan that passes on-chain.
 *
 * Throws `AccountingError` if a leg over-spends its input token or sizes to zero.
 *
 * LEG SIZING. A leg may be sized two ways, mirroring `IV6HFExecutor.Leg`:
 *   amountIn >  0  -> spend exactly `amountIn`
 *   amountIn == 0  -> spend floor(balanceOf(tokenIn) * amountInBps / 1e4)
 *
 * The bps form is what makes a CHAINED plan expressible. Legs run sequentially
 * against the SAME balance sheet, so a leg may legitimately consume the output
 * the previous leg produced. Without it, each leg of an N-leg plan would have to
 * declare the full notional and the projection would reject the plan as
 * over-spending — which is exactly the bug this replaces.
 *
 * TOKENS. `tokenIn` and `tokenOut` may differ (the normal case: USDC -> LST ->
 * USDC). `extraBalances` seeds the starting balance of any non-accounting token the
 * chain touches; without it a leg selling the counter-asset would see a zero
 * balance. `Phase2Executor._executeLeg` rejects `tokenIn == tokenOut`, so a
 * same-token leg is a hard error here too rather than a silently different meaning
 * for `minAmountOut`.
 *
 * Resizing is BOUNDED, never invented: if `amountInBps` yields zero the leg is
 * rejected, and if the resolved amount exceeds the balance the leg is rejected.
 * A plan is never silently clamped into solvency.
 */
export function projectPhase2PostBalance(
  plan: Phase2Plan,
  preBalance: Raw,
  extraBalances: Readonly<Record<string, Raw>> = {},
): Raw {
  const balances = new Map<string, Raw>();
  const key = (a: string) => a.toLowerCase();

  balances.set(key(plan.asset), preBalance);
  for (const [token, amount] of Object.entries(extraBalances)) {
    balances.set(key(token), amount);
  }

  const get = (a: string): Raw => balances.get(key(a)) ?? 0n;
  const set = (a: string, v: Raw): void => {
    if (v < 0n) throw new AccountingError(`projectPhase2PostBalance: negative balance for ${a}`);
    balances.set(key(a), v);
  };

  for (let i = 0; i < plan.legs.length; i++) {
    const leg = plan.legs[i];
    if (!leg) throw new AccountingError(`projectPhase2PostBalance: missing leg ${i}`, { leg: String(i) });

    const available = get(leg.tokenIn);

    // Mirror `Phase2Executor._executeLeg`: a same-token leg is rejected, because
    // `minAmountOut` would measure the NET delta rather than gross output.
    if (leg.tokenIn.toLowerCase() === leg.tokenOut.toLowerCase()) {
      throw new AccountingError(`projectPhase2PostBalance: leg ${i} aliases tokenIn and tokenOut`, {
        leg: String(i),
      });
    }

    // Resolve the spend amount EXACTLY as `Phase2Executor._executeLeg` does:
    // a non-zero `amountIn` wins and `amountInBps` is ignored. Rejecting the pair
    // here would make the off-chain projection stricter than the contract, which
    // is a divergence bug in its own right — the projection must model the chain,
    // not a tidier variant of it.
    const amountIn: Raw =
      leg.amountIn > 0n
        ? leg.amountIn
        : (available * leg.amountInBps) / BPS_DENOMINATOR;

    if (amountIn === 0n) {
      throw new AccountingError(`projectPhase2PostBalance: leg ${i} sizes to zero`, { leg: String(i) });
    }
    if (amountIn > available) {
      throw new AccountingError(`projectPhase2PostBalance: leg ${i} over-spends tokenIn`, {
        leg: String(i),
        amountIn: amountIn.toString(),
        available: available.toString(),
      });
    }

    set(leg.tokenIn, available - amountIn);
    set(leg.tokenOut, get(leg.tokenOut) + leg.minAmountOut);
  }

  return get(plan.asset);
}

/**
 * Full signed-carry evaluation of a Phase 2 step.
 *
 * Throws `AccountingError` only for structurally impossible inputs (zero
 * principal, empty legs, expiry). A NEGATIVE carry is not an error — it is a
 * legitimate outcome that the gate then judges against the floor.
 */
export function evaluatePhase2Step(
  plan: Phase2Plan,
  snapshot: Phase2ChainSnapshot,
  gas: Phase2GasModel,
  step: Phase2Step,
): Phase2Economics {
  if (plan.deployedRaw <= 0n) throw new AccountingError("evaluatePhase2Step: zero deployed principal");
  if (plan.legs.length === 0) throw new AccountingError("evaluatePhase2Step: empty legs");
  if (snapshot.nowTs > plan.deadline) {
    throw new AccountingError("evaluatePhase2Step: plan expired", {
      deadline: plan.deadline.toString(),
      now: snapshot.nowTs.toString(),
    });
  }

  const deployedRaw = plan.deployedRaw;
  const preBalance = snapshot.preBalance;
  const postBalance = projectPhase2PostBalance(plan, preBalance, snapshot.extraBalances ?? {});

  // (1) carry = R - B0, signed, computed without ever forming a negative uint.
  //
  // Phase 2 borrows nothing and pays no flash fee, so the Phase 1 invariant
  // `R >= B0 + L + F + P` reduces to `R >= B0 + P` — i.e. `carry >= floor` with
  // `carry = R - B0`. The signed form is a strict generalisation: with `F >= 0`
  // it is exactly that, and with `F < 0` it expresses a bounded-loss de-risking
  // step, which Phase 1 cannot.
  //
  // `D` (deployedRaw) is the principal. It is NOT subtracted: the principal is
  // the executor's working float and is reused across positions, so it is already
  // inside B0. Subtracting it would double-count. D is enforced separately — it
  // must match the principal recorded at open, and it drives the sizing.
  //
  // INTERFACE CONTRACT: a Phase 2 venue adapter MUST return the accounting asset,
  // converting any native position representation (LST, LP share, lending receipt)
  // back into it, so that this balance assertion is meaningful.
  const carryRaw = signedDelta(postBalance, preBalance);

  // (2) carryNet = carry - C
  const costRaw = plan.maxCostRaw;
  const carryNetRaw = carryRaw - costRaw;

  const carryFloorRaw = plan.minCarryRaw;

  // (3) off-chain gate: carryNet >= F
  const gatePassed = carryNetRaw >= carryFloorRaw;

  // (4) on-chain invariant: carry >= F
  const invariantHolds = carryRaw >= carryFloorRaw;

  // A step is a bounded-loss de-risking close iff it is allowed to end negative.
  const isBoundedLoss = carryFloorRaw < 0n;

  // Gas is reported for the budget ledger; it is charged in native units, not
  // against the carry floor, because the floor is denominated in the asset.
  void gas;

  return {
    deployedRaw,
    preBalance,
    postBalance,
    carryRaw,
    costRaw,
    carryNetRaw,
    carryFloorRaw,
    gatePassed,
    invariantHolds,
    isBoundedLoss,
  };
}

/**
 * Signed difference `a - b` without ever computing a negative unsigned value.
 * The explicit ordering test is what makes the widening cast safe.
 */
export function signedDelta(a: Raw, b: Raw): SignedRaw {
  if (a >= b) return a - b;
  return -(b - a);
}

/**
 * The Phase 2 submission gate, standalone. Mirrors `RawMath.carryMeetsFloor`.
 * Kept as its own function so the gate can be asserted in isolation.
 */
export function carryMeetsFloor(carryRaw: SignedRaw, floorRaw: SignedRaw): boolean {
  return carryRaw >= floorRaw;
}

/**
 * Break-even carry floor for a step: the floor at which the step neither earns
 * nor loses. Used by strategies to size a position so that the gate is reachable.
 */
export function breakEvenFloor(costRaw: Raw): SignedRaw {
  return -costRaw;
}

/**
 * Maximum principal that still satisfies the gate for a given per-unit edge.
 *
 *   carryNet(D) = floor(D * edgeBps / 1e4) - C
 *   require carryNet(D) >= F
 *   =>  D >= (F + C) * 1e4 / edgeBps
 *
 * Returns the largest D <= hardCap satisfying the gate, or 0n if none does.
 * Both terms are monotone in D, so we solve the closed form and then walk down a
 * bounded number of units to absorb the flooring direction.
 */
export function maxDeployedForGate(
  edgeBps: bigint,
  costRaw: Raw,
  carryFloorRaw: SignedRaw,
  hardCap: Raw,
): Raw {
  if (edgeBps <= 0n) return 0n;

  const target = carryFloorRaw + costRaw; // signed
  if (target <= 0n) {
    // Any positive D clears the gate; the cap is the binding constraint.
    return hardCap;
  }

  let candidate = ceilDiv(target * 10_000n, edgeBps);
  if (candidate > hardCap) candidate = hardCap;

  for (let i = 0; i < 8 && candidate > 0n; i++) {
    const carry = (candidate * edgeBps) / 10_000n;
    if (carry - costRaw >= carryFloorRaw) return candidate;
    candidate -= 1n;
  }
  return 0n;
}

/**
 * Converts a signed carry into native wei at an integer price, for the budget
 * ledger's "is this step worth its gas" check. Flooring toward zero is deliberate:
 * a gas-credit estimate must never overstate the native value of a gain, and must
 * never understate the native cost of a loss.
 */
export function carryToNativeWei(carryRaw: SignedRaw, rawPerNative: bigint): Wei {
  if (rawPerNative <= 0n) throw new AccountingError("carryToNativeWei: non-positive price");
  const magnitude = carryRaw < 0n ? -carryRaw : carryRaw;
  const wei = (magnitude * 10n ** 18n) / rawPerNative;
  return carryRaw < 0n ? -wei : wei;
}

/**
 * Validates that every leg carries the action tag the step requires.
 *
 * This is the off-chain half of the on-chain `LegActionMismatch` check. Running
 * it before signing means a mis-tagged plan is caught locally instead of burning
 * a transaction and tripping the on-chain breaker with code 8.
 */
export function assertLegActions(legs: readonly P2Leg[], expectedAction: number): void {
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (!leg) throw new AccountingError(`assertLegActions: missing leg ${i}`, { leg: String(i) });
    if (leg.action !== expectedAction) {
      throw new AccountingError(
        `assertLegActions: leg ${i} carries action ${leg.action}, step requires ${expectedAction}`,
        { leg: String(i), expected: String(expectedAction), actual: String(leg.action) },
      );
    }
  }
}
