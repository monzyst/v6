import { Contract, JsonRpcProvider, type TransactionReceipt, type TransactionResponse } from "ethers";
import {
  BudgetLedger,
  CircuitBreaker,
  hashPhase2Plan,
  phase2Fingerprint,
  PHASE2_STEP_ACTION,
  type Phase2ChainSnapshot,
  type Phase2GasModel,
  type Phase2Plan,
  type Phase2Step,
} from "@v6hf/core";
import type { Phase2LaneConfig } from "./config.js";
import type { Phase2Signers } from "./signers.js";
import { phase2Preflight, type Phase2GateVerdict } from "./gate.js";

/**
 * Phase 2 submitter.
 *
 * Owns the full lifecycle of one Phase 2 step:
 *
 *   preflight -> reserve -> sign (cold) -> send (hot) -> confirm -> settle
 *
 * Two properties matter more than speed, and both are inherited from the Phase 1
 * submitter because they are properties of the design, not of the lane:
 *
 *   1. The budget reservation is taken BEFORE the cold key signs. A step that
 *      cannot be paid for is never signed, so a signature can never leak into the
 *      wild attached to an unaffordable transaction.
 *
 *   2. `openPosition` / `hedgePosition` / `closePosition` return
 *      `(bool success, int256 realisedCarryRaw)`. A non-reverting transaction with
 *      `success == false` means the step failed and the breaker is now open
 *      on-chain. This class treats that as a failure, not a success, and trips the
 *      local breaker to match.
 */

export const PHASE2_EXECUTOR_ABI = [
  "function openPosition((uint8 strategy,address asset,uint256 deployedRaw,int256 minCarryRaw,uint256 maxCostRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline,address profitRecipient,(address venue,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 action,uint256 deadline)[] legs) plan, bytes authorizerSignature) returns (bool success, int256 realisedCarryRaw)",
  "function hedgePosition((uint8 strategy,address asset,uint256 deployedRaw,int256 minCarryRaw,uint256 maxCostRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline,address profitRecipient,(address venue,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 action,uint256 deadline)[] legs) plan, bytes authorizerSignature) returns (bool success, int256 realisedCarryRaw)",
  "function closePosition((uint8 strategy,address asset,uint256 deployedRaw,int256 minCarryRaw,uint256 maxCostRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline,address profitRecipient,(address venue,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 action,uint256 deadline)[] legs) plan, bytes authorizerSignature) returns (bool success, int256 realisedCarryRaw)",
  "function hashPlan((uint8 strategy,address asset,uint256 deployedRaw,int256 minCarryRaw,uint256 maxCostRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline,address profitRecipient,(address venue,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 action,uint256 deadline)[] legs) plan) view returns (bytes32)",
  "function breakerOpen() view returns (bool)",
  "function breakerReason() view returns (uint8)",
  "function phase() view returns (uint8)",
  "function position() view returns (uint256 positionId, uint8 strategy, address asset, uint256 deployedRaw, uint256 openedAt, int256 realisedCarryRaw, bool open)",
  "function gasBudgetPoolWei() view returns (uint256)",
  "function gasReservedWei() view returns (uint256)",
  "function availableGasBudgetWei() view returns (uint256)",
  "function authorizer() view returns (address)",
  "function owner() view returns (address)",
  "function isExecutor(address) view returns (bool)",
  "function PHASE2_PLAN_TYPEHASH() view returns (bytes32)",
  "function P2_LEG_TYPEHASH() view returns (bytes32)",
  "function stepsSucceeded() view returns (uint256)",
  "function stepsFailed() view returns (uint256)",
  "function cumulativeCarryRaw() view returns (int256)",
  "event Phase2Executed(bytes32 indexed planHash,uint8 indexed strategy,uint8 indexed action,uint256 deployedRaw,int256 realisedCarryRaw,uint256 gasSpentWei)",
  "event Phase2Failed(bytes32 indexed planHash,uint8 indexed reason,bytes revertData)",
  "event PositionOpened(uint256 indexed positionId,uint8 indexed strategy,address indexed asset,uint256 deployedRaw,uint256 openedAt)",
  "event PositionClosed(uint256 indexed positionId,int256 realisedCarryRaw,address indexed profitRecipient,uint256 sweptRaw)",
] as const;

type StepFn = ((
  plan: unknown,
  signature: string,
  overrides?: { gasLimit?: bigint; maxFeePerGas?: bigint },
) => Promise<TransactionResponse>) & {
  staticCall(plan: unknown, signature: string): Promise<[boolean, bigint]>;
};

interface Phase2ExecutorContract {
  openPosition: StepFn;
  hedgePosition: StepFn;
  closePosition: StepFn;
  breakerOpen(): Promise<boolean>;
  breakerReason(): Promise<bigint>;
  phase(): Promise<bigint>;
  position(): Promise<[bigint, bigint, string, bigint, bigint, bigint, boolean]>;
  gasBudgetPoolWei(): Promise<bigint>;
  gasReservedWei(): Promise<bigint>;
  availableGasBudgetWei(): Promise<bigint>;
  interface: Contract["interface"];
}

export interface Phase2SubmitResult {
  readonly ok: boolean;
  readonly planHash: string;
  readonly fingerprint: string;
  readonly step: Phase2Step;
  readonly txHash: string | null;
  readonly realisedCarryRaw: bigint;
  readonly gasSpentWei: bigint;
  readonly verdict: Phase2GateVerdict;
  readonly error: string | null;
}

export interface Phase2SubmitterDeps {
  readonly provider: JsonRpcProvider;
  readonly signers: Phase2Signers;
  readonly budget: BudgetLedger;
  readonly breaker: CircuitBreaker;
  readonly cfg: Phase2LaneConfig;
  readonly nowTs: () => bigint;
  readonly log: (event: string, data: Record<string, unknown>) => void;
}

export class Phase2Submitter {
  private readonly contract: Contract;

  constructor(private readonly deps: Phase2SubmitterDeps) {
    this.contract = new Contract(deps.cfg.phase2Executor, PHASE2_EXECUTOR_ABI, deps.provider);
  }

  async submit(
    plan: Phase2Plan,
    step: Phase2Step,
    snapshot: Phase2ChainSnapshot,
    gas: Phase2GasModel,
  ): Promise<Phase2SubmitResult> {
    const { cfg, budget, breaker, signers, provider, log } = this.deps;
    const fingerprint = phase2Fingerprint(plan);
    const planHash = hashPhase2Plan(plan, {
      chainId: BigInt(cfg.chainId),
      verifyingContract: cfg.phase2Executor,
    });

    // ---- 0. Breaker must be closed before anything else happens ----
    try {
      breaker.assertClosed();
    } catch (err) {
      return this.rejected(planHash, fingerprint, step, null, String(err));
    }

    // ---- 1. Pre-flight gates (includes the phase lock) ----
    const verdict = phase2Preflight(cfg, {
      plan,
      step,
      snapshot,
      gas,
      availableBudgetWei: budget.availableWei,
    });
    if (!verdict.passed) {
      log("phase2.preflight.rejected", { gate: verdict.failedGate, reason: verdict.reason, planHash });
      return this.rejected(planHash, fingerprint, step, verdict, verdict.reason);
    }

    // ---- 2. Reserve the gas budget BEFORE signing ----
    const reservationId = `p2:${step}:${plan.nonce}:${fingerprint.slice(0, 12)}`;
    try {
      budget.reserve(reservationId, plan.gasBudgetWei, `phase2 ${step} ${plan.nonce}`);
    } catch (err) {
      return this.rejected(planHash, fingerprint, step, verdict, String(err));
    }

    let tx: TransactionResponse | null = null;
    try {
      // ---- 3. Cold key signs the Phase 2 digest ----
      const signature = await signers.authorizer.signTypedData(
        {
          name: "V6-HF-PHASE2",
          version: "1",
          chainId: BigInt(cfg.chainId),
          verifyingContract: cfg.phase2Executor,
        },
        {
          // Only Phase2Plan: legs are committed to via legsHash.
          Phase2Plan: [
            { name: "strategy", type: "uint8" },
            { name: "asset", type: "address" },
            { name: "deployedRaw", type: "uint256" },
            { name: "minCarryRaw", type: "int256" },
            { name: "maxCostRaw", type: "uint256" },
            { name: "gasBudgetWei", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "profitRecipient", type: "address" },
            { name: "legsHash", type: "bytes32" },
          ],
        },
        {
          strategy: BigInt(plan.strategy),
          asset: plan.asset,
          deployedRaw: plan.deployedRaw,
          minCarryRaw: plan.minCarryRaw,
          maxCostRaw: plan.maxCostRaw,
          gasBudgetWei: plan.gasBudgetWei,
          nonce: plan.nonce,
          deadline: plan.deadline,
          profitRecipient: plan.profitRecipient,
          legsHash: hashP2LegsForSigning(plan),
        },
      );

      // ---- 4. Hot key sends ----
      const connected = this.contract.connect(signers.executor) as unknown as Phase2ExecutorContract;
      const feeData = await provider.getFeeData();
      const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;

      if (maxFeePerGas > cfg.gasPriceCeilingWei) {
        budget.release(reservationId);
        breaker.tripBreaker("BUDGET", `gas price ${maxFeePerGas} > ceiling ${cfg.gasPriceCeilingWei}`);
        return this.rejected(planHash, fingerprint, step, verdict, "gas price above ceiling");
      }

      const fn = step === "open" ? connected.openPosition : step === "hedge" ? connected.hedgePosition : connected.closePosition;
      const tuple = toContractPlan(plan);

      if (cfg.dryRun) {
        await fn.staticCall(tuple, signature);
        budget.release(reservationId);
        log("phase2.dryRun", { planHash, step });
        return {
          ok: true,
          planHash,
          fingerprint,
          step,
          txHash: null,
          realisedCarryRaw: verdict.economics?.carryNetRaw ?? 0n,
          gasSpentWei: 0n,
          verdict,
          error: null,
        };
      }

      tx = await fn(tuple, signature, { gasLimit: cfg.gasUnitsPerStep, maxFeePerGas });

      const receipt: TransactionReceipt | null = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        budget.release(reservationId);
        breaker.recordFailure(`phase2 tx reverted: ${tx.hash}`);
        return this.rejected(planHash, fingerprint, step, verdict, `transaction reverted: ${tx.hash}`);
      }

      // ---- 5. Decode the (success, carry) return value ----
      const decoded = this.decodeResult(receipt, planHash);
      const gasSpentWei = receipt.gasUsed * (receipt.gasPrice ?? maxFeePerGas);

      if (!decoded.success) {
        budget.settle(reservationId, gasSpentWei);
        breaker.recordFailure(`phase2 step failed on-chain: ${decoded.reason}`);
        breaker.tripBreaker("HEALTH", `on-chain phase2 failure: ${decoded.reason}`);
        return {
          ok: false,
          planHash,
          fingerprint,
          step,
          txHash: tx.hash,
          realisedCarryRaw: 0n,
          gasSpentWei,
          verdict,
          error: `phase2 step failed on-chain: ${decoded.reason}`,
        };
      }

      budget.settle(reservationId, gasSpentWei);
      breaker.recordSuccess();
      log("phase2.ok", { planHash, step, txHash: tx.hash, carry: decoded.carry.toString() });

      return {
        ok: true,
        planHash,
        fingerprint,
        step,
        txHash: tx.hash,
        realisedCarryRaw: decoded.carry,
        gasSpentWei,
        verdict,
        error: null,
      };
    } catch (err) {
      try {
        budget.release(reservationId);
      } catch {
        /* already settled */
      }
      breaker.recordFailure(String(err));
      log("phase2.error", { planHash, step, error: String(err) });
      return this.rejected(planHash, fingerprint, step, verdict, String(err));
    }
  }

  /** Reads the on-chain Phase 2 state, for the supervisor's health loop. */
  async readChainState(): Promise<{
    breakerOpen: boolean;
    breakerReason: number;
    phase: number;
    positionOpen: boolean;
    recordedDeployedRaw: bigint;
    poolWei: bigint;
    reservedWei: bigint;
    availableWei: bigint;
  }> {
    const c = this.contract as unknown as Phase2ExecutorContract;
    const [breakerOpen, breakerReason, phase, pos, poolWei, reservedWei, availableWei] = await Promise.all([
      c.breakerOpen(),
      c.breakerReason(),
      c.phase(),
      c.position(),
      c.gasBudgetPoolWei(),
      c.gasReservedWei(),
      c.availableGasBudgetWei(),
    ]);
    return {
      breakerOpen,
      breakerReason: Number(breakerReason),
      phase: Number(phase),
      positionOpen: pos[6],
      recordedDeployedRaw: pos[3],
      poolWei,
      reservedWei,
      availableWei,
    };
  }

  private decodeResult(
    receipt: TransactionReceipt,
    planHash: string,
  ): { success: boolean; carry: bigint; reason: string } {
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        if (parsed.name === "Phase2Executed" && parsed.args.planHash === planHash) {
          return { success: true, carry: parsed.args.realisedCarryRaw as bigint, reason: "" };
        }
        if (parsed.name === "Phase2Failed" && parsed.args.planHash === planHash) {
          return { success: false, carry: 0n, reason: `breaker reason ${parsed.args.reason}` };
        }
      } catch {
        // Not one of our events; ignore.
      }
    }
    // No matching event: treat as failure rather than assuming success.
    return { success: false, carry: 0n, reason: "no Phase2Executed event in receipt" };
  }

  private rejected(
    planHash: string,
    fingerprint: string,
    step: Phase2Step,
    verdict: Phase2GateVerdict | null,
    error: string,
  ): Phase2SubmitResult {
    return {
      ok: false,
      planHash,
      fingerprint,
      step,
      txHash: null,
      realisedCarryRaw: 0n,
      gasSpentWei: 0n,
      verdict: verdict ?? { passed: false, failedGate: null, reason: error, economics: null },
      error,
    };
  }
}

/** Converts the internal plan to the tuple shape ethers expects. */
function toContractPlan(plan: Phase2Plan) {
  return {
    strategy: plan.strategy,
    asset: plan.asset,
    deployedRaw: plan.deployedRaw,
    minCarryRaw: plan.minCarryRaw,
    maxCostRaw: plan.maxCostRaw,
    gasBudgetWei: plan.gasBudgetWei,
    nonce: plan.nonce,
    deadline: plan.deadline,
    profitRecipient: plan.profitRecipient,
    legs: plan.legs.map((l) => ({
      venue: l.venue,
      tokenIn: l.tokenIn,
      tokenOut: l.tokenOut,
      amountIn: l.amountIn,
      minAmountOut: l.minAmountOut,
      action: l.action,
      deadline: l.deadline,
    })),
  };
}

import { hashP2Legs } from "@v6hf/core";
function hashP2LegsForSigning(plan: Phase2Plan): string {
  return hashP2Legs(plan.legs);
}

/** Re-exported so callers can assert the action tag without importing core. */
export { PHASE2_STEP_ACTION };
