import { AccountingError } from "./units.js";
import type { Wei } from "./types.js";

/**
 * Fee-risk budget reservations.
 *
 * The purpose of this module is to make gas and fee exposure BOUNDED BEFORE a
 * transaction is built. It is a two-phase ledger:
 *
 *   reserve(id, ceiling)  -> moves `ceiling` from available to reserved
 *   settle(id, actual)    -> moves `actual` from reserved to spent, refunds the rest
 *   release(id)           -> returns the whole reservation (aborted before send)
 *
 * Invariants maintained at every step (asserted, not assumed):
 *   (B1) reserved >= 0
 *   (B2) spent    >= 0
 *   (B3) reserved + spent <= pool
 *   (B4) every open reservation has a unique id
 *
 * The on-chain contract implements the same ledger in `gasBudgetPoolWei` /
 * `gasReservedWei`; this class is the off-chain mirror used to decide whether a
 * plan is even worth signing. Both must agree, and `reconcile()` checks that.
 */

export interface Reservation {
  readonly id: string;
  readonly ceilingWei: Wei;
  readonly createdAtMs: number;
  readonly label: string;
}

export interface BudgetSnapshot {
  readonly poolWei: Wei;
  readonly reservedWei: Wei;
  readonly spentWei: Wei;
  readonly availableWei: Wei;
  readonly openReservations: number;
}

export class BudgetLedger {
  private pool: Wei;
  private reserved = 0n;
  private spent = 0n;
  private readonly open = new Map<string, Reservation>();

  constructor(initialPoolWei: Wei) {
    if (initialPoolWei < 0n) throw new AccountingError("BudgetLedger: negative pool");
    this.pool = initialPoolWei;
  }

  /** Adds native currency to the pool (mirrors `fundGasBudget`). */
  fund(amountWei: Wei): void {
    if (amountWei <= 0n) throw new AccountingError("BudgetLedger.fund: non-positive amount");
    this.pool += amountWei;
  }

  get availableWei(): Wei {
    return this.pool - this.reserved - this.spent;
  }

  /**
   * Reserves a ceiling. Throws if the pool cannot cover it — this is the
   * pre-execution gate that stops a plan from being signed at all.
   */
  reserve(id: string, ceilingWei: Wei, label = ""): Reservation {
    if (ceilingWei <= 0n) throw new AccountingError("BudgetLedger.reserve: non-positive ceiling");
    if (this.open.has(id)) throw new AccountingError(`BudgetLedger.reserve: duplicate id '${id}'`);

    const available = this.availableWei;
    if (ceilingWei > available) {
      throw new AccountingError("BudgetLedger.reserve: insufficient budget", {
        requested: ceilingWei.toString(),
        available: available.toString(),
      });
    }

    const r: Reservation = { id, ceilingWei, createdAtMs: Date.now(), label };
    this.open.set(id, r);
    this.reserved += ceilingWei;
    this.assertInvariants();
    return r;
  }

  /**
   * Settles a reservation against actual spend. Refunds the unused remainder.
   * Throws if actual exceeds the ceiling — that is a budget breach and must be
   * surfaced, never silently absorbed.
   */
  settle(id: string, actualWei: Wei): Wei {
    const r = this.open.get(id);
    if (!r) throw new AccountingError(`BudgetLedger.settle: unknown reservation '${id}'`);
    if (actualWei < 0n) throw new AccountingError("BudgetLedger.settle: negative actual");
    if (actualWei > r.ceilingWei) {
      throw new AccountingError("BudgetLedger.settle: actual exceeds reserved ceiling", {
        id,
        actual: actualWei.toString(),
        ceiling: r.ceilingWei.toString(),
      });
    }

    this.open.delete(id);
    this.reserved -= r.ceilingWei;
    this.spent += actualWei;
    this.assertInvariants();
    return r.ceilingWei - actualWei; // refund
  }

  /** Returns a reservation in full (transaction never sent). */
  release(id: string): void {
    const r = this.open.get(id);
    if (!r) throw new AccountingError(`BudgetLedger.release: unknown reservation '${id}'`);
    this.open.delete(id);
    this.reserved -= r.ceilingWei;
    this.assertInvariants();
  }

  /** Releases every open reservation. Used on shutdown / breaker trip. */
  releaseAll(): number {
    const n = this.open.size;
    for (const id of [...this.open.keys()]) this.release(id);
    return n;
  }

  /** Reservations older than `maxAgeMs` — a leak detector for the supervisor. */
  staleReservations(maxAgeMs: number, nowMs = Date.now()): Reservation[] {
    return [...this.open.values()].filter((r) => nowMs - r.createdAtMs > maxAgeMs);
  }

  snapshot(): BudgetSnapshot {
    return {
      poolWei: this.pool,
      reservedWei: this.reserved,
      spentWei: this.spent,
      availableWei: this.availableWei,
      openReservations: this.open.size,
    };
  }

  /**
   * Reconciles against the on-chain ledger. A mismatch means the off-chain view
   * has drifted (e.g. a transaction landed that we did not observe) and the
   * supervisor must halt until a human reconciles.
   */
  reconcile(onChain: { poolWei: Wei; reservedWei: Wei }): void {
    if (onChain.poolWei !== this.pool) {
      throw new AccountingError("BudgetLedger.reconcile: pool drift", {
        local: this.pool.toString(),
        chain: onChain.poolWei.toString(),
      });
    }
    if (onChain.reservedWei !== this.reserved) {
      throw new AccountingError("BudgetLedger.reconcile: reserved drift", {
        local: this.reserved.toString(),
        chain: onChain.reservedWei.toString(),
      });
    }
  }

  private assertInvariants(): void {
    if (this.reserved < 0n) throw new AccountingError("B1 violated: reserved < 0");
    if (this.spent < 0n) throw new AccountingError("B2 violated: spent < 0");
    if (this.reserved + this.spent > this.pool) {
      throw new AccountingError("B3 violated: reserved + spent > pool", {
        reserved: this.reserved.toString(),
        spent: this.spent.toString(),
        pool: this.pool.toString(),
      });
    }
  }
}
