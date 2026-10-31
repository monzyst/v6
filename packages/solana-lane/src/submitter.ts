import { Connection } from "@solana/web3.js";
import {
  BudgetLedger,
  CircuitBreaker,
  evaluatePlan,
  type ChainSnapshot,
  type Economics,
  type GasModel,
} from "@v6hf/core";
import type { SolanaLaneConfig } from "./config.js";
import {
  buildSolanaSigners,
  intentDigest,
  signIntent,
  verifyIntent,
  type SolanaSigners,
} from "./signers.js";
import {
  buildFlashloanTransaction,
  estimateLamportCost,
  type SolanaPlan,
} from "./jupiter.js";

/**
 * Solana lane submitter.
 *
 * Lifecycle mirrors the Base lane exactly, with the settlement mechanism
 * swapped for Solana's:
 *
 *   preflight -> reserve -> cold-sign intent -> hot-sign tx -> send -> confirm
 *
 * The accounting is shared: `evaluatePlan` from @v6hf/core runs unchanged, with
 * `morphoFeeWad = 0n` because Jupiter Lend charges no flash fee. That is not a
 * special case in the code — it is a configuration value, which is why the two
 * lanes cannot drift apart economically.
 */

export interface SolanaSubmitResult {
  readonly ok: boolean;
  readonly signature: string | null;
  readonly netProfitRaw: bigint;
  readonly feeLamports: bigint;
  readonly economics: Economics | null;
  readonly error: string | null;
}

export interface SolanaSubmitterDeps {
  readonly connection: Connection;
  readonly cfg: SolanaLaneConfig;
  readonly budget: BudgetLedger;
  readonly breaker: CircuitBreaker;
  readonly nowTs: () => bigint;
  readonly log: (event: string, data: Record<string, unknown>) => void;
}

export class SolanaLaneSubmitter {
  private readonly signers: SolanaSigners;

  constructor(private readonly deps: SolanaSubmitterDeps) {
    this.signers = buildSolanaSigners(deps.cfg);
  }

  async submit(
    plan: SolanaPlan,
    snapshot: ChainSnapshot,
    gas: GasModel,
    priorityFeeMicroLamports: bigint,
  ): Promise<SolanaSubmitResult> {
    const { cfg, budget, breaker, connection, log } = this.deps;

    // ---- 0. Breaker ----
    try {
      breaker.assertClosed();
    } catch (err) {
      return this.rejected(null, String(err));
    }

    // ---- 1. Static gates ----
    if (plan.loanAmount <= 0n) return this.rejected(null, "zero loan amount");
    if (plan.loanAmount > cfg.maxLoanRaw) return this.rejected(null, "loan exceeds maxLoanRaw");
    if (plan.minNetProfitRaw < cfg.minNetProfitRaw) {
      return this.rejected(null, "plan floor below configured floor");
    }
    if (snapshot.nowTs > plan.deadline) return this.rejected(null, "intent expired");
    if (priorityFeeMicroLamports > cfg.priorityFeeCeilingMicroLamports) {
      return this.rejected(null, "priority fee above ceiling");
    }

    // ---- 2. Economics (shared engine, F = 0) ----
    let econ: Economics;
    try {
      econ = evaluatePlan(
        {
          loanAsset: plan.loanAssetMint,
          loanAmount: plan.loanAmount,
          minNetProfitRaw: plan.minNetProfitRaw,
          maxFlashFeeRaw: 0n,
          gasBudgetWei: 0n,
          nonce: plan.nonce,
          deadline: plan.deadline,
          profitRecipient: plan.profitRecipient,
          legs: plan.route.map((leg) => ({
            router: leg.label,
            tokenIn: plan.loanAssetMint,
            tokenOut: plan.loanAssetMint,
            // amountIn 0 + amountInBps 10000 means "all of the current balance",
            // which is exactly how a chained swap route consumes its input.
            amountIn: 0n,
            amountInBps: 10_000n,
            // The leg's own guaranteed floor. Never defaulted: an unquantified
            // route must fail the projection, not silently pass it.
            minAmountOut: leg.minAmountOut,
            poolFee: 0,
            dexKind: 0 as const,
            stable: false,
            deadline: plan.deadline,
          })),
        },
        snapshot,
        gas,
      );
    } catch (err) {
      return this.rejected(null, `economics: ${String(err)}`);
    }

    if (!econ.gatePassed) {
      return this.rejected(
        econ,
        `profit gate: N'=${econ.netProfitAfterGas} < P=${econ.profitFloor}`,
      );
    }

    // ---- 3. Reserve the lamport budget BEFORE signing ----
    const feeLamports = estimateLamportCost(cfg, priorityFeeMicroLamports);
    const reservationId = `sol:${plan.nonce}`;
    try {
      budget.reserve(reservationId, feeLamports, `solana plan ${plan.nonce}`);
    } catch (err) {
      return this.rejected(econ, String(err));
    }

    try {
      // ---- 4. Cold key signs the intent ----
      const routeHash = routeFingerprint(plan);
      const digest = intentDigest({
        lane: "solana",
        loanAssetMint: plan.loanAssetMint,
        loanAmount: plan.loanAmount,
        minNetProfitRaw: plan.minNetProfitRaw,
        nonce: plan.nonce,
        deadline: plan.deadline,
        profitRecipient: plan.profitRecipient,
        routeHash,
      });
      const signature = signIntent(this.signers, digest);

      // ---- 5. Verify the intent before building anything ----
      const authorizerKey = (await import("node:crypto")).createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(base58Decode(this.signers.authorizerPublicKey)),
        ]),
        format: "der",
        type: "spki",
      });
      if (!verifyIntent(authorizerKey, digest, signature)) {
        budget.release(reservationId);
        return this.rejected(econ, "intent signature failed verification");
      }

      // ---- 6. Build the atomic transaction ----
      const built = await buildFlashloanTransaction(
        cfg,
        this.signers,
        connection,
        plan,
        priorityFeeMicroLamports,
      );

      if (cfg.dryRun) {
        const sim = await connection.simulateTransaction(built.transaction);
        budget.release(reservationId);
        if (sim.value.err) {
          return this.rejected(econ, `simulation failed: ${JSON.stringify(sim.value.err)}`);
        }
        log("solana.dryRun", { unitsConsumed: sim.value.unitsConsumed ?? 0 });
        return {
          ok: true,
          signature: null,
          netProfitRaw: econ.netProfitAfterGas,
          feeLamports: 0n,
          economics: econ,
          error: null,
        };
      }

      // ---- 7. Send and confirm ----
      const sig = await connection.sendTransaction(built.transaction, {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: cfg.commitment,
      });

      const confirmation = await connection.confirmTransaction(
        { signature: sig, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
        cfg.commitment,
      );

      if (confirmation.value.err) {
        budget.settle(reservationId, feeLamports);
        breaker.recordFailure(`solana tx failed: ${JSON.stringify(confirmation.value.err)}`);
        return this.rejected(econ, `transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      budget.settle(reservationId, feeLamports);
      breaker.recordSuccess();
      log("solana.ok", { signature: sig, netProfitRaw: econ.netProfitAfterGas.toString() });

      return {
        ok: true,
        signature: sig,
        netProfitRaw: econ.netProfitAfterGas,
        feeLamports,
        economics: econ,
        error: null,
      };
    } catch (err) {
      try {
        budget.release(reservationId);
      } catch {
        /* already settled */
      }
      breaker.recordFailure(String(err));
      log("solana.error", { error: String(err) });
      return this.rejected(econ, String(err));
    }
  }

  private rejected(econ: Economics | null, error: string): SolanaSubmitResult {
    return { ok: false, signature: null, netProfitRaw: 0n, feeLamports: 0n, economics: econ, error };
  }
}

/** Deterministic route fingerprint, used inside the signed intent. */
function routeFingerprint(plan: SolanaPlan): string {
  const parts = plan.route.map((leg) =>
    leg.instructions
      .map((ix) => `${ix.programId.toBase58()}:${Buffer.from(ix.data).toString("hex")}`)
      .join(","),
  );
  return parts.join("|");
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`base58Decode: bad char '${ch}'`);
    n = n * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}
