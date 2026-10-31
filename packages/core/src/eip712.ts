import { TypedDataEncoder, keccak256, toUtf8Bytes, getAddress, type TypedDataField } from "ethers";
import type { ExecutionPlan, Leg } from "./types.js";

/**
 * EIP-712 encoding for V6-HF ExecutionPlan.
 *
 * This module is the off-chain half of `BaseFlashExecutor.hashPlan`. It must
 * produce a byte-identical digest or every signature is rejected with
 * BadSignature. We delegate the actual hashing to ethers' `TypedDataEncoder`
 * (audited, and the same code path every wallet uses) rather than hand-rolling
 * keccak — a single wrong padding byte would silently invalidate all plans.
 *
 * The type strings below are duplicated verbatim from BaseFlashExecutor.sol and
 * are asserted equal at startup by `assertTypehashParity`.
 */

export const LEG_TYPE_STRING =
  "Leg(address router,address tokenIn,address tokenOut,uint256 amountIn," +
  "uint256 amountInBps,uint256 minAmountOut,uint24 poolFee,uint8 dexKind," +
  "bool stable,uint256 deadline)";

export const PLAN_TYPE_STRING =
  "ExecutionPlan(address loanAsset,uint256 loanAmount,uint256 minNetProfitRaw," +
  "uint256 maxFlashFeeRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline," +
  "address profitRecipient,bytes32 legsHash)";

export const DOMAIN_NAME = "V6-HF";
export const DOMAIN_VERSION = "1";

/** The EIP-712 type map, in the exact order the Solidity struct declares. */
export const PLAN_TYPES: Record<string, TypedDataField[]> = {
  Leg: [
    { name: "router", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "amountInBps", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "poolFee", type: "uint24" },
    { name: "dexKind", type: "uint8" },
    { name: "stable", type: "bool" },
    { name: "deadline", type: "uint256" },
  ],
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
};

export interface DomainParams {
  readonly chainId: bigint;
  readonly verifyingContract: string;
}

export function buildDomain(d: DomainParams) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: d.chainId,
    verifyingContract: getAddress(d.verifyingContract),
  } as const;
}

/** keccak256 of a UTF-8 string, 0x-hex. */
export function keccak256Utf8(value: string): string {
  return keccak256(toUtf8Bytes(value));
}

/**
 * legsHash = keccak256(abi.encodePacked(legHashes)).
 *
 * Solidity hashes each leg struct, then packs the resulting bytes32 array and
 * hashes that. `TypedDataEncoder.hashStruct` gives us the per-leg hash with the
 * identical field ordering.
 */
export function hashLegs(legs: Leg[]): string {
  // NOTE: `hashStruct` requires a type set in which the primary type is the ONLY
  // root. Passing the full PLAN_TYPES here fails with "ambiguous primary types or
  // unused types" because ExecutionPlan would be unused. So we hash legs against
  // a Leg-only type map, which is exactly what Solidity's per-leg keccak does.
  const legTypes: Record<string, TypedDataField[]> = { Leg: PLAN_TYPES.Leg as TypedDataField[] };
  const hashes = legs.map((leg) =>
    TypedDataEncoder.hashStruct("Leg", legTypes, {
      router: getAddress(leg.router),
      tokenIn: getAddress(leg.tokenIn),
      tokenOut: getAddress(leg.tokenOut),
      amountIn: leg.amountIn,
      amountInBps: leg.amountInBps,
      minAmountOut: leg.minAmountOut,
      poolFee: BigInt(leg.poolFee),
      dexKind: BigInt(leg.dexKind),
      stable: leg.stable,
      deadline: leg.deadline,
    }),
  );
  // abi.encodePacked(bytes32[]) == concatenation of the 32-byte words.
  return keccak256("0x" + hashes.map((h) => h.slice(2)).join(""));
}

/** The struct value in the shape TypedDataEncoder expects. */
export function planStructValue(plan: ExecutionPlan) {
  return {
    loanAsset: getAddress(plan.loanAsset),
    loanAmount: plan.loanAmount,
    minNetProfitRaw: plan.minNetProfitRaw,
    maxFlashFeeRaw: plan.maxFlashFeeRaw,
    gasBudgetWei: plan.gasBudgetWei,
    nonce: plan.nonce,
    deadline: plan.deadline,
    profitRecipient: getAddress(plan.profitRecipient),
    legsHash: hashLegs(plan.legs),
  };
}

/**
 * The type set used to hash the PLAN itself.
 *
 * `Leg` is deliberately absent: the plan commits to its legs through the single
 * `legsHash` field, so including `Leg` here would make it an unused type and
 * ethers rejects the set as ambiguous. This mirrors the Solidity struct exactly
 * (which also has no nested Leg array — only `bytes32 legsHash`).
 */
export const PLAN_ONLY_TYPES: Record<string, TypedDataField[]> = {
  ExecutionPlan: PLAN_TYPES.ExecutionPlan as TypedDataField[],
};

/** The final EIP-712 digest the AUTHORIZER key must sign. */
export function hashPlan(plan: ExecutionPlan, domain: DomainParams): string {
  return TypedDataEncoder.hash(buildDomain(domain), PLAN_ONLY_TYPES, planStructValue(plan));
}

/** The full typed-data payload, for handing to a hardware wallet / KMS. */
export function typedDataPayload(plan: ExecutionPlan, domain: DomainParams) {
  return {
    domain: buildDomain(domain),
    types: PLAN_ONLY_TYPES,
    primaryType: "ExecutionPlan" as const,
    message: planStructValue(plan),
  };
}

/**
 * Startup parity check: recomputes the typehashes and compares them to the
 * values the deployed contract reports. A mismatch means the ABI drifted and
 * every signature would fail — fail fast instead of at the first trade.
 */
export function assertTypehashParity(onChain: {
  planTypehash: string;
  legTypehash: string;
}): void {
  const plan = keccak256Utf8(PLAN_TYPE_STRING).toLowerCase();
  const leg = keccak256Utf8(LEG_TYPE_STRING).toLowerCase();
  if (plan !== onChain.planTypehash.toLowerCase()) {
    throw new Error(`PLAN_TYPEHASH mismatch: local ${plan} vs chain ${onChain.planTypehash}`);
  }
  if (leg !== onChain.legTypehash.toLowerCase()) {
    throw new Error(`LEG_TYPEHASH mismatch: local ${leg} vs chain ${onChain.legTypehash}`);
  }
}

/** Deterministic fingerprint for logging/idempotency (not the EIP-712 digest). */
export function planFingerprint(plan: ExecutionPlan): string {
  return keccak256(
    toUtf8Bytes(
      JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ),
  );
}
