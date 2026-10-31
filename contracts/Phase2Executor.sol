// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {V6HFAccess} from "./access/V6HFAccess.sol";
import {PhaseRegistry} from "./access/PhaseRegistry.sol";
import {Errors} from "./libraries/Errors.sol";
import {PhaseMachine} from "./libraries/PhaseMachine.sol";
import {RawMath} from "./libraries/RawMath.sol";
import {IERC20} from "./interfaces/ISwapRouter.sol";
import {IV6HFPhase2, Phase2Actions} from "./interfaces/IV6HFPhase2.sol";

/// @title Phase2Executor
/// @notice V6-HF Phase 2 executor: a MULTI-TRANSACTION position lifecycle over the
///         PhaseRegistry-gated strategies (cross-venue basis, LST restake loop,
///         options-hedged market making).
///
/// @dev    PHASE SEPARATION — how it is guaranteed rather than promised
///         ----------------------------------------------------------
///         (S1) DISJOINT TYPE. This contract implements `IV6HFPhase2`, not
///              `IV6HFExecutor`. It does not import `IV6HFExecutor`, does not declare
///              `ExecutionPlan`, and has no `execute` function. A Phase 1 plan cannot
///              be passed here and a Phase 2 plan cannot be passed there: the ABIs do
///              not intersect.
///
///         (S2) DISJOINT STATE SPACE. It boots its machine with `initPhase2()`, so its
///              phase is always in [10,13] or the P2_IDLE origin. `PhaseMachine.isLegal`
///              contains no edge between [0,3] and [10,13], so no sequence of calls on
///              this contract can produce a Phase 1 phase value — and therefore no
///              callback or entry point here can satisfy a Phase 1 `requirePhase(IDLE)`.
///
///         (S3) DISJOINT CAPITAL. It has its own `gasBudgetPoolWei` / `gasReservedWei`
///              and its own `breakerOpen`. It cannot read or write the Phase 1 pool or
///              breaker, and Phase 1 cannot read or write these.
///
///         (S4) REGISTRY GATE. Every entry point calls `registry.requirePhaseEnabled(
///              DOMAIN_PHASE2)` and `registry.requireStrategyEnabled(plan.strategy)`.
///              Because `PhaseRegistry.isPhaseEnabled(DOMAIN_PHASE1)` is an
///              unconditional `true` literal, nothing here can disable Phase 1.
///
/// @dev    Execution frame (mirrors Phase 1's breaker-survives-revert pattern)
///         -----------------------------------------------------------------
///         openPosition / hedgePosition / closePosition    [outer frame]
///           └─ this.runOpen / runHedge / runClose          [self-call => rollback boundary]
///           └─ on revert: _trip(reason) PERSISTS, returns (false, 0)
///
///         CONSEQUENCE FOR INTEGRATORS: a non-reverting return with `success == false`
///         means the step failed and the breaker is now open. `packages/phase2/src/
///         submitter.ts` checks this bool explicitly.
contract Phase2Executor is V6HFAccess, IV6HFPhase2 {
    using PhaseMachine for PhaseMachine.State;

    // ---------------------------------------------------------------------
    // EIP-712 — a Phase 2 domain, separate from Phase 1's by name and types
    // ---------------------------------------------------------------------

    bytes32 public constant P2_LEG_TYPEHASH = keccak256(
        "P2Leg(address venue,address tokenIn,address tokenOut,uint256 amountIn,"
        "uint256 minAmountOut,uint8 action,uint256 deadline)"
    );

    bytes32 public constant PHASE2_PLAN_TYPEHASH = keccak256(
        "Phase2Plan(uint8 strategy,address asset,uint256 deployedRaw,int256 minCarryRaw,"
        "uint256 maxCostRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline,"
        "address profitRecipient,bytes32 legsHash)"
    );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev Different domain name from Phase 1 ("V6-HF"): a signature produced for a
    ///      Phase 1 plan can never verify against this contract even if the type
    ///      hashes were somehow made to collide.
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("V6-HF-PHASE2");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    // ---------------------------------------------------------------------
    // Breaker reason codes — same numeric ABI as Phase 1 + two Phase 2-only codes
    // ---------------------------------------------------------------------

    uint8 public constant BREAKER_INVARIANT = 1;
    uint8 public constant BREAKER_BUDGET = 2;
    uint8 public constant BREAKER_FEE_CAP = 3;
    uint8 public constant BREAKER_PROFIT_GATE = 4;
    uint8 public constant BREAKER_SWAP = 5;
    uint8 public constant BREAKER_MANUAL = 6;
    uint8 public constant BREAKER_HEALTH = 7;
    /// @dev Phase 2 only: the registry refused the phase or the strategy.
    uint8 public constant BREAKER_PHASE_GATE = 8;
    /// @dev Phase 2 only: a position-lifecycle pre-condition failed.
    uint8 public constant BREAKER_POSITION = 9;

    // ---- Local aliases for the leg action tags (single source: Phase2Actions) ----
    uint8 public constant ACTION_OPEN_VENUE = Phase2Actions.OPEN_VENUE;
    uint8 public constant ACTION_HEDGE = Phase2Actions.HEDGE;
    uint8 public constant ACTION_CLOSE_VENUE = Phase2Actions.CLOSE_VENUE;

    // ---------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------

    PhaseRegistry public immutable registry;
    /// @notice Hard ceiling on `maxCostRaw` across all history. A plan can tighten it.
    uint256 public immutable absoluteMaxCostRaw;

    // ---------------------------------------------------------------------
    // Budget (Phase 2's own pool — never Phase 1's)
    // ---------------------------------------------------------------------

    uint256 public gasBudgetPoolWei;
    uint256 public gasReservedWei;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    PhaseMachine.State private _phase;

    mapping(bytes32 => bool) public planConsumed;
    mapping(uint256 => bool) public nonceConsumed;

    bool public breakerOpen;
    uint8 public breakerReason;
    uint256 public breakerTrippedAt;
    uint256 public breakerTripCount;

    uint256 public stepsSucceeded;
    uint256 public stepsFailed;
    int256 public cumulativeCarryRaw;
    uint256 public positionsOpened;
    uint256 public positionsClosed;

    uint256 private _outerLock = 1;

    /// @notice The single open position. Phase 2 is deliberately one-position-at-a-time:
    ///         a second concurrent position would make the carry accounting ambiguous
    ///         without a per-position ledger, and the strategy set does not need it.
    struct Position {
        uint256 positionId;
        uint8 strategy;
        address asset;
        uint256 deployedRaw;
        uint256 openedAt;
        int256 realisedCarryRaw;
        bool open;
    }
    Position public position;

    /// @dev Transient context, reset at the start of every step.
    bytes32 private _activePlanHash;
    uint8 private _activeAction;
    uint256 private _activePreBalance;
    uint256 private _activeDeployedRaw;
    int256 private _activeCarryFloor;
    uint8 private _activeStrategy;
    address private _activeAsset;
    address private _activeProfitRecipient;
    uint256 private _activeMaxCost;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event BreakerReset(address indexed by);
    event BudgetFunded(uint256 amountWei, uint256 newPoolWei);
    event BudgetSettled(uint256 reservedWei, uint256 actualWei, uint256 refundedWei);
    event VenueSet(address indexed venue, bool allowed);
    event Rescue(address indexed token, address indexed to, uint256 amountRaw);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier nonReentrantOuter() {
        if (_outerLock != 1) revert Errors.ReentrancyBlocked();
        _outerLock = 2;
        _;
        _outerLock = 1;
    }

    modifier breakerClosed() {
        if (breakerOpen) revert Errors.BreakerOpen(breakerReason);
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert Errors.NotSelf();
        _;
    }

    /// @dev Phase-gated entry: the registry must allow Phase 2 at all.
    modifier phase2Enabled() {
        if (!registry.isPhaseEnabled(PhaseMachine.DOMAIN_PHASE2)) {
            revert Errors.PhaseDisabled(PhaseMachine.DOMAIN_PHASE2);
        }
        _;
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(
        address owner_,
        address authorizer_,
        address executor_,
        address guardian_,
        address registry_,
        uint256 absoluteMaxCostRaw_
    ) V6HFAccess(owner_, authorizer_, executor_, guardian_) {
        if (registry_ == address(0)) revert Errors.SignerIsolationViolation();
        registry = PhaseRegistry(registry_);
        absoluteMaxCostRaw = absoluteMaxCostRaw_;
        // Bootstrap INTO the Phase 2 domain. From here on, `isLegal` has no path back
        // to a Phase 1 state value.
        _phase.initPhase2();
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setVenue(address venue, bool allowed) external onlyOwner {
        // Mirrored into the registry so one gate governs the other; both must agree.
        registry.setVenue(venue, allowed);
        emit VenueSet(venue, allowed);
    }

    function fundGasBudget(uint256 amountWei) external payable onlyOwner {
        if (amountWei != msg.value) revert Errors.BudgetMismatch(amountWei, msg.value);
        gasBudgetPoolWei += amountWei;
        emit BudgetFunded(amountWei, gasBudgetPoolWei);
    }

    function tripBreaker(uint8 reason) external {
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && msg.sender != _ownerAddr()) revert Errors.NotGuardian();
        _trip(reason);
    }

    /// @notice Owner-only reset. If a position is open, the machine is returned to
    ///         P2_POSITION_OPEN (not P2_IDLE): a breaker reset must never make an open
    ///         position invisible, which would strand the deployed capital.
    function resetBreaker() external onlyOwner {
        if (!breakerOpen) revert Errors.BreakerNotOpen();
        breakerOpen = false;
        breakerReason = 0;
        _phase.forceReset();
        if (position.open) _phase.phase = PhaseMachine.P2_POSITION_OPEN;
        emit BreakerReset(msg.sender);
    }

    function rescue(address token, address to, uint256 amountRaw) external onlyOwner {
        if (_phase.phase == PhaseMachine.P2_CLOSING) {
            revert Errors.PhaseMismatch(PhaseMachine.P2_IDLE, _phase.phase);
        }
        if (position.open) revert Errors.PositionAlreadyOpen();
        if (to == address(0)) revert Errors.SignerIsolationViolation();
        if (!IERC20(token).transfer(to, amountRaw)) revert Errors.NativeTransferFailed();
        emit Rescue(token, to, amountRaw);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function phase() external view returns (uint8) {
        return _phase.phase;
    }

    function phaseCycleId() external view returns (uint256) {
        return _phase.cycleId;
    }

    function availableGasBudgetWei() external view returns (uint256) {
        return gasBudgetPoolWei - gasReservedWei;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this))
        );
    }

    function hashPlan(Phase2Plan calldata plan) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PHASE2_PLAN_TYPEHASH,
                plan.strategy,
                plan.asset,
                plan.deployedRaw,
                plan.minCarryRaw,
                plan.maxCostRaw,
                plan.gasBudgetWei,
                plan.nonce,
                plan.deadline,
                plan.profitRecipient,
                _hashLegs(plan.legs)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashLegs(P2Leg[] calldata legs) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](legs.length);
        for (uint256 i = 0; i < legs.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(
                    P2_LEG_TYPEHASH,
                    legs[i].venue,
                    legs[i].tokenIn,
                    legs[i].tokenOut,
                    legs[i].amountIn,
                    legs[i].minAmountOut,
                    legs[i].action,
                    legs[i].deadline
                )
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @notice Off-chain mirror of the signed carry invariant. Pure.
    function previewCarry(uint256 postBalance, uint256 preBalance, uint256 deployedRaw)
        external
        pure
        returns (int256 carryRaw, bool invariantHolds, uint256 requiredMin)
    {
        carryRaw = RawMath.netCarryRaw(postBalance, preBalance, deployedRaw);
        // The invariant is evaluated against the plan's own floor, which the caller
        // supplies via `minCarryRaw`; here we report the break-even threshold.
        invariantHolds = carryRaw >= 0;
        requiredMin = preBalance + deployedRaw;
    }

    // ---------------------------------------------------------------------
    // Phase-gated entry points
    // ---------------------------------------------------------------------

    /// @inheritdoc IV6HFPhase2
    function openPosition(Phase2Plan calldata plan, bytes calldata sig)
        external
        onlyRole(EXECUTOR_ROLE)
        nonReentrantOuter
        breakerClosed
        phase2Enabled
        returns (bool success, int256 realisedCarryRaw)
    {
        _preflightStatic(plan);
        requirePhaseExpected(PhaseMachine.P2_IDLE);
        if (position.open) revert Errors.PositionAlreadyOpen();

        return _run(plan, sig, ACTION_OPEN_VENUE);
    }

    /// @inheritdoc IV6HFPhase2
    function hedgePosition(Phase2Plan calldata plan, bytes calldata sig)
        external
        onlyRole(EXECUTOR_ROLE)
        nonReentrantOuter
        breakerClosed
        phase2Enabled
        returns (bool success, int256 realisedCarryRaw)
    {
        _preflightStatic(plan);
        requirePhaseExpected(PhaseMachine.P2_POSITION_OPEN);
        if (!position.open) revert Errors.NoOpenPosition();
        if (plan.deployedRaw != position.deployedRaw) {
            revert Errors.DeployedAmountMismatch(plan.deployedRaw, position.deployedRaw);
        }

        return _run(plan, sig, ACTION_HEDGE);
    }

    /// @inheritdoc IV6HFPhase2
    function closePosition(Phase2Plan calldata plan, bytes calldata sig)
        external
        onlyRole(EXECUTOR_ROLE)
        nonReentrantOuter
        breakerClosed
        phase2Enabled
        returns (bool success, int256 realisedCarryRaw)
    {
        _preflightStatic(plan);
        // Close is legal from OPEN or HEDGING. The machine still has to be the one
        // that decides, so we check membership of the legal predecessor set and then
        // let `advance()` authorise the actual close transition.
        uint8 p = _phase.phase;
        if (p != PhaseMachine.P2_POSITION_OPEN && p != PhaseMachine.P2_HEDGING) {
            revert Errors.Phase2Mismatch(PhaseMachine.P2_POSITION_OPEN, p);
        }
        if (!position.open) revert Errors.NoOpenPosition();
        if (plan.deployedRaw != position.deployedRaw) {
            revert Errors.DeployedAmountMismatch(plan.deployedRaw, position.deployedRaw);
        }

        return _run(plan, sig, ACTION_CLOSE_VENUE);
    }

    // ---------------------------------------------------------------------
    // Shared preflight (static, no external calls)
    // ---------------------------------------------------------------------

    function _preflightStatic(Phase2Plan calldata plan) internal view {
        if (plan.legs.length == 0) revert Errors.EmptyLegs();
        if (block.timestamp > plan.deadline) revert Errors.PlanExpired(plan.deadline, block.timestamp);
        if (plan.profitRecipient == address(0)) revert Errors.SignerIsolationViolation();
        if (plan.asset == address(0)) revert Errors.LoanAssetNotAllowed(plan.asset);
        if (plan.maxCostRaw > absoluteMaxCostRaw) revert Errors.FlashFeeExceedsCap(plan.maxCostRaw, absoluteMaxCostRaw);
        if (plan.gasBudgetWei == 0) revert Errors.BudgetUnavailable(0, 0);
        if (!registry.isStrategyEnabled(plan.strategy)) revert Errors.StrategyNotAllowed(plan.strategy);
    }

    /// @dev Asserts the machine is in `expected`. The second half of the phase lock —
    ///      the per-leg `action` assertion — lives in `dispatch`, where it is applied
    ///      to every leg of the plan before any venue is called.
    function requirePhaseExpected(uint8 expected) internal view {
        if (_phase.phase != expected) revert Errors.Phase2Mismatch(expected, _phase.phase);
    }

    // ---------------------------------------------------------------------
    // Execution wrapper — breaker must survive the revert
    // ---------------------------------------------------------------------

    function _run(Phase2Plan calldata plan, bytes calldata sig, uint8 action)
        internal
        returns (bool success, int256 realisedCarryRaw)
    {
        bytes32 planHash = hashPlan(plan);
        if (planConsumed[planHash]) revert Errors.PlanAlreadyUsed(plan.nonce);
        if (nonceConsumed[plan.nonce]) revert Errors.PlanAlreadyUsed(plan.nonce);
        if (_recover(planHash, sig) != _authorizerAddr()) revert Errors.BadSignature();

        uint256 available = gasBudgetPoolWei - gasReservedWei;
        if (plan.gasBudgetWei > available) revert Errors.BudgetUnavailable(plan.gasBudgetWei, available);
        gasReservedWei += plan.gasBudgetWei;

        uint256 gasAtStart = gasleft();
        uint256 reserved = plan.gasBudgetWei;

        try this.dispatch(plan, planHash, action) returns (int256 carry) {
            success = true;
            realisedCarryRaw = carry;
        } catch (bytes memory reason) {
            gasReservedWei -= reserved;
            stepsFailed += 1;
            _trip(_classify(reason));
            emit Phase2Failed(planHash, breakerReason, reason);
            return (false, 0);
        }

        uint256 gasUsed = gasAtStart - gasleft();
        uint256 actualWei = gasUsed * tx.gasprice;
        gasReservedWei -= reserved;

        if (actualWei > reserved) {
            gasBudgetPoolWei -= reserved;
            _trip(BREAKER_BUDGET);
            emit Phase2Failed(planHash, BREAKER_BUDGET, "");
            return (false, realisedCarryRaw);
        }

        gasBudgetPoolWei -= actualWei;
        emit BudgetSettled(reserved, actualWei, reserved - actualWei);

        planConsumed[planHash] = true;
        nonceConsumed[plan.nonce] = true;
        stepsSucceeded += 1;
        cumulativeCarryRaw += realisedCarryRaw;

        emit Phase2Executed(planHash, plan.strategy, action, plan.deployedRaw, realisedCarryRaw, actualWei);
    }

    /// @notice The step body. External so `_run` can wrap it in try/catch.
    ///         Only callable by the contract itself, and only in the P2 domain.
    function dispatch(Phase2Plan calldata plan, bytes32 planHash, uint8 action)
        external
        onlySelf
        returns (int256)
    {
        if (PhaseMachine.domainOf(_phase.phase) != PhaseMachine.DOMAIN_PHASE2) {
            revert Errors.PhaseMismatch(PhaseMachine.P2_IDLE, _phase.phase);
        }

        uint256 preBalance = IERC20(plan.asset).balanceOf(address(this));
        _activePlanHash = planHash;
        _activeAction = action;
        _activePreBalance = preBalance;
        _activeDeployedRaw = plan.deployedRaw;
        _activeCarryFloor = plan.minCarryRaw;
        _activeStrategy = plan.strategy;
        _activeAsset = plan.asset;
        _activeProfitRecipient = plan.profitRecipient;
        _activeMaxCost = plan.maxCostRaw;

        // Every leg must agree with the step being executed.
        for (uint256 i = 0; i < plan.legs.length; ++i) {
            if (plan.legs[i].action != action) {
                revert Errors.LegActionMismatch(i, action, plan.legs[i].action);
            }
            if (!registry.venueAllowed(plan.legs[i].venue)) {
                revert Errors.VenueNotAllowed(plan.legs[i].venue);
            }
        }

        // ---- Machine transition ----
        if (action == ACTION_OPEN_VENUE) {
            _phase.beginP2();
        } else if (action == ACTION_HEDGE) {
            _phase.advance(PhaseMachine.P2_HEDGING);
        } else {
            _phase.advance(PhaseMachine.P2_CLOSING);
        }

        // ---- Run legs (pre/post assertion per leg) ----
        for (uint256 i = 0; i < plan.legs.length; ++i) {
            _executeLeg(plan.legs[i], i);
        }

        // ---- Signed carry invariant ----
        //   carry = R - B0
        //
        // Phase 2 borrows nothing and pays no flash fee, so the Phase 1 invariant
        // `R >= B0 + L + F + P` reduces to `R >= B0 + P` — i.e. `carry >= floor`
        // with `carry = R - B0`. The signed form is a strict generalisation: with
        // `minCarryRaw >= 0` it is exactly that, and with `minCarryRaw < 0` it
        // expresses a bounded-loss de-risking step, which Phase 1 cannot.
        //
        // `plan.deployedRaw` (D) is the principal. It is NOT subtracted here: the
        // principal is the executor's working float and is reused across positions,
        // so it is already inside B0. Subtracting it would double-count. D is
        // enforced separately — it must match the principal recorded at open
        // (`DeployedAmountMismatch`) and it drives the off-chain sizing.
        //
        // INTERFACE CONTRACT: a Phase 2 venue adapter MUST return the accounting
        // asset. A venue whose native position representation is a different token
        // (an LST, an LP share, a lending receipt) must convert it back to the
        // accounting asset before returning, so that this balance assertion is
        // meaningful. That is the adapter's job, not the executor's.
        uint256 postBalance = IERC20(plan.asset).balanceOf(address(this));
        int256 carry = RawMath.netCarryRaw(postBalance, preBalance, 0);
        if (carry < plan.minCarryRaw) {
            revert Errors.CarryBelowFloor(carry, plan.minCarryRaw);
        }

        // ---- Step-specific bookkeeping ----
        if (action == ACTION_OPEN_VENUE) {
            positionsOpened += 1;
            position = Position({
                positionId: positionsOpened,
                strategy: plan.strategy,
                asset: plan.asset,
                deployedRaw: plan.deployedRaw,
                openedAt: block.timestamp,
                realisedCarryRaw: 0,
                open: true
            });
            emit PositionOpened(positionsOpened, plan.strategy, plan.asset, plan.deployedRaw, block.timestamp);
        } else if (action == ACTION_HEDGE) {
            position.realisedCarryRaw += carry;
            emit PositionHedged(position.positionId, -carry, carry);
        } else {
            // ---- CLOSE: sweep the position's P&L, then settle to P2_IDLE ----
            int256 total = position.realisedCarryRaw + carry;
            position.realisedCarryRaw = total;
            position.open = false;
            positionsClosed += 1;
            _phase.settleP2();

            // Sweep the step's realised carry. At close this is the position's P&L
            // only — the returned principal is NOT swept, because it is not profit.
            // A negative carry leaves nothing to sweep; the loss is already
            // reflected in the reduced balance.
            uint256 sweep = carry > 0 ? uint256(carry) : 0;
            if (sweep > 0) {
                if (!IERC20(plan.asset).transfer(plan.profitRecipient, sweep)) {
                    revert Errors.NativeTransferFailed();
                }
            }
            emit PositionClosed(position.positionId, total, plan.profitRecipient, sweep);
        }

        return carry;
    }

    // ---------------------------------------------------------------------
    // Leg execution
    // ---------------------------------------------------------------------

    function _executeLeg(P2Leg calldata leg, uint256 index) internal {
        if (block.timestamp > leg.deadline) revert Errors.LegExpired(index);
        if (leg.amountIn == 0) revert Errors.SwapFailed(index);

        _forceApprove(leg.tokenIn, leg.venue, leg.amountIn);
        uint256 before = IERC20(leg.tokenOut).balanceOf(address(this));

        // A venue is an adapter implementing the same exact-input signature as V2.
        (bool ok, bytes memory ret) = leg.venue.call(
            abi.encodeWithSignature(
                "executeLeg(address,address,uint256,uint256)",
                leg.tokenIn,
                leg.tokenOut,
                leg.amountIn,
                leg.minAmountOut
            )
        );
        if (!ok) {
            // Bubble the venue's own revert so `_classify` can map it.
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }

        uint256 received = IERC20(leg.tokenOut).balanceOf(address(this)) - before;
        if (received < leg.minAmountOut) revert Errors.InsufficientOutput(index, received, leg.minAmountOut);

        _forceApprove(leg.tokenIn, leg.venue, 0);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _forceApprove(address token, address spender, uint256 amount) internal {
        IERC20 t = IERC20(token);
        if (amount != 0 && t.allowance(address(this), spender) != 0) {
            t.approve(spender, 0);
        }
        t.approve(spender, amount);
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert Errors.BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert Errors.BadSignature();
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert Errors.BadSignature();
        }
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert Errors.BadSignature();
        return signer;
    }

    function _trip(uint8 reason) internal {
        if (!breakerOpen) {
            breakerOpen = true;
            breakerReason = reason;
            breakerTrippedAt = block.timestamp;
            breakerTripCount += 1;
        }
    }

    function _classify(bytes memory reason) internal pure returns (uint8) {
        if (reason.length < 4) return BREAKER_HEALTH;
        bytes4 sel;
        assembly {
            sel := mload(add(reason, 0x20))
        }
        if (sel == Errors.CarryBelowFloor.selector) return BREAKER_INVARIANT;
        if (sel == Errors.InvariantViolated.selector) return BREAKER_INVARIANT;
        if (sel == Errors.BudgetExceeded.selector) return BREAKER_BUDGET;
        if (sel == Errors.BudgetUnavailable.selector) return BREAKER_BUDGET;
        if (sel == Errors.FlashFeeExceedsCap.selector) return BREAKER_FEE_CAP;
        if (sel == Errors.NetProfitBelowGate.selector) return BREAKER_PROFIT_GATE;
        if (sel == Errors.InsufficientOutput.selector) return BREAKER_SWAP;
        if (sel == Errors.SwapFailed.selector) return BREAKER_SWAP;
        if (sel == Errors.VenueNotAllowed.selector) return BREAKER_SWAP;
        if (sel == Errors.PhaseDisabled.selector) return BREAKER_PHASE_GATE;
        if (sel == Errors.StrategyNotAllowed.selector) return BREAKER_PHASE_GATE;
        if (sel == Errors.LegActionMismatch.selector) return BREAKER_PHASE_GATE;
        if (sel == Errors.Phase2Mismatch.selector) return BREAKER_PHASE_GATE;
        if (sel == Errors.PhaseMismatch.selector) return BREAKER_PHASE_GATE;
        if (sel == Errors.NoOpenPosition.selector) return BREAKER_POSITION;
        if (sel == Errors.PositionAlreadyOpen.selector) return BREAKER_POSITION;
        if (sel == Errors.DeployedAmountMismatch.selector) return BREAKER_POSITION;
        return BREAKER_HEALTH;
    }

    receive() external payable {}
}
