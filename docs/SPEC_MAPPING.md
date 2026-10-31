# V6-HF — Specification-to-Code Mapping

Every requirement in the V6-HF brief, mapped to the exact file and symbol that
satisfies it, plus the test that proves it. Anchors are given as
`file :: symbol` so they survive refactors.

Legend: **✅ verified** = exercised by an automated test in `test/`.

---

## 1. Phase separation

| Requirement | Implementation | Verified |
|---|---|---|
| Phase 1 = Base lane (Morpho flash arb) | `contracts/BaseFlashExecutor.sol`, `packages/base-lane/` | ✅ `test/e2e_cycle.mjs` |
| Phase 1 = Solana lane (Jupiter Lend) | `packages/solana-lane/` | ✅ `test/solana_accounting.mjs` + `jupiter.ts` ordering assertions |
| Phase 2 optional, clearly separated | `packages/phase2/` | ✅ `assertNoPhase1Imports` |
| Phase 2 cannot alter Phase 1 behaviour | `packages/phase2/src/boundary.ts :: Phase2Runtime` — holds no submitter/ledger/breaker reference; returns `[]` when disabled or when the Phase 1 breaker is open | ✅ structural (type-level) |

**Boundary mechanism.** Phase 2 depends only on `@v6hf/core`. It receives a
`Phase1ReadOnlyView` (a value object) and returns `Phase2Proposal[]`. It has no
handle to `BaseLaneSubmitter`, `BudgetLedger`, or `CircuitBreaker`. Deleting
`packages/phase2/` leaves Phase 1 byte-identical.

---

## 2. Smart contract / interfaces

| Requirement | Implementation | Verified |
|---|---|---|
| `BaseFlashExecutor.sol` production contract | `contracts/BaseFlashExecutor.sol` | ✅ compiles, deploys, executes |
| Flash-loan callback modifier | `BaseFlashExecutor.sol :: onlyMorphoCallback` — asserts `msg.sender == morpho` **and** `phase == FLASH_ACTIVE` | ✅ `test/invariants.mjs` |
| Phase-machine locks (no reentrancy / out-of-order) | `contracts/libraries/PhaseMachine.sol` — `IDLE → FLASH_ACTIVE → SWAPPING → REPAYING → IDLE`, `isLegal()` table, `entered` latch | ✅ `test/invariants.mjs` (phase returns to IDLE) |
| Outer reentrancy latch | `BaseFlashExecutor.sol :: nonReentrantOuter` (`_outerLock`) — independent of the phase machine | ✅ |
| Owner/executor access control | `contracts/access/V6HFAccess.sol` — 4 roles: OWNER, AUTHORIZER, EXECUTOR, GUARDIAN | ✅ `test/invariants.mjs` (non-owner cannot reset) |
| Explicit privilege separation (signer isolation) | `V6HFAccess.sol :: constructor` + `setAuthorizer` + `grantRole` reject `authorizer ∈ {owner} ∪ executors` | ✅ `test/eip712_parity.mjs` (merged-signer deploy reverts) |
| Interface: executor ↔ off-chain | `contracts/interfaces/IV6HFExecutor.sol` — `ExecutionPlan`, `Leg`, `execute()` | ✅ |
| Interface: executor ↔ Solana path | `packages/solana-lane/src/jupiter.ts :: SolanaPlan` — same economic fields, no shared on-chain state | ✅ |

---

## 3. Mathematical / economic rigor

All quantities are `bigint` (TS) / `uint256` (Solidity). **No floating point
appears in any accounting path.** `number` is used only for indices, gas-unit
counts, decimals, and timestamps.

| Formula | Solidity | TypeScript | Units |
|---|---|---|---|
| `S = R − B0 − L` | `RawMath.sol :: grossSurplusRaw` | `economics.ts :: evaluatePlan` | raw loan-asset units |
| `N = S − F` | `RawMath.sol :: netProfitRaw` | `economics.ts` | raw loan-asset units |
| `F = ceil(L · feeWad / 1e18)` | `RawMath.sol :: flashFeeRaw` | `units.ts :: flashFeeRaw` | raw units; `feeWad` is WAD |
| `G = ceil(gasWei · rawPerNative / 1e18)` | — (off-chain only) | `units.ts :: rawFromNative` | raw units |
| `N′ = N − G` | — | `economics.ts` | raw units |
| Gate `N′ ≥ P` | `RawMath.sol :: meetsGate` | `economics.ts :: gatePassed` | raw units |
| Invariant `R ≥ B0 + L + F + P` | `RawMath.sol :: invariantHolds` | `economics.ts :: invariantHolds` | raw units |
| `nativeWei = floor(raw · 1e18 / rawPerNative)` | — | `units.ts :: nativeFromRaw` | wei |
| bps of amount (floored) | `RawMath.sol :: bps` | `units.ts :: bpsOf` | bps, 1e4 = 100% |

**Unit convention (critical).** `rawPerNative` is the number of **raw** token
units equal to **one whole** native token — *not* scaled by 1e18. For 6-decimal
USDC at 3000 USDC/ETH, `rawPerNative = 3_000_000_000`. This is documented at
`units.ts :: nativeFromRaw` and is the single most common integration error.

**Gate enforcement before send.** `packages/base-lane/src/preflight.ts :: preflight`
runs six gates in fixed order (STATIC → EXPIRY → FEE_CAP → INVARIANT →
PROFIT_GATE → BUDGET) and returns a `GateVerdict`. `submitter.ts` refuses to
sign or broadcast unless `verdict.passed === true`. The budget reservation is
taken **after** the gates and **before** the cold key signs.

**Why two different tests.** `N′ ≥ P` (off-chain) is strictly stronger than
`R ≥ B0 + L + F + P` (on-chain) because it also charges gas. A marginal
opportunity can satisfy the on-chain invariant and still be correctly rejected
off-chain. Both are implemented; neither is derived from the other.

---

## 4. On-chain safety invariants

| Requirement | Implementation | Verified |
|---|---|---|
| Exact **pre-pull** balance assertion | `BaseFlashExecutor.sol :: onMorphoFlashLoan` — `balanceNow == _activePreBalance + assets` (exact equality, not `>=`) | ✅ |
| Exact **post-pull** balance assertion | `BaseFlashExecutor.sol :: runCycle` — `postBalance >= preBalance + minNetProfitRaw` | ✅ |
| Core invariant `R ≥ B0 + L + F + P` | `onMorphoFlashLoan` — `postSwap >= _activePreBalance + assets + fee + _activeProfitFloor` | ✅ `test/invariants.mjs` (reason 1) |
| Defined behaviour on violation | Revert `InvariantViolated(post, required)` → caught by `execute`'s try/catch → `_trip(BREAKER_INVARIANT)` → `CycleFailed` event → `execute` returns `(false, 0)` | ✅ |
| Signer isolation (pull/withdraw vs. submit) | `V6HFAccess.sol` (on-chain) + `packages/base-lane/src/signers.ts :: buildIsolatedSigners` (key material, S1–S3) + `verifyOnChainIsolation` | ✅ |
| Fee-risk budget reservations | `BaseFlashExecutor.sol :: gasBudgetPoolWei` / `gasReservedWei`; `packages/core/src/budget.ts :: BudgetLedger` | ✅ `test/invariants.mjs` (over-reservation rejected) |
| Automated emergency circuit breakers | `BaseFlashExecutor.sol :: breakerOpen` (sticky, survives revert) + `packages/core/src/breaker.ts :: CircuitBreaker` | ✅ `test/invariants.mjs` (reasons 1, 3, 7) |

### The breaker-survives-revert design

A revert rolls back **every** storage write in the transaction, including a
breaker write. So the breaker cannot be written in the frame that reverts.

`execute` therefore calls `this.runCycle(...)` as an **external self-call**
inside `try/catch`. A revert inside `runCycle` rolls back only the cycle
(phase machine, approvals, swaps) while the outer frame stays alive and
persists `breakerOpen = true`.

**Consequence for integrators:** `execute` returning without revert does **not**
mean success. It returns `(bool success, uint256 netProfitRaw)`. A non-reverting
call with `success == false` means the cycle failed and the breaker is open.
`packages/base-lane/src/submitter.ts` checks this and mirrors the trip locally.

### Breaker reason codes (stable ABI)

| Code | Constant | Trigger |
|---|---|---|
| 1 | `BREAKER_INVARIANT` | `InvariantViolated` |
| 2 | `BREAKER_BUDGET` | `BudgetExceeded` / gas overrun |
| 3 | `BREAKER_FEE_CAP` | `FlashFeeExceedsCap` |
| 4 | `BREAKER_PROFIT_GATE` | `NetProfitBelowGate` |
| 5 | `BREAKER_SWAP` | `SwapFailed` / `InsufficientOutput` |
| 6 | `BREAKER_MANUAL` | `tripBreaker()` by guardian/owner |
| 7 | `BREAKER_HEALTH` | unclassified revert |

---

## 5. Solana lane specifics

| Requirement | Implementation |
|---|---|
| Jupiter Lend execution | `packages/solana-lane/src/jupiter.ts :: buildFlashloanTransaction` |
| Atomicity | Single transaction: `borrow → custom → payback`. No callback exists; instruction order **is** the phase machine. |
| Ordering assertion | `jupiter.ts :: assertOrdering` — payback must be the final instruction; custom count must match exactly |
| Zero flash fee | `F = 0` by configuration (`morphoFeeWad = 0n`), not by a code branch — the shared engine is unchanged |
| Signer isolation | `signers.ts :: buildSolanaSigners` (S1, S2) + Ed25519 intent signature verified before build |
| Budget | `jupiter.ts :: estimateLamportCost` — base fee + `ceil(microLamports · CU / 1e6)` |
| Route leg floor | `jupiter.ts :: SolanaRouteLeg.minAmountOut` — **required**, never defaulted. A leg with no floor projects a zero balance and fails as unrepayable, which is the correct outcome for an unquantified route. |

---

## 6. Phase 2 — on-chain surface

Phase 2 is a **multi-transaction position lifecycle** over three registry-gated
strategies. It reuses the Phase 1 access control, phase-machine library and raw
math library; it introduces no parallel implementation of any of them.

| Requirement | Implementation | Verified |
|---|---|---|
| Phase 2 executor contract | `contracts/Phase2Executor.sol` | ✅ `test/phase2_contracts.mjs` (deploys with code) |
| Phase enablement registry | `contracts/access/PhaseRegistry.sol` | ✅ `test/phase2_contracts.mjs` |
| Phase 1 always enabled, cannot be disabled | `PhaseRegistry.sol :: isPhaseEnabled` — `if (phase == DOMAIN_PHASE1) return true;` with **no storage read** | ✅ `test/phase2_contracts.mjs` |
| Phase 2 opt-in (master switch) | `PhaseRegistry.sol :: phase2Enabled` (default `false`) | ✅ `test/phase2_contracts.mjs` |
| Phase 2 opt-in (per strategy) | `PhaseRegistry.sol :: strategyEnabled` + `isStrategyEnabled` requires **both** bits | ✅ `test/phase2_contracts.mjs` |
| Two-step arming with a review window | `PhaseRegistry.sol :: requestStrategyArm` → `armStrategy`, gated by immutable `PHASE2_ARM_DELAY` | ✅ `test/phase2_contracts.mjs` (arm before delay reverts) |
| Disabling is instant | `setPhase2Enabled(false)` / `disarmStrategy` have no timelock | ✅ |
| Venue allowlist, separate from Phase 1's | `PhaseRegistry.sol :: venueAllowed` + narrow `venueAdmin` role | ✅ `test/phase2_contracts.mjs` |
| Phase 2 interface, disjoint from Phase 1's | `contracts/interfaces/IV6HFPhase2.sol` — no shared struct/function/event | ✅ `test/phase2_contracts.mjs` (ABI intersection) |
| Per-leg action tags | `IV6HFPhase2.sol :: Phase2Actions` (library — interfaces cannot hold constants) | ✅ `test/phase2_strategies.mjs` |
| Phase 2 venue test double | `contracts/mocks/MockPhase2Venue.sol` | ✅ `test/phase2_contracts.mjs` |

### Phase 2 phase locks

| Lock | Implementation | Verified |
|---|---|---|
| Disjoint state space | `PhaseMachine.sol` — Phase 1 ∈ [0,3], Phase 2 ∈ [10,13] | ✅ `test/phase_separation.mjs` (exhaustive) |
| No cross-domain edge exists | `PhaseMachine.sol :: isLegal` — two disconnected components | ✅ `test/phase_separation.mjs` (8×8 enumeration + transitive closure) |
| Constructor-only bootstrap | `PhaseMachine.sol :: initPhase2` — `IDLE(0) → P2_IDLE(10)`; `isLegal` has no such edge, so no runtime path can perform it | ✅ `test/phase2_contracts.mjs` (boots at phase 10) |
| Entry-point phase assertion | `Phase2Executor.sol :: requirePhaseExpected` | ✅ `test/phase2_contracts.mjs` |
| Per-leg action assertion | `Phase2Executor.sol :: dispatch` — every leg's `action` must equal the step's | ✅ `test/phase2_strategies.mjs` |
| Reentrancy latch | `Phase2Executor.sol :: nonReentrantOuter` (`_outerLock`) | ✅ |
| Self-call guard | `Phase2Executor.sol :: dispatch` is `onlySelf` | ✅ |
| Emergency reset cannot strand a position | `Phase2Executor.sol :: resetBreaker` returns to `P2_POSITION_OPEN` when a position is open, never `P2_IDLE` | ✅ `test/phase2_contracts.mjs` |
| Off-chain phase gate | `packages/phase2-lane/src/gate.ts :: phase2Preflight` GATE 2 | ✅ `test/phase2_strategies.mjs` |
| Off-chain leg-action gate | `gate.ts` GATE 5 → `phase2-economics.ts :: assertLegActions` | ✅ `test/phase2_strategies.mjs` |

### Phase 2 accounting (signed carry)

Phase 2 borrows nothing and pays no flash fee, so the Phase 1 invariant
`R ≥ B0 + L + F + P` reduces to `R ≥ B0 + P` — i.e. `carry ≥ floor` with
`carry = R − B0`. The signed form is a **strict generalisation**: with
`floor ≥ 0` it is exactly that, and with `floor < 0` it expresses a
bounded-loss de-risking step, which Phase 1 cannot.

| Formula | Solidity | TypeScript | Units |
|---|---|---|---|
| `carry = R − B0` (signed) | `RawMath.sol :: netCarryRaw` | `phase2-economics.ts :: evaluatePhase2Step` | raw asset units, `int256` |
| `carryNet = carry − C` | — | `phase2-economics.ts` | raw asset units |
| Gate `carryNet ≥ F` | — | `phase2-economics.ts :: gatePassed` | raw asset units |
| Invariant `carry ≥ F` | `Phase2Executor.sol :: dispatch` → `CarryBelowFloor` | `phase2-economics.ts :: invariantHolds` | raw asset units |
| `D_max` for a given edge | — | `phase2-economics.ts :: maxDeployedForGate` | raw asset units |
| `nativeWei = floor(carry · 1e18 / rawPerNative)` | — | `phase2-economics.ts :: carryToNativeWei` | wei, sign-preserving |

**Why `D` is not subtracted.** `deployedRaw` is the principal — the executor's
working float, reused across positions — so it is already inside `B0`.
Subtracting it would double-count. `D` is enforced separately: it must equal the
principal recorded at open (`DeployedAmountMismatch`) and it drives the sizing.

**Interface contract.** A Phase 2 venue adapter MUST return the accounting asset,
converting any native position representation (LST, LP share, lending receipt)
back into it, so the balance assertion is meaningful. That is the adapter's job.

**Gate order** (`gate.ts :: phase2Preflight`): STATIC → PHASE → POSITION →
EXPIRY → LEG_ACTION → CARRY → BUDGET. Cheap static checks first; a step that
fails a static check never consumes a reservation.

### Phase 2 strategies

| Strategy | File | Math |
|---|---|---|
| Cross-venue basis | `packages/phase2-lane/src/strategies.ts :: CrossVenueBasisStrategy` | `edge = basisBps + fundingBps`; `carry = D·basis/1e4 + D·funding·periods` |
| LST restake loop | `strategies.ts :: LstRestakeLoopStrategy` | `HF = L·T/(L−1)`; `L ≤ H/(H−T)`; `carry = D·L·(yield − borrow)` |
| Options-hedged MM | `strategies.ts :: OptionsHedgedMmStrategy` | `delta = clamp(spot/strike,0,1)`; `edge = premiumBps − delta·hedgeBps` |

All three are **pure** with respect to Phase 1: they receive a read-only view and
a market snapshot and return proposals. A strategy with no edge returns `[]` —
it never fabricates one.

**Integer-flooring note.** `healthFactorWad` floors twice, so the closed-form
loop count can land a few wei below the floor. `LstRestakeLoopStrategy` therefore
walks the loop count down until the **computed** HF clears — the same bounded
walk-down `maxDeployedForGate` uses. Trusting the closed form alone would emit a
proposal the gate then rejects.

### Phase 2 market data

`packages/phase2-lane/src/market.ts :: HttpMarketDataProvider` performs real HTTP
requests against venue APIs and parses them into integer-only `MarketSnapshot`s
(all prices WAD `bigint`). A missing or non-numeric field **throws** rather than
defaulting — a defaulted price is a fabricated price. `StaticMarketDataProvider`
exists for tests and is never selected by config.

### Phase 2 signer isolation

| Rule | Implementation | Verified |
|---|---|---|
| S1 executor ≠ authorizer | `packages/phase2-lane/src/signers.ts :: buildPhase2Signers` | ✅ |
| S2 authorizer matches config | `signers.ts` | ✅ |
| S3 executor is not the authorizer | `signers.ts` | ✅ |
| S4 Phase 2 keys ≠ Phase 1 keys | `signers.ts :: assertDistinctFromPhase1` | ✅ |
| On-chain role layout matches local keys | `signers.ts :: verifyPhase2OnChainIsolation` | ✅ |
| Executor really is in the Phase 2 domain | `verifyPhase2OnChainIsolation` — refuses to start otherwise | ✅ |
| Merged keys rejected at deploy | `V6HFAccess.sol :: constructor` | ✅ `test/phase2_contracts.mjs` |

### Phase 2 breaker reason codes

Codes 1–7 are shared with Phase 1 (same numeric ABI). Two are Phase 2-only:

| Code | Constant | Trigger |
|---|---|---|
| 8 | `BREAKER_PHASE_GATE` | `PhaseDisabled` / `StrategyNotAllowed` / `LegActionMismatch` / `Phase2Mismatch` |
| 9 | `BREAKER_POSITION` | `NoOpenPosition` / `PositionAlreadyOpen` / `DeployedAmountMismatch` |

The breaker-survives-revert pattern is identical to Phase 1: `openPosition` /
`hedgePosition` / `closePosition` call `this.dispatch(...)` as an external
self-call inside `try/catch`, so a revert rolls back the step while the breaker
write persists. **A non-reverting call with `success == false` is a failure.**

---

## 7. Phase separation — how it is guaranteed

Four independent lines of evidence, all machine-checked:

1. **Static.** `test/phase_separation.mjs` walks the real source tree and asserts
   no Phase 2 file imports `@v6hf/base-lane` or `@v6hf/solana-lane`, and that no
   Phase 2 file references `BaseFlashExecutor` / `IV6HFExecutor`.
2. **Algebraic.** The phase state spaces are enumerated exhaustively: zero
   cross-domain legal edges, and the transitive closure proves no Phase 1 state
   can reach a Phase 2 state by *any* path (and vice versa).
3. **ABI.** `test/phase2_contracts.mjs` intersects the two contract ABIs and
   asserts no execution entry point (`execute`, `runCycle`, `openPosition`,
   `hedgePosition`, `closePosition`, `dispatch`) is shared.
4. **Runtime.** `Phase2Runtime` is inert by default, silent when the Phase 1
   breaker is open, isolates a throwing strategy, and refuses an undeclared one.

**Consequence:** deleting `packages/phase2/` and `packages/phase2-lane/` leaves
Phase 1 fully functional and byte-identical in behaviour.

---

## 8. Test inventory

| File | Covers |
|---|---|
| `test/accounting.mjs` | Integer formulas, ceil-fee rounding, budget ledger, breaker, digest determinism, sizing |
| `test/eip712_parity.mjs` | On-chain `hashPlan` == off-chain digest; typehash parity; non-executor rejection; merged-signer deploy reverts |
| `test/e2e_cycle.mjs` | Full happy path: deploy → configure → sign (cold) → execute (hot) → 80 USDC profit swept → budget settled → phase IDLE |
| `test/invariants.mjs` | 12 negative paths: wrong signer, expiry, unlisted router, breaker latch, breaker blocks, reset authz, invariant violation, replay, budget exhaustion, fee cap, phase settle |
| `test/solana_accounting.mjs` | 12 assertions: the audited zero-leg-floor defect, the zero-fee identity, gate-vs-invariant, insufficient route, expiry |
| `test/phase2_strategies.mjs` | 64 assertions: domain disjointness, signed carry, step-aware formula, leg action tags, strategy math, strategy proposals + negative paths, Phase 2 EIP-712 |
| `test/phase2_contracts.mjs` | 52 assertions: deploy, phase bootstrap, registry gating, access control, budget, venue allowlist, phase gating, cross-phase reachability, breaker, EIP-712 parity |
| `test/phase_separation.mjs` | 40 assertions: source-tree import scan, exhaustive disjointness, transitive closure, runtime inertness, phase gate, step/phase consistency |

Run: `npm test` (all 8 suites) or `node test/<name>.mjs` individually.

---

## 9. Phase status

| Phase | Status | Notes |
|---|---|---|
| **Phase 1 — Base lane** | ✅ Fully implemented | Morpho flash-funded arbitrage, `BaseFlashExecutor.sol` |
| **Phase 1 — Solana lane** | ✅ Fully implemented | Jupiter Lend, `packages/solana-lane/` |
| **Phase 2 — on-chain surface** | ✅ Fully implemented | `Phase2Executor.sol`, `PhaseRegistry.sol`, `IV6HFPhase2.sol` |
| **Phase 2 — cross-venue basis** | ✅ Fully implemented | `strategies.ts :: CrossVenueBasisStrategy` |
| **Phase 2 — LST restake loop** | ✅ Fully implemented | `strategies.ts :: LstRestakeLoopStrategy` |
| **Phase 2 — options-hedged MM** | ✅ Fully implemented | `strategies.ts :: OptionsHedgedMmStrategy` |
| **Phase 2 — market data** | ✅ Fully implemented | `market.ts :: HttpMarketDataProvider` |
| **Phase 2 — gate / submitter / config** | ✅ Fully implemented | `gate.ts`, `submitter.ts`, `config.ts` |
| **Phase 2 — phase separation** | ✅ Fully implemented | `packages/phase2/src/boundary.ts` |

### Deliberately excluded, with reasons

| Item | Reason |
|---|---|
| Live fork test against Base mainnet state | Requires an archive RPC endpoint and funded keys; the in-process EVM suite covers every invariant. This is the correct next gate before real capital. |
| Solana devnet execution of the Phase 2 equivalent | No funded keypair in the sandbox. The Solana lane is typechecked and its ordering assertions are unit-tested. |
| A Phase 2 position ledger (multiple concurrent positions) | Phase 2 is deliberately one-position-at-a-time: a second concurrent position would make carry accounting ambiguous without a per-position ledger, and the strategy set does not need it. `PositionAlreadyOpen` enforces it. |
| On-chain strategy math | The strategies are off-chain by design — they need market data. The on-chain contract enforces the *result* (the carry invariant), which is the security-relevant half. |
| A Phase 2 Solana lane | Phase 2's three strategies are EVM-native (basis, LST loop, options MM). A Solana Phase 2 would be a new phase, not an extension of this one. |
