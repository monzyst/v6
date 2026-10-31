import { TypedDataEncoder, keccak256, toUtf8Bytes, getAddress, type TypedDataField } from "ethers";
import type { Phase2Plan, P2Leg } from "./phase2-types.js";
import { PHASE2_ACTION } from "./phase2-types.js";

/**
 * EIP-712 encoding for the Phase 2 `Phase2Plan`.
 *
 * Structurally parallel to `packages/core/src/eip712.ts` (Phase 1) but sharing no
 * type, no domain name and no digest. A Phase 1 signature can never verify here:
 *
 *   - domain name differs ("V6-HF-PHASE2" vs "V6-HF")
 *   - primary type differs  (Phase2Plan vs ExecutionPlan)
 *   - the signed struct contains a signed int256 field, which Phase 1 has nowhere
 *
 * The contracts enforce the same separation on their side (`DOMAIN_NAME_HASH`), so
 * the isolation holds even if a caller mixes the two packages up.
 */

export const P2_LEG_TYPE_STRING =
  "P2Leg(address venue,address tokenIn,address tokenOut,uint256 amountIn," +
  "uint256 minAmountOut,uint8 action,uint256 deadline)";

export const PHASE2_PLAN_TYPE_STRING =
  "Phase2Plan(uint8 strategy,address asset,uint256 deployedRaw,int256 minCarryRaw," +
  "uint256 maxCostRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline," +
  "address profitRecipient,bytes32 legsHash)";

export const PHASE2_DOMAIN_NAME = "V6-HF-PHASE2";
export const PHASE2_DOMAIN_VERSION = "1";

export const P2_TYPES: Record<string, TypedDataField[]> = {
  P2Leg: [
    { name: "venue", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "action", type: "uint8" },
    { name: "deadline", type: "uint256" },
  ],
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
};

/**
 * Only `Phase2Plan` — `P2Leg` is committed to through `legsHash`. Including it
 * here would make it an unused type and ethers rejects the set as ambiguous.
 */
export const PHASE2_PLAN_ONLY_TYPES: Record<string, TypedDataField[]> = {
  Phase2Plan: P2_TYPES.Phase2Plan as TypedDataField[],
};

export interface Phase2DomainParams {
  readonly chainId: bigint;
  readonly verifyingContract: string;
}

export function buildPhase2Domain(d: Phase2DomainParams) {
  return {
    name: PHASE2_DOMAIN_NAME,
    version: PHASE2_DOMAIN_VERSION,
    chainId: d.chainId,
    verifyingContract: getAddress(d.verifyingContract),
  } as const;
}

/** legsHash = keccak256(abi.encodePacked(legHashes)), exactly as the contract does. */
export function hashP2Legs(legs: readonly P2Leg[]): string {
  const legTypes: Record<string, TypedDataField[]> = { P2Leg: P2_TYPES.P2Leg as TypedDataField[] };
  const hashes = legs.map((leg) =>
    TypedDataEncoder.hashStruct("P2Leg", legTypes, {
      venue: getAddress(leg.venue),
      tokenIn: getAddress(leg.tokenIn),
      tokenOut: getAddress(leg.tokenOut),
      amountIn: leg.amountIn,
      minAmountOut: leg.minAmountOut,
      action: BigInt(leg.action),
      deadline: leg.deadline,
    }),
  );
  return keccak256("0x" + hashes.map((h) => h.slice(2)).join(""));
}

export function phase2PlanStructValue(plan: Phase2Plan) {
  return {
    strategy: BigInt(plan.strategy),
    asset: getAddress(plan.asset),
    deployedRaw: plan.deployedRaw,
    minCarryRaw: plan.minCarryRaw,
    maxCostRaw: plan.maxCostRaw,
    gasBudgetWei: plan.gasBudgetWei,
    nonce: plan.nonce,
    deadline: plan.deadline,
    profitRecipient: getAddress(plan.profitRecipient),
    legsHash: hashP2Legs(plan.legs),
  };
}

/** The digest the cold key signs for a Phase 2 step. */
export function hashPhase2Plan(plan: Phase2Plan, domain: Phase2DomainParams): string {
  return TypedDataEncoder.hash(buildPhase2Domain(domain), PHASE2_PLAN_ONLY_TYPES, phase2PlanStructValue(plan));
}

export function phase2TypedDataPayload(plan: Phase2Plan, domain: Phase2DomainParams) {
  return {
    domain: buildPhase2Domain(domain),
    types: PHASE2_PLAN_ONLY_TYPES,
    primaryType: "Phase2Plan" as const,
    message: phase2PlanStructValue(plan),
  };
}

/** Startup parity check against the deployed contract's reported typehashes. */
export function assertPhase2TypehashParity(onChain: { p2LegTypehash: string; phase2PlanTypehash: string }): void {
  const leg = keccak256(toUtf8Bytes(P2_LEG_TYPE_STRING)).toLowerCase();
  const plan = keccak256(toUtf8Bytes(PHASE2_PLAN_TYPE_STRING)).toLowerCase();
  if (leg !== onChain.p2LegTypehash.toLowerCase()) {
    throw new Error(`P2_LEG_TYPEHASH mismatch: local ${leg} vs chain ${onChain.p2LegTypehash}`);
  }
  if (plan !== onChain.phase2PlanTypehash.toLowerCase()) {
    throw new Error(`PHASE2_PLAN_TYPEHASH mismatch: local ${plan} vs chain ${onChain.phase2PlanTypehash}`);
  }
}

/** Deterministic fingerprint for logging/idempotency. Not the EIP-712 digest. */
export function phase2Fingerprint(plan: Phase2Plan): string {
  return keccak256(
    toUtf8Bytes(
      JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ),
  );
}

/**
 * Builds a plan for one lifecycle step with the action stamp applied to EVERY leg.
 * Centralising this is deliberate: the most likely Phase 2 authoring bug is a leg
 * carrying the wrong `action`, which the contract rejects with
 * `LegActionMismatch` and maps to breaker code 8.
 */
export function buildPhase2Plan(input: {
  strategy: number;
  asset: string;
  deployedRaw: bigint;
  minCarryRaw: bigint;
  maxCostRaw: bigint;
  gasBudgetWei: bigint;
  nonce: bigint;
  deadline: bigint;
  profitRecipient: string;
  legs: ReadonlyArray<Omit<P2Leg, "action">>;
  step: "open" | "hedge" | "close";
}): Phase2Plan {
  const action = PHASE2_ACTION[input.step];
  return {
    strategy: input.strategy,
    asset: input.asset,
    deployedRaw: input.deployedRaw,
    minCarryRaw: input.minCarryRaw,
    maxCostRaw: input.maxCostRaw,
    gasBudgetWei: input.gasBudgetWei,
    nonce: input.nonce,
    deadline: input.deadline,
    profitRecipient: input.profitRecipient,
    legs: input.legs.map((l) => ({ ...l, action })),
  };
}
