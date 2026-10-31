/**
 * Environment → market-data provider, Phase 2.
 *
 * Phase 2 strategies need four independent price feeds (spot, perp mark + funding,
 * staking yield, options implied vol + premium). No single venue serves all four,
 * so the operator supplies one base URL per feed.
 *
 * FAILURE POLICY: an unset feed yields `undefined` — the caller then has NO
 * provider, the strategies emit no proposal, and Phase 2 sits idle. It does not
 * error at boot and it never falls back to a synthetic price. Idle is the correct
 * resting state for a strategy that cannot price its edge.
 */

import { optString, reqBigInt, type Env } from "@v6hf/core";
import { HttpMarketDataProvider, type HttpMarketDataProviderConfig } from "./market.js";

/**
 * Builds the HTTP provider from `V6_MARKET_*`.
 *
 * Returns `undefined` when any of the four feeds is unset. This is deliberate
 * all-or-nothing behaviour: a partially configured feed would let a strategy run
 * on three live prices and one defaulted one, which is worse than not running.
 */
export function loadMarketDataProviderFromEnv(env: Env): HttpMarketDataProvider | undefined {
  const spotBaseUrl = optString(env, "V6_MARKET_SPOT_URL");
  const perpBaseUrl = optString(env, "V6_MARKET_PERP_URL");
  const yieldBaseUrl = optString(env, "V6_MARKET_YIELD_URL");
  const optionsBaseUrl = optString(env, "V6_MARKET_OPTIONS_URL");

  if (!spotBaseUrl || !perpBaseUrl || !yieldBaseUrl || !optionsBaseUrl) {
    return undefined;
  }

  const token = optString(env, "V6_MARKET_BEARER_TOKEN");
  const cfg: HttpMarketDataProviderConfig = {
    spotBaseUrl,
    perpBaseUrl,
    yieldBaseUrl,
    optionsBaseUrl,
    timeoutMs: Number(reqBigInt(env, "V6_MARKET_TIMEOUT_MS")),
    ...(token ? { bearerToken: token } : {}),
  };
  return new HttpMarketDataProvider(cfg);
}
