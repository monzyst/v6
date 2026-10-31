# V6-HF — High-Frequency Unrestricted

Production implementation of the V6-HF trading system. Phase 1 ships two live
lanes; Phase 2 is a fully implemented, registry-gated expansion surface that is
**inert by default** and structurally unable to alter Phase 1 behaviour.

```
v6-hf/
├── contracts/
│   ├── BaseFlashExecutor.sol          # Phase 1 Base lane executor
│   ├── Phase2Executor.sol             # Phase 2 position-lifecycle executor
│   ├── access/
│   │   ├── V6HFAccess.sol             # 4-role privilege separation
│   │   └── PhaseRegistry.sol          # phase + strategy + venue gating
│   ├── interfaces/
│   │   ├── IMorpho.sol                # Morpho Blue flash-loan surface
│   │   ├── ISwapRouter.sol            # V2 / V3 / Aerodrome + ERC-20
│   │   ├── IV6HFExecutor.sol          # Phase 1 executor ↔ off-chain boundary
│   │   └── IV6HFPhase2.sol            # Phase 2 boundary + Phase2Actions
│   ├── libraries/
│   │   ├── Errors.sol                 # central error registry
│   │   ├── PhaseMachine.sol           # two disjoint forward-only state spaces
│   │   └── RawMath.sol                # integer-only accounting (unsigned + signed)
│   └── mocks/                         # test doubles (not deployed)
├── packages/
│   ├── core/                          # shared, pure, integer-only
│   │   ├── types.ts                   # bigint-only economic types
│   │   ├── units.ts                   # ceil/floor, fee, native conversion
│   │   ├── economics.ts               # Phase 1: S, N, G, N′, gate, invariant
│   │   ├── eip712.ts                  # Phase 1 plan digest
│   │   ├── budget.ts                  # BudgetLedger (reserve/settle/release)
│   │   ├── breaker.ts                 # CircuitBreaker (sticky, manual reset)
│   │   ├── phase.ts                   # phase enum, domains, transition table
│   │   ├── phase2-types.ts            # Phase 2 types (signed carry)
│   │   ├── phase2-eip712.ts           # Phase 2 plan digest (separate domain)
│   │   └── phase2-economics.ts        # Phase 2: signed carry, gate, sizing
│   ├── base-lane/                     # Phase 1 (i)
│   │   ├── config.ts                  # zod schema, no money defaults
│   │   ├── signers.ts                 # S1–S3 key-material isolation
│   │   ├── preflight.ts               # 6-gate stack
│   │   └── submitter.ts               # reserve → sign → send → settle
│   ├── solana-lane/                   # Phase 1 (ii)
│   │   ├── config.ts
│   │   ├── signers.ts                 # Ed25519 intent isolation
│   │   ├── jupiter.ts                 # borrow → route → payback
│   │   └── submitter.ts
│   ├── phase2/                        # boundary enforcement
│   │   └── boundary.ts                # read-only view, no Phase 1 handles
│   └── phase2-lane/                   # Phase 2 strategies + execution
│       ├── config.ts                  # zod schema, disabled by default
│       ├── signers.ts                 # S1–S4 isolation (incl. cross-phase)
│       ├── market.ts                  # HTTP market data, WAD bigint prices
│       ├── strategy-base.ts           # strategy interface + integer helpers
│       ├── strategies.ts              # basis / LST loop / options-hedged MM
│       ├── gate.ts                    # 7-gate stack (incl. phase + leg action)
│       └── submitter.ts               # reserve → sign → send → settle
├── test/                              # 8 suites, all green
├── docs/SPEC_MAPPING.md               # requirement → code traceability
└── scripts/compile.cjs                # deterministic solc build
```

## Build & test

```bash
npm install
npm run build          # solc + tsc
npm test               # all eight suites
```

`npm run build:contracts` emits `build/artifacts.json` (ABI + bytecode), which
the off-chain packages consume as the single source of truth for the executor
ABI.

### Test suites

| Suite | Assertions | Covers |
|---|---|---|
| `accounting.mjs` | — | Phase 1 integer formulas, budget ledger, breaker |
| `eip712_parity.mjs` | — | Phase 1 on-chain digest == off-chain digest |
| `e2e_cycle.mjs` | — | Phase 1 full happy path, 80 USDC profit swept |
| `invariants.mjs` | 12 | Phase 1 negative paths with breaker codes |
| `solana_accounting.mjs` | 12 | Solana lane: zero fee, leg floor, gate vs invariant |
| `phase2_strategies.mjs` | 64 | Phase 2 domain disjointness, signed carry, strategies |
| `phase2_contracts.mjs` | 52 | Phase 2 deploy, gating, breaker, budget, access control |
| `phase_separation.mjs` | 40 | Source-tree scan, exhaustive disjointness, runtime inertness |

---

## Phase status

| Phase | Status |
|---|---|
| Phase 1 — Base lane (Morpho flash arb) | ✅ Fully implemented |
| Phase 1 — Solana lane (Jupiter Lend) | ✅ Fully implemented |
| Phase 2 — on-chain surface (`Phase2Executor`, `PhaseRegistry`) | ✅ Fully implemented |
| Phase 2 — cross-venue basis strategy | ✅ Fully implemented |
| Phase 2 — LST restake loop strategy | ✅ Fully implemented |
| Phase 2 — options-hedged MM strategy | ✅ Fully implemented |
| Phase 2 — market data, gate, submitter, config | ✅ Fully implemented |
| Phase 2 — phase-separation enforcement | ✅ Fully implemented |

Deliberately excluded (with reasons) is listed in `docs/SPEC_MAPPING.md` §9.

---

## Deployment assumptions

### 1. Chain and contract addresses (Base mainnet, chainId 8453)

| Item | Value | Notes |
|---|---|---|
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | canonical deployment |
| WETH (native token) | `0x4200000000000000000000000000000000000006` | Base predeploy |
| USDC (loan asset) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 decimals |
| Uniswap V3 router | `0x2626664c2603336E57B271c5C0b26F421741e481` | `dexKind = 1` |
| Aerodrome router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` | `dexKind = 2` |
| Sushi / BaseSwap V2 | supply per deployment | `dexKind = 0` |

Staging uses Base Sepolia (`chainId 84532`); the config schema pins `8453`, so
change the literal for staging builds.

### 2. Constructor arguments

```solidity
new BaseFlashExecutor(
    owner_,                    // multisig; governance only
    authorizer_,               // COLD key; signs plans; never sends tx
    executor_,                 // HOT key; sends tx; never signs plans
    guardian_,                 // may trip breaker; cannot move funds
    morpho_,                   // Morpho Blue address
    nativeToken_,              // WETH
    absoluteMaxFlashFeeRaw_    // e.g. 1_000_000 (1 USDC at 6dp)
);
```

The constructor **reverts** if `authorizer_ == owner_` or
`authorizer_ == executor_`. This is not configurable.

### 3. Post-deploy configuration (owner only)

```solidity
setLoanAsset(USDC, true);
setRouter(uniswapV3Router, true);
setRouter(aerodromeRouter, true);
fundGasBudget{value: 0.05 ether}(0.05 ether);   // payable; amount must equal msg.value
```

`fundGasBudget` is `payable` and rejects `amountWei != msg.value`.

### 4. Required environment variables

`packages/base-lane/src/config.ts` validates all of these with zod. **There are
no defaults for any value that affects money** — a missing value is a startup
failure.

| Variable | Type | Meaning |
|---|---|---|
| `CHAIN_ID` | `8453` | literal |
| `RPC_URL` | url | Base RPC |
| `EXECUTOR` | address | deployed executor |
| `MORPHO` | address | Morpho Blue |
| `NATIVE_TOKEN` | address | WETH |
| `EXECUTOR_PRIVATE_KEY` | 32-byte hex | **hot** key |
| `AUTHORIZER_PRIVATE_KEY` | 32-byte hex | **cold** key |
| `EXPECTED_AUTHORIZER_ADDRESS` | address | must match the cold key |
| `MIN_NET_PROFIT_RAW` | uint string | **P**, raw loan-asset units |
| `MAX_LOAN_RAW` | uint string | hard loan cap |
| `MAX_FLASH_FEE_RAW` | uint string | fee ceiling |
| `GAS_UNITS_PER_CYCLE` | uint string | gas limit + reservation basis |
| `GAS_PRICE_CEILING_WEI` | uint string | breaker trips above this |
| `RAW_PER_NATIVE` | uint string | **raw** units per 1 whole native (see below) |
| `GAS_BUDGET_POOL_WEI` | uint string | epoch budget |
| `SUBMITTER_MIN_BALANCE_WEI` | uint string | hot-key gas floor |

Optional (documented defaults): `MAX_CONSECUTIVE_FAILURES=3`,
`MAX_SLIPPAGE_BPS=50`, `STALENESS_LIMIT_SECONDS=300`, `PLAN_TTL_SECONDS=12`,
`POLL_INTERVAL_MS=250`, `DRY_RUN=false`.

### 5. `RAW_PER_NATIVE` — the one value that is easy to get wrong

It is the number of **raw** token units equal to **one whole** native token,
**not** scaled by 1e18.

- 6-decimal USDC at 3000 USDC/ETH → `3000000000`
- 18-decimal DAI at 3000 DAI/ETH → `3000 * 10^18`

Getting this wrong by 1e12 silently makes every gas estimate wrong by 1e12.
`units.ts :: nativeFromRaw` documents it; `test/accounting.mjs` asserts it.

### 6. Solana lane

| Item | Value |
|---|---|
| Jupiter Lend program | resolved at runtime by `@jup-ag/lend` |
| Flash fee | **0** (protocol charges none) |
| `loanAssetMint` | USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `loanAssetDecimals` | 6 |
| `executorKeypairPath` | JSON array of 64 bytes (hot) |
| `authorizerKeypairPath` | JSON array of **32** bytes (cold Ed25519 seed) |
| `expectedAuthorizer` | base58 pubkey of the cold key |
| `priorityFeeCeilingMicroLamports` | e.g. `100000` |
| `computeUnitLimit` | e.g. `1000000` |

The cold key is a 32-byte Ed25519 **seed**; the hot key is a standard 64-byte
Solana keypair. They must derive different public keys or startup fails.

### 7. Operational assumptions

- **The hot key holds gas only.** It is assumed compromisable. Its blast radius
  is one already-signed, still-unexpired plan.
- **The cold key is offline.** It signs `ExecutionPlan` digests (Base) or
  intent digests (Solana) and never touches a network.
- **`planTtlSeconds` is short (12s default).** A signed plan that is not
  broadcast within its TTL is dead. This bounds replay value.
- **The breaker is sticky.** Clearing it requires an owner transaction
  (`resetBreaker`) after a human has reviewed `CycleFailed.revertData`.
- **Profit is swept per cycle.** The executor holds no idle capital between
  cycles, so a compromised executor cannot drain a balance that isn't there.
- **`execute` returns `(bool, uint256)`.** A non-reverting call with
  `success == false` is a **failure** with the breaker now open. Any integrator
  that ignores the bool will misreport failed cycles as filled.

### 8. Known deployment-time decisions left to the operator

- Which DEXes to allowlist, and their exact router addresses per chain.
- The value of `MIN_NET_PROFIT_RAW` (P). It must exceed the all-in cost of a
  cycle: flash fee + gas + expected slippage. A P below gas cost guarantees
  the gate passes on unprofitable trades.
- `absoluteMaxFlashFeeRaw` — set from the worst Morpho fee you are willing to
  pay, not from the current fee.
- Whether `DRY_RUN` is on. It should be on until `test/e2e_cycle.mjs`-style
  behaviour is observed against a fork of the live chain.

---

## Phase 2 deployment assumptions

Phase 2 is **disabled by default at three independent levels**. All three must be
satisfied before a single Phase 2 step can execute:

1. `PHASE2_ENABLED=true` in the lane config (default `false`).
2. `PhaseRegistry.phase2Enabled == true` on-chain (default `false`).
3. The specific strategy armed via `requestStrategyArm` → `armStrategy`
   (default: none armed).

### 1. Phase 2 constructor arguments

| Contract | Argument | Notes |
|---|---|---|
| `PhaseRegistry` | `owner_` | Governance. Must not be the authorizer. |
| | `phase2ArmDelaySeconds` | Immutable review window. **Set generously (e.g. 86400).** An owner who can shorten it can defeat the review. |
| `Phase2Executor` | `owner_`, `authorizer_`, `executor_`, `guardian_` | Same 4-role layout as Phase 1. `authorizer_ ∉ {owner_, executor_}` is enforced. |
| | `registry_` | The `PhaseRegistry` address. |
| | `absoluteMaxCostRaw_` | Hard ceiling on `maxCostRaw` across all history. Set from the worst cost you will tolerate, not the current cost. |

### 2. Phase 2 post-deploy configuration (owner only)

```solidity
registry.setVenueAdmin(phase2Executor, true);   // REQUIRED — else executor.setVenue reverts
registry.setPhase2Enabled(true);                // gate 2
registry.requestStrategyArm(1);                 // cross-venue-basis
// ... wait PHASE2_ARM_DELAY ...
registry.armStrategy(1);                        // gate 3
phase2Executor.setVenue(spotVenue, true);       // mirrors into the registry
phase2Executor.setVenue(perpVenue, true);
phase2Executor.fundGasBudget{value: X}(X);      // Phase 2's OWN pool
```

`setVenueAdmin` is easy to forget and its absence is silent until the first
`setVenue` reverts. It is the one post-deploy step that is not optional.

### 3. Phase 2 environment variables

| Variable | Required | Notes |
|---|---|---|
| `PHASE2_ENABLED` | yes | Default `false`. |
| `PHASE2_EXECUTOR` | yes | Deployed `Phase2Executor` address. |
| `PHASE2_REGISTRY` | yes | Deployed `PhaseRegistry` address. |
| `PHASE2_EXECUTOR_PRIVATE_KEY` | yes | Hot key. **Must differ from every Phase 1 key** (S4). |
| `PHASE2_AUTHORIZER_PRIVATE_KEY` | yes | Cold key. **Must differ from every Phase 1 key** (S4). |
| `PHASE2_EXPECTED_AUTHORIZER_ADDRESS` | yes | Startup check (S2). |
| `PHASE2_ASSET` / `PHASE2_ASSET_DECIMALS` | yes | Accounting asset. |
| `PHASE2_MIN_CARRY_RAW` | yes | Signed. May be negative for close steps. |
| `PHASE2_MAX_DEPLOYED_RAW` | yes | Hard cap on principal. |
| `PHASE2_MAX_COST_RAW` | yes | Hard cap on declared cost. |
| `PHASE2_GAS_UNITS_PER_STEP` | yes | Budget reservation basis. |
| `PHASE2_GAS_PRICE_CEILING_WEI` | yes | Above this the breaker trips. |
| `PHASE2_RAW_PER_NATIVE` | yes | Same convention as Phase 1 — see §5. |
| `PHASE2_GAS_BUDGET_POOL_WEI` | yes | Phase 2's own pool. |
| `PHASE2_STRATEGIES` | yes | Subset of the armed set. |
| `PHASE2_STRATEGY_PARAMS` | yes | Per-strategy integer params (JSON). |
| `PHASE2_DRY_RUN` | no | Default `true`. |

### 4. Phase 2 strategy parameters

Each strategy requires its own integer parameters. Missing parameters are a
startup failure, never a default:

- **cross-venue-basis**: `holdingSeconds`, `minBasisBps`, `fundingPeriods`,
  `spotSlippageBps`, `perpSlippageBps`
- **lst-restake-loop**: `holdingSeconds`, `borrowRateWad`,
  `liquidationThresholdBps`, `minHealthFactorWad`, `maxLoops`,
  `stakeSlippageBps`, `borrowSlippageBps`
- **options-hedged-mm**: `strikeWad`, `hedgeCostBps`, `writeSlippageBps`,
  `hedgeSlippageBps`

### 5. Phase 2 venue adapter contract

A Phase 2 venue adapter must implement:

```solidity
function executeLeg(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
    external returns (uint256 out);
```

and **must return the accounting asset**. A venue whose native position
representation is a different token (an LST, an LP share, a lending receipt) must
convert it back to the accounting asset before returning, so the executor's
balance assertion is meaningful. That is the adapter's job, not the executor's.

### 6. Phase 2 operational assumptions

- **One position at a time.** `PositionAlreadyOpen` enforces it. A second
  concurrent position would make carry accounting ambiguous without a
  per-position ledger, and the strategy set does not need it.
- **`DRY_RUN` on until a fork test passes.** `submitter.ts` uses `staticCall`
  under dry-run, so the full gate stack and the on-chain phase lock are exercised
  without broadcasting.
- **The Phase 2 breaker is independent of Phase 1's.** Tripping one does not
  trip the other, in either direction.

---

## Security notes

1. **Signer isolation is enforced twice** — on-chain (`V6HFAccess`) and in key
   material (`signers.ts` S1–S3). Both must pass at startup.
2. **Approvals are exact and cleared.** Each leg approves `amountIn`, then
   resets to 0. Morpho is approved exactly `L + F`.
3. **The pre-pull assertion is exact equality**, which catches fee-on-transfer
   and rebasing loan assets before any swap runs.
4. **The breaker survives the revert that triggered it** (see
   `docs/SPEC_MAPPING.md` §4).
5. **Replay is blocked twice** — by `planConsumed[planHash]` and
   `nonceConsumed[nonce]`.
6. **Phase 2 cannot reach Phase 1.** The two phase state spaces are disjoint
   value sets with disjoint transition tables; the ABIs share no execution
   function; and Phase 2 holds no handle to any Phase 1 object. Four independent
   machine-checked proofs are listed in `docs/SPEC_MAPPING.md` §7.
7. **Phase 1 cannot be disabled by Phase 2.** `PhaseRegistry.isPhaseEnabled`
   returns `true` for the Phase 1 domain with no storage read — there is no
   setter, no slot and no path that can turn it off.
8. **Phase 2 keys are a separate key set.** S4 (`assertDistinctFromPhase1`)
   refuses to start if a Phase 2 key equals a Phase 1 key, so a single cold-key
   compromise cannot span both phases.
9. **A Phase 2 emergency reset cannot strand a position.** `resetBreaker` returns
   the machine to `P2_POSITION_OPEN` when a position is open, never `P2_IDLE`.
