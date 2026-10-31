import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { getFlashloanIx } from "@jup-ag/lend/flashloan";
import type { SolanaLaneConfig } from "./config.js";
import type { SolanaSigners } from "./signers.js";

/**
 * Jupiter Lend flash-loan executor.
 *
 * Jupiter Lend flash loans are ZERO FEE and require no collateral. The protocol
 * guarantees atomicity by construction: the borrow instruction, the custom
 * instructions, and the payback instruction all live in ONE Solana transaction.
 * If payback fails, the whole transaction reverts and only the network fee is
 * lost. There is therefore no callback and no on-chain phase machine on this
 * lane — the instruction ORDER is the phase machine, and it is enforced here.
 *
 *   [ ComputeBudget.setComputeUnitLimit ]   (optional, for heavy routes)
 *   [ ComputeBudget.setComputeUnitPrice ]   (priority fee, bounded)
 *   borrowIx                                 <- Jupiter Lend
 *   ...customIxs                             <- the arbitrage route
 *   paybackIx                                <- Jupiter Lend
 *
 * The invariant that must hold is the same as the Base lane:
 *
 *   R >= B0 + L + F + P     with F = 0 on this lane
 *
 * Because F = 0, the check reduces to R >= B0 + L + P, and it is enforced by
 * the payback instruction itself: if the account cannot cover L, the transfer
 * fails and the transaction reverts.
 */

export interface SolanaRouteLeg {
  /** Instructions that consume the borrowed funds. */
  readonly instructions: TransactionInstruction[];
  /** Human label, for logs only. */
  readonly label: string;
  /**
   * Guaranteed minimum output of this leg, in loan-asset raw units.
   *
   * This is the Solana analogue of `Leg.minAmountOut` on the Base lane and it is
   * REQUIRED, not optional: the shared economics engine projects the post-cycle
   * balance from `minAmountOut` alone. A leg that carried no floor would project
   * a zero balance, and the plan would be rejected as unable to repay principal
   * — which is the correct outcome for an unquantified route, but it must be
   * expressed by supplying the floor, never by defaulting it to something.
   */
  readonly minAmountOut: bigint;
}

export interface SolanaPlan {
  readonly loanAssetMint: string;
  readonly loanAmount: bigint;
  readonly minNetProfitRaw: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly profitRecipient: string;
  readonly route: SolanaRouteLeg[];
}

export interface BuiltTransaction {
  readonly transaction: VersionedTransaction;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly instructionCount: number;
  readonly computeUnitLimit: number;
  readonly priorityFeeMicroLamports: bigint;
}

/**
 * Builds the atomic borrow -> route -> payback transaction.
 *
 * Ordering is asserted, not assumed: after assembly we re-read the instruction
 * list and verify that the first Jupiter instruction is the borrow and the last
 * is the payback. A route that accidentally appends after payback would still
 * execute, but it would execute with the loan already repaid — a silent
 * correctness bug. The assertion makes that impossible.
 */
export async function buildFlashloanTransaction(
  cfg: SolanaLaneConfig,
  signers: SolanaSigners,
  connection: Connection,
  plan: SolanaPlan,
  priorityFeeMicroLamports: bigint,
): Promise<BuiltTransaction> {
  if (plan.loanAmount <= 0n) throw new Error("buildFlashloanTransaction: zero loan amount");
  if (plan.route.length === 0) throw new Error("buildFlashloanTransaction: empty route");
  if (priorityFeeMicroLamports > cfg.priorityFeeCeilingMicroLamports) {
    throw new Error(
      `priority fee ${priorityFeeMicroLamports} exceeds ceiling ${cfg.priorityFeeCeilingMicroLamports}`,
    );
  }

  const signer = signers.executor.publicKey;
  const asset = new PublicKey(plan.loanAssetMint);

  // ---- 1. Jupiter Lend borrow + payback instructions ----
  const { borrowIx, paybackIx } = await getFlashloanIx({
    connection,
    signer,
    asset,
    amount: new BN(plan.loanAmount.toString()),
  });

  // ---- 2. Custom route instructions ----
  const customIxs = plan.route.flatMap((leg) => leg.instructions);
  if (customIxs.length === 0) throw new Error("buildFlashloanTransaction: route produced no instructions");

  // ---- 3. Assemble in the ONLY correct order ----
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(priorityFeeMicroLamports) }),
    borrowIx,
    ...customIxs,
    paybackIx,
  ];

  // ---- 4. Assert the ordering invariant ----
  assertOrdering(instructions, borrowIx, paybackIx, customIxs.length);

  // ---- 5. Compile and sign (hot key only) ----
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(cfg.commitment);
  const message = new TransactionMessage({
    payerKey: signer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  transaction.sign([signers.executor]);

  return {
    transaction,
    blockhash,
    lastValidBlockHeight,
    instructionCount: instructions.length,
    computeUnitLimit: cfg.computeUnitLimit,
    priorityFeeMicroLamports,
  };
}

/**
 * Verifies borrow is the first Jupiter instruction and payback is the last
 * instruction of the whole transaction.
 */
function assertOrdering(
  all: TransactionInstruction[],
  borrowIx: TransactionInstruction,
  paybackIx: TransactionInstruction,
  customCount: number,
): void {
  const borrowIdx = all.indexOf(borrowIx);
  const paybackIdx = all.indexOf(paybackIx);

  if (borrowIdx === -1 || paybackIdx === -1) {
    throw new Error("assertOrdering: borrow or payback instruction missing");
  }
  if (paybackIdx !== all.length - 1) {
    throw new Error("assertOrdering: payback is not the final instruction");
  }
  if (borrowIdx >= paybackIdx) {
    throw new Error("assertOrdering: borrow must precede payback");
  }
  if (paybackIdx - borrowIdx - 1 !== customCount) {
    throw new Error(
      `assertOrdering: expected ${customCount} custom instructions between borrow and payback, found ${paybackIdx - borrowIdx - 1}`,
    );
  }
}

/**
 * Estimates the lamport cost of a transaction: base fee per signature plus the
 * priority fee. Both are integer lamports; no floating point.
 */
export function estimateLamportCost(
  cfg: SolanaLaneConfig,
  priorityFeeMicroLamports: bigint,
  signatures = 1n,
): bigint {
  const baseFee = cfg.lamportsPerSignature * signatures;
  // priority fee = ceil(microLamports * computeUnits / 1e6)
  const priority = (priorityFeeMicroLamports * BigInt(cfg.computeUnitLimit) + 999_999n) / 1_000_000n;
  return baseFee + priority;
}
