import { evaluatePlan, flashFeeRaw, BudgetLedger, CircuitBreaker, hashPlan, hashLegs, keccak256Utf8, PLAN_TYPE_STRING, LEG_TYPE_STRING, parseUnits, formatUnits, maxLoanForGate } from "../dist/packages/core/src/index.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const R1 = "0x1111111111111111111111111111111111111111";
const R2 = "0x2222222222222222222222222222222222222222";

// 100k USDC loan, 6 decimals
const L = parseUnits("100000", 6);
const feeWad = 0n; // Morpho fee 0 for this test
const P = parseUnits("5", 6); // require 5 USDC net

// leg1: USDC -> WETH at 1:1 raw (mock), leg2: WETH -> USDC at 1.0008
const plan = {
  loanAsset: USDC, loanAmount: L, minNetProfitRaw: P, maxFlashFeeRaw: parseUnits("1",6),
  gasBudgetWei: 10n**15n, nonce: 1n, deadline: 2000000000n, profitRecipient: R1,
  legs: [
    { router: R1, tokenIn: USDC, tokenOut: WETH, amountIn: 0n, amountInBps: 10000n, minAmountOut: L, poolFee: 0, dexKind: 0, stable: false, deadline: 2000000000n },
    { router: R2, tokenIn: WETH, tokenOut: USDC, amountIn: 0n, amountInBps: 10000n, minAmountOut: (L*10008n)/10000n, poolFee: 0, dexKind: 0, stable: false, deadline: 2000000000n },
  ],
};

const snap = { preBalance: 0n, morphoFeeWad: feeWad, nowTs: 1900000000n };
const gas = { gasUnits: 400000n, gasPriceWei: 1000000000n, rawPerNative: 3000n * 10n**6n };

const e = evaluatePlan(plan, snap, gas);
console.log("S  =", formatUnits(e.grossSurplus,6), "USDC");
console.log("F  =", formatUnits(e.flashFee,6));
console.log("N  =", formatUnits(e.netProfit,6));
console.log("G  =", formatUnits(e.gasCostRaw,6), "USDC (gas in raw)");
console.log("N' =", formatUnits(e.netProfitAfterGas,6));
console.log("gatePassed =", e.gatePassed, " invariantHolds =", e.invariantHolds);

// exact integer check: 100000 * 0.0008 = 80 USDC
console.assert(e.grossSurplus === parseUnits("80",6), "gross surplus must be exactly 80 USDC");
console.assert(e.gatePassed === true, "gate should pass");

// fee rounding: ceil
console.assert(flashFeeRaw(3n, 333333333333333333n) === 1n, "ceil fee");
console.log("ceil fee ok");

// budget ledger
const b = new BudgetLedger(10n**17n);
b.reserve("a", 4n*10n**16n);
console.assert(b.availableWei === 6n*10n**16n, "reserve");
const refund = b.settle("a", 3n*10n**16n);
console.assert(refund === 10n**16n, "refund");
console.log("budget ok", b.snapshot());

// breaker
const cb = new CircuitBreaker({ maxConsecutiveFailures: 2, maxSlippageBps: 50n });
cb.recordFailure("x"); cb.recordFailure("y");
console.assert(cb.isOpen === true, "breaker should open");
console.log("breaker ok:", cb.lastTrip.reason);

// eip712 determinism
const h1 = hashPlan(plan, { chainId: 8453n, verifyingContract: R1 });
const h2 = hashPlan(plan, { chainId: 8453n, verifyingContract: R1 });
console.assert(h1 === h2, "digest deterministic");
console.log("planHash =", h1);
console.log("PLAN_TYPEHASH =", keccak256Utf8(PLAN_TYPE_STRING));
console.log("LEG_TYPEHASH  =", keccak256Utf8(LEG_TYPE_STRING));

// sizing
const maxL = maxLoanForGate(8n, 0n, e.gasCostRaw, P, parseUnits("10000000",6));
console.log("maxLoanForGate(8bps) =", formatUnits(maxL,6), "USDC");
console.log("ALL SMOKE CHECKS PASSED");
