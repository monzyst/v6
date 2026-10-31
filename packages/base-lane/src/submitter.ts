import {
  Contract,
  JsonRpcProvider,
  type TransactionReceipt,
  type TransactionResponse,
} from "ethers";
import {
  BudgetLedger,
  CircuitBreaker,
  hashLegs,
  hashPlan,
  planFingerprint,
  type ExecutionPlan,
} from "@v6hf/core";
import type { BaseLaneConfig } from "./config.js";
import type { IsolatedSigners } from "./signers.js";
import { preflight, type GateVerdict } from "./preflight.js";

/**
 * Base lane submitter.
 *
 * Owns the full lifecycle of one plan:
 *
 *   preflight -> reserve -> sign (cold) -> send (hot) -> confirm -> settle
 *
 * Two properties matter more than speed:
 *
 *   1. The budget reservation is taken BEFORE the cold key signs. A plan that
 *      cannot be paid for is never signed, so a signature can never leak into
 *      the wild attached to an unaffordable transaction.
 *
 *   2. `execute` returns (bool success, uint256 netProfit). A non-reverting
 *      transaction with success == false means the cycle failed and the breaker
 *      is now open on-chain. This class treats that as a failure, not a success,
 *      and trips the local breaker to match.
 */

export const EXECUTOR_ABI = [
  "function execute((address loanAsset,uint256 loanAmount,uint256 minNetProfitRaw,uint256 maxFlashFeeRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline,address profitRecipient,(address router,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountInBps,uint256 minAmountOut,uint24 poolFee,uint8 dexKind,bool stable,uint256 deadline)[] legs) plan, bytes authorizerSignature) returns (bool success, uint256 netProfitRaw)",
  "function hashPlan((address loanAsset,uint256 loanAmount,uint256 minNetProfitRaw,uint256 maxFlashFeeRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline,address profitRecipient,(address router,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountInBps,uint256 minAmountOut,uint24 poolFee,uint8 dexKind,bool stable,uint256 deadline)[] legs) plan) view returns (bytes32)",
  "function breakerOpen() view returns (bool)",
  "function breakerReason() view returns (uint8)",
  "function phase() view returns (uint8)",
  "function gasBudgetPoolWei() view returns (uint256)",
  "function gasReservedWei() view returns (uint256)",
  "function availableGasBudgetWei() view returns (uint256)",
  "function authorizer() view returns (address)",
  "function owner() view returns (address)",
  "function isExecutor(address) view returns (bool)",
  "function EXECUTION_PLAN_TYPEHASH() view returns (bytes32)",
  "function LEG_TYPEHASH() view returns (bytes32)",
  "function cyclesSucceeded() view returns (uint256)",
  "function cyclesFailed() view returns (uint256)",
  "function cumulativeNetProfitRaw() view returns (uint256)",
  "event Executed(bytes32 indexed planHash,uint256 loanAmount,uint256 flashFeeRaw,uint256 grossSurplusRaw,uint256 netProfitRaw,uint256 gasSpentWei)",
  "event CycleFailed(bytes32 indexed planHash,uint8 indexed reason,bytes revertData)",
  "event BreakerTripped(uint8 indexed reason,bytes32 indexed planHash,uint256 observed,uint256 required)",
] as const;

/**
 * Typed view of the executor contract. ethers' `Contract` indexes methods as
 * possibly-undefined, which under `strict` makes every call site a type error.
 * Declaring the surface once here keeps the call sites honest and readable.
 */
type ExecuteFn = ((
  plan: unknown,
  signature: string,
  overrides?: { gasLimit?: bigint; maxFeePerGas?: bigint },
) => Promise<TransactionResponse>) & {
  staticCall(plan: unknown, signature: string): Promise<[boolean, bigint]>;
};

interface ExecutorContract {
  execute: ExecuteFn;
  breakerOpen(): Promise<boolean>;
  breakerReason(): Promise<bigint>;
  phase(): Promise<bigint>;
  gasBudgetPoolWei(): Promise<bigint>;
  gasReservedWei(): Promise<bigint>;
  availableGasBudgetWei(): Promise<bigint>;
  interface: Contract["interface"];
}

export interface SubmitResult {
  readonly ok: boolean;
  readonly planHash: string;
  readonly fingerprint: string;
  readonly txHash: string | null;
  readonly netProfitRaw: bigint;
  readonly gasSpentWei: bigint;
  readonly verdict: GateVerdict;
  readonly error: string | null;
}

export interface SubmitterDeps {
  readonly provider: JsonRpcProvider;
  readonly signers: IsolatedSigners;
  readonly budget: BudgetLedger;
  readonly breaker: CircuitBreaker;
  readonly cfg: BaseLaneConfig;
  readonly nowTs: () => bigint;
  readonly log: (event: string, data: Record<string, unknown>) => void;
}

export class BaseLaneSubmitter {
  private readonly executorContract: Contract;

  constructor(private readonly deps: SubmitterDeps) {
    this.executorContract = new Contract(deps.cfg.executor, EXECUTOR_ABI, deps.provider);
  }

  /**
   * Submits one plan end to end. Never throws for an expected rejection: every
   * outcome is returned as a `SubmitResult` so the supervisor can decide.
   */
  async submit(
    plan: ExecutionPlan,
    snapshot: Parameters<typeof preflight>[1]["snapshot"],
    gas: Parameters<typeof preflight>[1]["gas"],
  ): Promise<SubmitResult> {
    const { cfg, budget, breaker, signers, provider, log } = this.deps;
    const fingerprint = planFingerprint(plan);
    const planHash = hashPlan(plan, { chainId: BigInt(cfg.chainId), verifyingContract: cfg.executor });

    // ---- 0. Breaker must be closed before anything else happens ----
    try {
      breaker.assertClosed();
    } catch (err) {
      return this.rejected(planHash, fingerprint, null, String(err));
    }

    // ---- 1. Pre-flight gates ----
    const verdict = preflight(cfg, {
      plan,
      snapshot,
      gas,
      availableBudgetWei: budget.availableWei,
    });
    if (!verdict.passed) {
      log("preflight.rejected", { gate: verdict.failedGate, reason: verdict.reason, planHash });
      return this.rejected(planHash, fingerprint, verdict, verdict.reason);
    }

    // ---- 2. Reserve the gas budget BEFORE signing ----
    const reservationId = `base:${plan.nonce}:${fingerprint.slice(0, 12)}`;
    try {
      budget.reserve(reservationId, plan.gasBudgetWei, `plan ${plan.nonce}`);
    } catch (err) {
      return this.rejected(planHash, fingerprint, verdict, String(err));
    }

    let tx: TransactionResponse | null = null;
    try {
      // ---- 3. Cold key signs the EIP-712 digest ----
      const signature = await signers.authorizer.signTypedData(
        {
          name: "V6-HF",
          version: "1",
          chainId: BigInt(cfg.chainId),
          verifyingContract: cfg.executor,
        },
        {
          // Only ExecutionPlan: the plan commits to its legs via legsHash, so
          // including Leg here would be an unused type and ethers rejects it.
          ExecutionPlan: [
            { name: "loanAsset", type: "address" },
            { name: "loanAmount", type: "uint256" },
            { name: "minNetProfitRaw", type: "uint256" },
            { name: "maxFlashFeeRaw", type: "uint256" },
            { name: "gasBudgetWei", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "profitRecipient", type: "address" },
            { name: "legsHash", type: "bytes32" },
          ],
        },
        {
          loanAsset: plan.loanAsset,
          loanAmount: plan.loanAmount,
          minNetProfitRaw: plan.minNetProfitRaw,
          maxFlashFeeRaw: plan.maxFlashFeeRaw,
          gasBudgetWei: plan.gasBudgetWei,
          nonce: plan.nonce,
          deadline: plan.deadline,
          profitRecipient: plan.profitRecipient,
          legsHash: hashLegs(plan.legs),
        },
      );

      // ---- 4. Hot key sends ----
      const connected = this.executorContract.connect(signers.executor) as unknown as ExecutorContract;
      const gasLimit = cfg.gasUnitsPerCycle;
      const feeData = await provider.getFeeData();
      const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;

      if (maxFeePerGas > cfg.gasPriceCeilingWei) {
        budget.release(reservationId);
        breaker.tripBreaker("BUDGET", `gas price ${maxFeePerGas} > ceiling ${cfg.gasPriceCeilingWei}`);
        return this.rejected(planHash, fingerprint, verdict, "gas price above ceiling");
      }

      if (cfg.dryRun) {
        // Simulate only. The reservation is released; nothing is broadcast.
        await connected.execute.staticCall(toContractPlan(plan), signature);
        budget.release(reservationId);
        log("submit.dryRun", { planHash });
        return {
          ok: true,
          planHash,
          fingerprint,
          txHash: null,
          netProfitRaw: verdict.economics?.netProfitAfterGas ?? 0n,
          gasSpentWei: 0n,
          verdict,
          error: null,
        };
      }

      tx = await connected.execute(toContractPlan(plan), signature, {
        gasLimit,
        maxFeePerGas,
      });

      const receipt: TransactionReceipt | null = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        budget.release(reservationId);
        breaker.recordFailure(`tx reverted: ${tx.hash}`);
        return this.rejected(planHash, fingerprint, verdict, `transaction reverted: ${tx.hash}`);
      }

      // ---- 5. Decode the (success, netProfit) return value ----
      const decoded = this.decodeExecuteResult(receipt, planHash);
      const gasSpentWei = receipt.gasUsed * (receipt.gasPrice ?? maxFeePerGas);

      if (!decoded.success) {
        // The cycle failed but the transaction did not revert: the on-chain
        // breaker is now open. Mirror it locally and stop.
        budget.settle(reservationId, gasSpentWei);
        breaker.recordFailure(`cycle failed on-chain: ${decoded.reason}`);
        breaker.tripBreaker("HEALTH", `on-chain cycle failure: ${decoded.reason}`);
        return {
          ok: false,
          planHash,
          fingerprint,
          txHash: tx.hash,
          netProfitRaw: 0n,
          gasSpentWei,
          verdict,
          error: `cycle failed on-chain: ${decoded.reason}`,
        };
      }

      budget.settle(reservationId, gasSpentWei);
      breaker.recordSuccess();
      log("submit.ok", { planHash, txHash: tx.hash, netProfitRaw: decoded.netProfit.toString() });

      return {
        ok: true,
        planHash,
        fingerprint,
        txHash: tx.hash,
        netProfitRaw: decoded.netProfit,
        gasSpentWei,
        verdict,
        error: null,
      };
    } catch (err) {
      // Any throw after reservation must release it, or the ledger leaks.
      try {
        budget.release(reservationId);
      } catch {
        /* already settled */
      }
      breaker.recordFailure(String(err));
      log("submit.error", { planHash, error: String(err) });
      return this.rejected(planHash, fingerprint, verdict, String(err));
    }
  }

  /** Reads the on-chain breaker and budget, for the supervisor's health loop. */
  async readChainState(): Promise<{
    breakerOpen: boolean;
    breakerReason: number;
    phase: number;
    poolWei: bigint;
    reservedWei: bigint;
    availableWei: bigint;
  }> {
    const c = this.executorContract as unknown as ExecutorContract;
    const [breakerOpen, breakerReason, phase, poolWei, reservedWei, availableWei] = await Promise.all([
      c.breakerOpen(),
      c.breakerReason(),
      c.phase(),
      c.gasBudgetPoolWei(),
      c.gasReservedWei(),
      c.availableGasBudgetWei(),
    ]);
    return {
      breakerOpen,
      breakerReason: Number(breakerReason),
      phase: Number(phase),
      poolWei,
      reservedWei,
      availableWei,
    };
  }

  private decodeExecuteResult(
    receipt: TransactionReceipt,
    planHash: string,
  ): { success: boolean; netProfit: bigint; reason: string } {
    for (const log of receipt.logs) {
      try {
        const parsed = this.executorContract.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        if (parsed.name === "Executed" && parsed.args.planHash === planHash) {
          return { success: true, netProfit: parsed.args.netProfitRaw as bigint, reason: "" };
        }
        if (parsed.name === "CycleFailed" && parsed.args.planHash === planHash) {
          return { success: false, netProfit: 0n, reason: `breaker reason ${parsed.args.reason}` };
        }
      } catch {
        // Not one of our events; ignore.
      }
    }
    // No matching event: treat as failure rather than assuming success.
    return { success: false, netProfit: 0n, reason: "no Executed event in receipt" };
  }

  private rejected(
    planHash: string,
    fingerprint: string,
    verdict: GateVerdict | null,
    error: string,
  ): SubmitResult {
    return {
      ok: false,
      planHash,
      fingerprint,
      txHash: null,
      netProfitRaw: 0n,
      gasSpentWei: 0n,
      verdict: verdict ?? { passed: false, failedGate: null, reason: error, economics: null },
      error,
    };
  }
}

/** Converts the internal plan to the tuple shape ethers expects. */
function toContractPlan(plan: ExecutionPlan) {
  return {
    loanAsset: plan.loanAsset,
    loanAmount: plan.loanAmount,
    minNetProfitRaw: plan.minNetProfitRaw,
    maxFlashFeeRaw: plan.maxFlashFeeRaw,
    gasBudgetWei: plan.gasBudgetWei,
    nonce: plan.nonce,
    deadline: plan.deadline,
    profitRecipient: plan.profitRecipient,
    legs: plan.legs.map((l) => ({
      router: l.router,
      tokenIn: l.tokenIn,
      tokenOut: l.tokenOut,
      amountIn: l.amountIn,
      amountInBps: l.amountInBps,
      minAmountOut: l.minAmountOut,
      poolFee: l.poolFee,
      dexKind: l.dexKind,
      stable: l.stable,
      deadline: l.deadline,
    })),
  };
}
