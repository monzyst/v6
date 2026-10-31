import { BPS_DENOMINATOR, WAD, type Bps, type Raw, type Wad, type Wei } from "./types.js";

/**
 * Integer-only arithmetic primitives.
 *
 * Every function here is total on its declared domain and throws rather than
 * wrapping. There is no floating point anywhere in this module, and no `number`
 * is ever used to hold an economic quantity.
 */

/** Thrown when an accounting identity cannot be satisfied. */
export class AccountingError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AccountingError";
  }
}

/** Ceiling division for non-negative integers. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new AccountingError("ceilDiv: non-positive denominator");
  if (numerator < 0n) throw new AccountingError("ceilDiv: negative numerator");
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/** Floor division, rejecting negatives. */
export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new AccountingError("floorDiv: non-positive denominator");
  if (numerator < 0n) throw new AccountingError("floorDiv: negative numerator");
  return numerator / denominator;
}

/** bps of an amount, floored. Mirrors RawMath.bps on-chain. */
export function bpsOf(amount: Raw, bps: Bps): Raw {
  if (bps < 0n || bps > BPS_DENOMINATOR) throw new AccountingError("bpsOf: bps out of range");
  return (amount * bps) / BPS_DENOMINATOR;
}

/**
 * F = ceil(L * feeWad / 1e18).
 *
 * Morpho charges `assets.mulDivUp(fee, 1e18)`. We mirror the ceiling so our
 * accounting is never optimistic by one wei.
 */
export function flashFeeRaw(principal: Raw, feeWad: Wad): Raw {
  if (principal < 0n) throw new AccountingError("flashFeeRaw: negative principal");
  if (feeWad < 0n) throw new AccountingError("flashFeeRaw: negative fee");
  return ceilDiv(principal * feeWad, WAD);
}

/**
 * nativeWei = floor(raw * 1e18 / rawPerNative).
 *
 * `rawPerNative` is the number of RAW token units equal to ONE WHOLE native
 * token. It is NOT scaled by 1e18 — it is already in the loan asset's own base
 * units. Example: if 1 ETH = 3000 USDC and the loan asset is 6-decimal USDC,
 * then rawPerNative = 3000 * 10^6 = 3_000_000_000.
 *
 * Flooring is deliberate: a gas-credit estimate must never overstate the native
 * value of a profit.
 */
export function nativeFromRaw(rawAmount: Raw, rawPerNative: bigint): Wei {
  if (rawPerNative <= 0n) throw new AccountingError("nativeFromRaw: non-positive price");
  return (rawAmount * WAD) / rawPerNative;
}

/**
 * gasCostRaw = ceil(gasWei * rawPerNative / 1e18).
 *
 * The inverse of `nativeFromRaw`, rounded UP because this is a cost: rounding a
 * cost down would let a marginal trade pass the gate that should not.
 */
export function rawFromNative(gasWei: Wei, rawPerNative: bigint): Raw {
  if (rawPerNative <= 0n) throw new AccountingError("rawFromNative: non-positive price");
  if (gasWei < 0n) throw new AccountingError("rawFromNative: negative wei");
  return ceilDiv(gasWei * rawPerNative, WAD);
}

/** Converts a human decimal string to raw units without floating point. */
export function parseUnits(value: string, decimals: number): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new AccountingError(`parseUnits: bad decimal '${value}'`);
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const parts = body.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  if (frac.length > decimals) {
    throw new AccountingError(`parseUnits: '${value}' exceeds ${decimals} decimals`);
  }
  const padded = frac.padEnd(decimals, "0");
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
  return negative ? -result : result;
}

/** Formats raw units as a decimal string, truncating (never rounding up). */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracStr === "" ? `${sign}${whole}` : `${sign}${whole}.${fracStr}`;
}

/** Absolute difference, for assertions that report drift. */
export function absDiff(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

/** Asserts an exact equality, throwing a structured error on drift. */
export function assertEq(actual: bigint, expected: bigint, label: string): void {
  if (actual !== expected) {
    throw new AccountingError(`${label}: expected ${expected}, got ${actual}`, {
      label,
      expected: expected.toString(),
      actual: actual.toString(),
      drift: (actual - expected).toString(),
    });
  }
}
