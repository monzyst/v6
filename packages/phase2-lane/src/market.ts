import { AccountingError } from "@v6hf/core";

/**
 * Market data for the Phase 2 strategies.
 *
 * `MarketDataProvider` is the seam. `HttpMarketDataProvider` is the production
 * implementation: it performs real HTTP requests against public venue APIs and
 * parses the responses into integer-only `MarketSnapshot`s. There is no synthetic
 * price generation anywhere in this file — if a venue is unreachable the call
 * throws and the strategy emits no proposal, which is the correct failure mode for
 * a system that must never trade on invented data.
 *
 * All prices are carried as `bigint` in a fixed 1e18 (WAD) scale, so every
 * downstream computation is integer arithmetic. A price is never a `number`.
 */

export const WAD = 10n ** 18n;

/** A price in WAD (1e18 = 1.0). */
export type WadPrice = bigint;

export interface MarketSnapshot {
  /** Spot price of the base asset in quote terms, WAD. */
  readonly spotWad: WadPrice;
  /** Perp mark price, WAD. */
  readonly perpMarkWad: WadPrice;
  /** Perp funding rate per 8h interval, WAD (signed: negative = shorts pay). */
  readonly fundingRateWad: bigint;
  /** Annualised staking / restaking yield, WAD. */
  readonly stakingYieldWad: bigint;
  /** Implied volatility, WAD. */
  readonly impliedVolWad: bigint;
  /** Option premium for the target strike/tenor, WAD of notional. */
  readonly optionPremiumWad: bigint;
  /** Unix seconds at which this snapshot was taken. */
  readonly asOfTs: bigint;
}

export interface MarketDataProvider {
  /** Fetches a coherent snapshot. Throws if any required leg is unavailable. */
  fetch(symbol: string): Promise<MarketSnapshot>;
}

export class MarketDataError extends Error {
  constructor(message: string, readonly detail: Record<string, string> = {}) {
    super(message);
    this.name = "MarketDataError";
  }
}

/** Parses a decimal string (e.g. "3000.42") into WAD without floating point. */
export function parseWad(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MarketDataError(`parseWad: not a decimal number: '${value}'`);
  }
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", frac = ""] = body.split(".");
  if (frac.length > 18) {
    // Truncate rather than round: a price must never be overstated by rounding.
    const truncated = frac.slice(0, 18);
    const result = BigInt(whole) * WAD + BigInt(truncated.padEnd(18, "0"));
    return negative ? -result : result;
  }
  const result = BigInt(whole) * WAD + BigInt(frac.padEnd(18, "0"));
  return negative ? -result : result;
}

/** Formats a WAD value as a decimal string, truncating. */
export function formatWad(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / WAD;
  const frac = (abs % WAD).toString().padStart(18, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return frac === "" ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

/** Integer division that rounds toward negative infinity, for signed values. */
export function floorDivSigned(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new AccountingError("floorDivSigned: non-positive denominator");
  const q = numerator / denominator;
  const r = numerator % denominator;
  return r !== 0n && numerator < 0n ? q - 1n : q;
}

export interface HttpMarketDataProviderConfig {
  /** Base URL of the spot price API. Must expose `GET {base}/ticker/price?symbol=`. */
  readonly spotBaseUrl: string;
  /** Base URL of the derivatives API. Must expose `GET {base}/premiumIndex?symbol=`. */
  readonly perpBaseUrl: string;
  /** Base URL of the staking-yield API. Must expose `GET {base}/yields?asset=`. */
  readonly yieldBaseUrl: string;
  /** Base URL of the options API. Must expose `GET {base}/premium?symbol=&strike=`. */
  readonly optionsBaseUrl: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Optional bearer token, sent as `Authorization` when present. */
  readonly bearerToken?: string;
}

/**
 * Production market data provider.
 *
 * Endpoint shapes are the ones the strategies need; each is a single GET with a
 * JSON body. The parser is strict: a missing or non-numeric field throws rather
 * than defaulting, because a defaulted price is a fabricated price.
 */
export class HttpMarketDataProvider implements MarketDataProvider {
  constructor(private readonly cfg: HttpMarketDataProviderConfig) {}

  async fetch(symbol: string): Promise<MarketSnapshot> {
    const [spot, perp, yieldWad, optionPremiumWad] = await Promise.all([
      this.getJson(`${this.cfg.spotBaseUrl}/ticker/price?symbol=${encodeURIComponent(symbol)}`),
      this.getJson(`${this.cfg.perpBaseUrl}/premiumIndex?symbol=${encodeURIComponent(symbol)}`),
      this.getJson(`${this.cfg.yieldBaseUrl}/yields?asset=${encodeURIComponent(symbol)}`),
      this.getJson(`${this.cfg.optionsBaseUrl}/premium?symbol=${encodeURIComponent(symbol)}`),
    ]);

    const spotWad = parseWad(requireString(spot, "price", "spot"));
    const perpMarkWad = parseWad(requireString(perp, "markPrice", "perp"));
    const fundingRateWad = parseWad(requireString(perp, "lastFundingRate", "perp"));
    const stakingYieldWad = parseWad(requireString(yieldWad, "apy", "yield"));
    const impliedVolWad = parseWad(requireString(optionPremiumWad, "impliedVol", "options"));
    const optionPremiumWadValue = parseWad(requireString(optionPremiumWad, "premium", "options"));

    if (spotWad <= 0n) throw new MarketDataError("spot price must be positive", { symbol });
    if (perpMarkWad <= 0n) throw new MarketDataError("perp mark must be positive", { symbol });

    return {
      spotWad,
      perpMarkWad,
      fundingRateWad,
      stakingYieldWad,
      impliedVolWad,
      optionPremiumWad: optionPremiumWadValue,
      asOfTs: BigInt(Math.floor(Date.now() / 1000)),
    };
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.cfg.bearerToken) headers.authorization = `Bearer ${this.cfg.bearerToken}`;
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) {
        throw new MarketDataError(`market data request failed: ${res.status} ${res.statusText}`, { url });
      }
      const body = (await res.json()) as unknown;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new MarketDataError("market data response is not a JSON object", { url });
      }
      return body as Record<string, unknown>;
    } catch (err) {
      if (err instanceof MarketDataError) throw err;
      throw new MarketDataError(`market data request threw: ${String(err)}`, { url });
    } finally {
      clearTimeout(timer);
    }
  }
}

function requireString(body: Record<string, unknown>, key: string, source: string): string {
  const value = body[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value.toString();
  throw new MarketDataError(`market data field '${key}' missing or non-numeric in ${source} response`, {
    key,
    source,
  });
}

/**
 * A provider backed by a fixed snapshot. Used by tests and by the dry-run
 * simulator. It is NOT a production provider and is never selected by config —
 * `loadPhase2LaneConfig` has no path that constructs it.
 */
export class StaticMarketDataProvider implements MarketDataProvider {
  constructor(private readonly snapshot: MarketSnapshot) {}

  async fetch(_symbol: string): Promise<MarketSnapshot> {
    return this.snapshot;
  }
}
