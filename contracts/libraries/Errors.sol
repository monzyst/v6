// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Central error registry. Every revert path in V6-HF maps to exactly one code,
///         so the off-chain supervisor can classify failures without string matching.
library Errors {
    // ---- access ----
    error NotOwner();
    error NotExecutor();
    error NotAuthorizer();
    error NotGuardian();
    error NotSelf();
    error SignerIsolationViolation();

    // ---- phase machine ----
    error PhaseMismatch(uint8 expected, uint8 actual);
    error ReentrancyBlocked();
    error CallbackNotFromMorpho();
    error CallbackOutsideFlash();

    // ---- plan / signature ----
    error PlanExpired(uint256 deadline, uint256 nowTs);
    error PlanAlreadyUsed(uint256 nonce);
    error BadSignature();
    error PlanHashMismatch();
    error EmptyLegs();
    error LegExpired(uint256 index);
    error UnsupportedDexKind(uint8 kind);
    error LoanAssetNotAllowed(address asset);

    // ---- economics ----
    error FlashFeeExceedsCap(uint256 fee, uint256 cap);
    error InvariantViolated(uint256 postBalance, uint256 required);
    error NetProfitBelowGate(uint256 netProfit, uint256 gate);
    error SurplusUnderflow();
    error ZeroLoanAmount();

    // ---- budget / breaker ----
    error BudgetExceeded(uint256 spent, uint256 reserved);
    error BudgetMismatch(uint256 declared, uint256 sent);
    error BudgetUnavailable(uint256 requested, uint256 available);
    error BreakerOpen(uint8 reason);
    error BreakerAlreadyOpen();
    error BreakerNotOpen();

    // ---- swap ----
    error SwapFailed(uint256 index);
    error InsufficientOutput(uint256 index, uint256 got, uint256 min);
    error NativeTransferFailed();

    // ---- phase gating (Phase 2) ----
    /// @notice The requested phase is not enabled in the PhaseRegistry.
    error PhaseDisabled(uint8 phase);
    /// @notice A leg whose `action` does not match the entry point it was submitted to.
    /// @dev    This is the per-leg half of the phase lock: the entry point checks the
    ///         machine, and this checks that every individual leg agrees with it.
    error LegActionMismatch(uint256 index, uint8 expected, uint8 actual);
    /// @notice A plan names a strategy the registry has not enabled.
    error StrategyNotAllowed(uint8 strategy);
    /// @notice A leg names a venue that is not allowlisted.
    error VenueNotAllowed(address venue);
    /// @notice A position-touching call arrived with no open position recorded.
    error NoOpenPosition();
    /// @notice A position was already open when `openPosition` was called.
    error PositionAlreadyOpen();
    /// @notice `plan.deployedRaw` disagrees with the principal recorded at open.
    /// @dev    Prevents a signed close plan from under-declaring the principal that
    ///         must be returned, which would make the invariant R >= B0 + D + P easier
    ///         to satisfy than the position actually is.
    error DeployedAmountMismatch(uint256 planned, uint256 recorded);
    /// @notice Realised carry came in below the strategy's declared floor.
    error CarryBelowFloor(int256 realised, int256 floor);
    /// @notice A Phase 2 state transition was attempted from the wrong Phase 2 phase.
    error Phase2Mismatch(uint8 expected, uint8 actual);
}
