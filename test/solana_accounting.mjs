import { evaluatePlan, parseUnits } from "../dist/packages/core/src/index.js";

/**
 * Solana lane accounting regression suite.
 *
 * The Solana lane reuses the Phase 1 economics engine with `morphoFeeWad = 0n`,
 * because Jupiter Lend flash loans are zero-fee. That reuse is only sound if the
 * route legs carry a real `minAmountOut` floor: the projection derives the
 * post-cycle balance from `minAmountOut` alone.
 *
 * This suite pins the exact defect that was found during the production audit —
 * legs built with `minAmountOut: 0n` made every Solana plan project a zero
 * balance and fail as "cannot repay principal", so the lane could never trade.
 * It also pins the zero-fee identity and the ordering invariant's arithmetic.
 */

const results = [];
const check = (name, cond, extra = "") => {
  results.push([name, cond]);
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  " + extra : ""));
};

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = 1_700_000_000n;
const DEADLINE = NOW + 10n;

/** Builds a Solana-shaped plan: one route leg, zero flash fee. */
function solanaPlan({ loan, legFloor, floor = 0n }) {
  return {
    loanAsset: USDC,
    loanAmount: loan,
    minNetProfitRaw: floor,
    maxFlashFeeRaw: 0n,
    gasBudgetWei: 0n,
    nonce: 1n,
    deadline: DEADLINE,
    profitRecipient: "0x000000000000000000000000000000000000dEaD",
    legs: [
      {
        router: "jupiter-route",
        tokenIn: USDC,
        tokenOut: USDC,
        amountIn: 0n,
        amountInBps: 10_000n,
        minAmountOut: legFloor,
        poolFee: 0,
        dexKind: 0,
        stable: false,
        deadline: DEADLINE,
      },
    ],
  };
}

const snapshot = { preBalance: 0n, morphoFeeWad: 0n, nowTs: NOW };
const gas = { gasUnits: 0n, gasPriceWei: 0n, rawPerNative: 1n };

// ---------------------------------------------------------------------
// 1. The regression: a zero leg floor can never repay principal
// ---------------------------------------------------------------------
console.log("--- zero leg floor (the audited defect) ---");
{
  const plan = solanaPlan({ loan: parseUnits("1000", 6), legFloor: 0n });
  let threw = null;
  try {
    evaluatePlan(plan, snapshot, gas);
  } catch (err) {
    threw = err;
  }
  check("a leg with minAmountOut 0 is rejected, not silently accepted", threw !== null);
  check(
    "the rejection is the principal-repayment failure",
    threw !== null && /negative gross surplus/.test(threw.message),
    threw ? threw.message.slice(0, 60) : "",
  );
}

// ---------------------------------------------------------------------
// 2. A funded route evaluates, and the zero-fee identity holds
// ---------------------------------------------------------------------
console.log("\n--- zero-fee identity ---");
{
  const loan = parseUnits("1000", 6);
  const out = parseUnits("1002", 6); // 0.2% gross edge
  const plan = solanaPlan({ loan, legFloor: out, floor: parseUnits("1", 6) });
  const e = evaluatePlan(plan, snapshot, gas);

  check("a route that returns more than principal evaluates", e !== null);
  check("flash fee is exactly zero on the Solana lane", e.flashFee === 0n, `${e.flashFee}`);
  check(
    "gross surplus = R - B0 - L",
    e.grossSurplus === out - 0n - loan,
    `${e.grossSurplus}`,
  );
  check("net profit equals gross surplus when F = 0", e.netProfit === e.grossSurplus);
  check("the submission gate passes at a 1 USDC floor", e.gatePassed === true);
  check("the on-chain invariant holds", e.invariantHolds === true);
}

// ---------------------------------------------------------------------
// 3. The gate is stricter than the invariant (gas charged off-chain only)
// ---------------------------------------------------------------------
console.log("\n--- gate vs invariant ---");
{
  const loan = parseUnits("1000", 6);
  const out = parseUnits("1000.5", 6); // 0.5 USDC gross
  const plan = solanaPlan({ loan, legFloor: out, floor: parseUnits("0.4", 6) });

  // Gas priced so that it eats the edge: 0.2 USDC of gas.
  const gasCostly = {
    gasUnits: 200_000n,
    gasPriceWei: 1_000_000_000n,
    rawPerNative: parseUnits("3000", 6), // 3000 USDC per SOL
  };
  const e = evaluatePlan(plan, snapshot, gasCostly);

  check("the on-chain invariant still holds (it does not charge gas)", e.invariantHolds === true);
  check("the off-chain gate rejects once gas is charged", e.gatePassed === false);
  check(
    "N' = N - G is strictly below N",
    e.netProfitAfterGas < e.netProfit,
    `${e.netProfitAfterGas} < ${e.netProfit}`,
  );
}

// ---------------------------------------------------------------------
// 4. A route that cannot cover principal + floor is rejected
// ---------------------------------------------------------------------
console.log("\n--- insufficient route ---");
{
  const loan = parseUnits("1000", 6);
  const out = parseUnits("1000.5", 6);
  const plan = solanaPlan({ loan, legFloor: out, floor: parseUnits("5", 6) });
  const e = evaluatePlan(plan, snapshot, gas);
  check("a 5 USDC floor is not met by a 0.5 USDC edge", e.gatePassed === false);
  check("the invariant is also violated", e.invariantHolds === false);
}

// ---------------------------------------------------------------------
// 5. Expiry is enforced before any arithmetic
// ---------------------------------------------------------------------
console.log("\n--- expiry ---");
{
  const plan = solanaPlan({ loan: parseUnits("1000", 6), legFloor: parseUnits("1002", 6) });
  let threw = null;
  try {
    evaluatePlan(plan, { ...snapshot, nowTs: DEADLINE + 1n }, gas);
  } catch (err) {
    threw = err;
  }
  check("an expired intent is rejected", threw !== null && /expired/.test(threw.message));
}

const failed = results.filter(([, c]) => !c);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED:", failed.map(([n]) => n).join(", "));
  process.exit(1);
}
