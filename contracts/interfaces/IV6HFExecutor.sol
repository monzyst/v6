// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IV6HFExecutor
/// @notice The single, versioned boundary between the off-chain execution layer
///         (Base lane) and the on-chain executor. Every field is integer-typed;
///         no floating point ever crosses this boundary.
interface IV6HFExecutor {
    /// @notice A single swap leg. `amountIn == 0` means "use amountInBps of the
    ///         current balance of tokenIn held by the executor".
    struct Leg {
        address router;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountInBps; // 1e4 scale; ignored when amountIn != 0
        uint256 minAmountOut;
        uint24 poolFee; // v3 only
        uint8 dexKind; // 0 = v2, 1 = v3, 2 = aerodrome
        bool stable; // aerodrome only
        uint256 deadline;
    }

    /// @notice The full, signed execution plan.
    struct ExecutionPlan {
        address loanAsset;
        uint256 loanAmount;
        uint256 minNetProfitRaw; // P in the invariant
        uint256 maxFlashFeeRaw; // F cap
        uint256 gasBudgetWei; // native budget reservation
        uint256 nonce;
        uint256 deadline;
        address profitRecipient;
        Leg[] legs;
    }

    /// @notice Emitted on every successful execution.
    event Executed(
        bytes32 indexed planHash,
        uint256 loanAmount,
        uint256 flashFeeRaw,
        uint256 grossSurplusRaw,
        uint256 netProfitRaw,
        uint256 gasSpentWei
    );

    /// @notice Emitted whenever the circuit breaker trips.
    event BreakerTripped(uint8 indexed reason, bytes32 indexed planHash, uint256 observed, uint256 required);

    /// @notice Executes a signed plan. Callable only by an EXECUTOR_ROLE key.
    /// @dev    Returns (success, netProfitRaw). A non-reverting call with
    ///         success == false means the cycle failed and the breaker is open.
    function execute(ExecutionPlan calldata plan, bytes calldata authorizerSignature)
        external
        returns (bool success, uint256 netProfitRaw);
}
