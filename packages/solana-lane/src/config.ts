import { z } from "zod";

/**
 * Solana lane configuration (Phase 1, lane ii).
 *
 * Jupiter Lend flash loans are ZERO FEE, so F = 0 on this lane. The accounting
 * identities are otherwise identical to the Base lane, which is why both lanes
 * share `@v6hf/core`. The only structural difference is the settlement model:
 * Solana has no callback, so the borrow / custom / payback instruction sequence
 * IS the atomicity guarantee.
 */

const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana public key");
const bigintStr = z.string().regex(/^\d+$/).transform((s) => BigInt(s));

export const SolanaLaneConfigSchema = z.object({
  rpcUrl: z.string().url(),
  commitment: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),

  // ---- signer isolation ----
  /** Hot keypair. Fee payer and transaction signer. Holds SOL for fees only. */
  executorKeypairPath: z.string().min(1),
  /** Cold keypair. Signs the off-chain intent. Never appears in a transaction. */
  authorizerKeypairPath: z.string().min(1),
  /** Expected authorizer public key, checked at startup. */
  expectedAuthorizer: pubkey,

  // ---- economics ----
  /** Loan asset mint (e.g. USDC). */
  loanAssetMint: pubkey,
  /** Loan asset decimals, for unit conversion only. */
  loanAssetDecimals: z.number().int().min(0).max(18),
  minNetProfitRaw: bigintStr,
  maxLoanRaw: bigintStr,
  /** Lamports per signature, for the fee budget. */
  lamportsPerSignature: bigintStr.default("5000"),
  /** Priority fee ceiling, microlamports per compute unit. */
  priorityFeeCeilingMicroLamports: bigintStr,
  /** Compute unit limit for the transaction. */
  computeUnitLimit: z.number().int().positive().default(1_000_000),
  /** Raw loan-asset units per 1 whole SOL, 1e18 scale (for gas-in-raw accounting). */
  rawPerNative: bigintStr,

  // ---- budget ----
  /** Lamport budget pool per epoch. */
  lamportBudgetPool: bigintStr,
  /** Minimum SOL balance the hot key must retain, lamports. */
  submitterMinBalanceLamports: bigintStr,

  // ---- breaker ----
  maxConsecutiveFailures: z.number().int().positive().default(3),
  maxSlippageBps: bigintStr.default("50"),
  stalenessLimitSeconds: z.number().int().positive().default(300),

  // ---- operational ----
  intentTtlSeconds: z.number().int().positive().default(10),
  dryRun: z.boolean().default(false),
});

export type SolanaLaneConfig = z.infer<typeof SolanaLaneConfigSchema>;

export function loadSolanaLaneConfig(raw: unknown): SolanaLaneConfig {
  const parsed = SolanaLaneConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`SolanaLaneConfig invalid: ${issues}`);
  }
  return parsed.data;
}
