// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Phase2Actions
/// @notice Per-leg action tags for the Phase 2 lifecycle. A separate library rather
///         than constants inside `IV6HFPhase2`, because Solidity forbids state
///         variables (including constants) in an `interface`.
/// @dev    The tags are the second half of the phase lock: the entry point proves the
///         MACHINE is in the right phase, and these tags prove every LEG agrees with
///         that phase. A plan authored for `open` cannot be replayed as a `close`
///         because each leg carries its action inside the signed EIP-712 struct.
library Phase2Actions {
    uint8 internal constant OPEN_VENUE = 1;
    uint8 internal constant HEDGE = 2;
    uint8 internal constant CLOSE_VENUE = 3;
}

/// @title IV6HFPhase2
/// @notice The versioned boundary between the Phase 2 off-chain strategies and the
///         Phase 2 on-chain executor. Deliberately a SEPARATE interface from
///         `IV6HFExecutor`: no struct, no function and no event is shared, so an
///         ABI change on one phase cannot ripple into the other.
///
/// @dev    PHASE 1 vs PHASE 2 — the structural difference
///         ---------------------------------------------
///         Phase 1 is ATOMIC: borrow, swap, repay, settle — one transaction, one
///         `ExecutionPlan`, unsigned profit invariant `R >= B0 + L + F + P`.
///
///         Phase 2 is a MULTI-TRANSACTION POSITION LIFECYCLE:
///             open (P2_IDLE -> P2_POSITION_OPEN)
///             hedge (P2_POSITION_OPEN <-> P2_HEDGING)
///             close (P2_POSITION_OPEN|P2_HEDGING -> P2_CLOSING -> P2_IDLE)
///         Each step is its own signed `Phase2Plan`. Capital is deployed rather than
///         borrowed, so the invariant is a SIGNED carry:
///             carry = R - B0 - D          (int256, may be negative)
///             require(carry >= plan.minCarryRaw)
///         With `minCarryRaw >= 0` this is algebraically identical to the Phase 1
///         invariant `R >= B0 + D + P`. Allowing `minCarryRaw < 0` is what makes a
///         bounded-loss emergency exit expressible — a Phase 1 plan can never
///         authorise a loss, and that is precisely why Phase 2 needs its own type.
interface IV6HFPhase2 {
    /// @notice One Phase 2 leg. Every leg is a `venue` call that moves `tokenIn`
    ///         into the venue and expects `tokenOut` back.
    /// @dev    `action` must equal the entry point's action; see `Phase2Actions`.
    struct P2Leg {
        address venue;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint8 action; // must equal the entry point's action
        uint256 deadline;
    }

    /// @notice A signed Phase 2 lifecycle step.
    struct Phase2Plan {
        uint8 strategy; // PhaseRegistry strategy id
        address asset; // accounting asset (the asset carry is measured in)
        uint256 deployedRaw; // D — principal committed (open) / to be returned (close)
        int256 minCarryRaw; // signed carry floor; realised carry must be >= this
        uint256 maxCostRaw; // fee + slippage ceiling, asset raw units
        uint256 gasBudgetWei; // native budget reservation
        uint256 nonce;
        uint256 deadline;
        address profitRecipient;
        P2Leg[] legs;
    }

    event Phase2Executed(
        bytes32 indexed planHash,
        uint8 indexed strategy,
        uint8 indexed action,
        uint256 deployedRaw,
        int256 realisedCarryRaw,
        uint256 gasSpentWei
    );

    event Phase2Failed(bytes32 indexed planHash, uint8 indexed reason, bytes revertData);

    event PositionOpened(
        uint256 indexed positionId,
        uint8 indexed strategy,
        address indexed asset,
        uint256 deployedRaw,
        uint256 openedAt
    );

    event PositionHedged(uint256 indexed positionId, int256 hedgeCostRaw, int256 carryDeltaRaw);

    event PositionClosed(
        uint256 indexed positionId,
        int256 realisedCarryRaw,
        address indexed profitRecipient,
        uint256 sweptRaw
    );

    /// @notice Opens a position. Requires P2_IDLE.
    function openPosition(Phase2Plan calldata plan, bytes calldata authorizerSignature)
        external
        returns (bool success, int256 realisedCarryRaw);

    /// @notice Re-hedges an open position. Requires P2_POSITION_OPEN.
    function hedgePosition(Phase2Plan calldata plan, bytes calldata authorizerSignature)
        external
        returns (bool success, int256 realisedCarryRaw);

    /// @notice Closes the position. Requires P2_POSITION_OPEN or P2_HEDGING.
    function closePosition(Phase2Plan calldata plan, bytes calldata authorizerSignature)
        external
        returns (bool success, int256 realisedCarryRaw);
}
