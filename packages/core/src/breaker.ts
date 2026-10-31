import type { BreakerReason } from "./types.js";
import { BREAKER_CODES } from "./types.js";

/**
 * Circuit breaker.
 *
 * Two layers, deliberately independent:
 *
 *   1. ON-CHAIN (authoritative). `BaseFlashExecutor.breakerOpen` is sticky and
 *      can only be cleared by the owner. It is written in the outer frame of
 *      `execute`, so it survives the revert of the cycle it is reacting to.
 *
 *   2. OFF-CHAIN (this class). A local mirror that stops the supervisor from
 *      even BUILDING a transaction once a condition is known to be bad. It is
 *      advisory: it can only ever be more conservative than the chain, never
 *      less. If the two disagree, the chain wins and the supervisor halts.
 *
 * The breaker is intentionally NOT auto-resetting. A system that heals itself
 * after an invariant violation will eventually trade through the same bug.
 */

export type BreakerState = "CLOSED" | "OPEN";

export interface BreakerTrip {
  readonly reason: BreakerReason;
  readonly code: number;
  readonly atMs: number;
  readonly detail: string;
}

export interface HealthSample {
  /** Consecutive failed cycles. */
  readonly consecutiveFailures: number;
  /** Realised slippage vs. plan, in bps, for the last cycle. */
  readonly lastSlippageBps: bigint;
  /** Observed gas price, wei. */
  readonly gasPriceWei: bigint;
  /** Configured gas price ceiling, wei. */
  readonly gasPriceCeilingWei: bigint;
  /** Seconds since the last successful cycle. */
  readonly secondsSinceSuccess: number;
  /** Configured staleness limit, seconds. */
  readonly stalenessLimitSeconds: number;
  /** Native balance of the hot submitter, wei. */
  readonly submitterBalanceWei: bigint;
  /** Minimum native balance the submitter must retain, wei. */
  readonly submitterMinBalanceWei: bigint;
}

export interface BreakerConfig {
  readonly maxConsecutiveFailures: number;
  readonly maxSlippageBps: bigint;
}

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private trip: BreakerTrip | null = null;
  private consecutiveFailures = 0;
  private readonly listeners: Array<(t: BreakerTrip) => void> = [];

  constructor(private readonly config: BreakerConfig) {}

  get isOpen(): boolean {
    return this.state === "OPEN";
  }

  get lastTrip(): BreakerTrip | null {
    return this.trip;
  }

  onTrip(fn: (t: BreakerTrip) => void): void {
    this.listeners.push(fn);
  }

  /** Throws if the breaker is open. Call this before building any transaction. */
  assertClosed(): void {
    if (this.state === "OPEN" && this.trip) {
      throw new Error(`CircuitBreaker OPEN (${this.trip.reason}): ${this.trip.detail}`);
    }
  }

  /** Records a successful cycle and resets the failure streak. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** Records a failed cycle; trips if the streak limit is reached. */
  recordFailure(detail: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.tripBreaker("HEALTH", `consecutive failures = ${this.consecutiveFailures}: ${detail}`);
    }
  }

  /**
   * Evaluates a health sample. Returns the reason it tripped, or null.
   * Every check is independent so the first failing one wins deterministically.
   */
  evaluateHealth(h: HealthSample): BreakerReason | null {
    if (h.gasPriceWei > h.gasPriceCeilingWei) {
      this.tripBreaker("BUDGET", `gas price ${h.gasPriceWei} > ceiling ${h.gasPriceCeilingWei}`);
      return "BUDGET";
    }
    if (h.lastSlippageBps > this.config.maxSlippageBps) {
      this.tripBreaker("SWAP", `slippage ${h.lastSlippageBps}bps > ${this.config.maxSlippageBps}bps`);
      return "SWAP";
    }
    if (h.secondsSinceSuccess > h.stalenessLimitSeconds) {
      this.tripBreaker("HEALTH", `no success for ${h.secondsSinceSuccess}s`);
      return "HEALTH";
    }
    if (h.submitterBalanceWei < h.submitterMinBalanceWei) {
      this.tripBreaker("HEALTH", `submitter balance ${h.submitterBalanceWei} below floor`);
      return "HEALTH";
    }
    return null;
  }

  /** Trips the breaker. Idempotent: the first trip is the one that is kept. */
  tripBreaker(reason: BreakerReason, detail: string): void {
    if (this.state === "OPEN") return;
    this.state = "OPEN";
    this.trip = { reason, code: BREAKER_CODES[reason], atMs: Date.now(), detail };
    for (const fn of this.listeners) {
      try {
        fn(this.trip);
      } catch {
        // A listener must never prevent the breaker from latching.
      }
    }
  }

  /**
   * Manual reset. Requires an explicit operator acknowledgement string so the
   * action is auditable — there is no programmatic path back to CLOSED.
   */
  reset(acknowledgement: string): void {
    if (acknowledgement.trim().length < 8) {
      throw new Error("CircuitBreaker.reset: acknowledgement too short");
    }
    this.state = "CLOSED";
    this.trip = null;
    this.consecutiveFailures = 0;
  }
}
