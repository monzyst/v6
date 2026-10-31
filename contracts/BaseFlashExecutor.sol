// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {V6HFAccess} from "./access/V6HFAccess.sol";
import {Errors} from "./libraries/Errors.sol";
import {PhaseMachine} from "./libraries/PhaseMachine.sol";
import {RawMath} from "./libraries/RawMath.sol";
import {IMorpho, IMorphoFlashLoanCallback} from "./interfaces/IMorpho.sol";
import {IERC20, ISwapRouterV2, ISwapRouterV3, IAerodromeRouter} from "./interfaces/ISwapRouter.sol";
import {IV6HFExecutor} from "./interfaces/IV6HFExecutor.sol";

/// @title BaseFlashExecutor
/// @notice V6-HF Phase-1 Base lane executor. Morpho-flash-funded, multi-DEX arbitrage
///         with a forward-only phase machine, EIP-712 plan authorisation, integer-only
///         accounting, pre/post-pull balance assertions, a native-gas budget reservation
///         system, and a sticky circuit breaker.
///
/// @dev    Trust model
///         ------------
///         * AUTHORIZER (cold): the only key that can sign an ExecutionPlan. Never
///           sends a transaction, never holds native gas.
///         * EXECUTOR (hot): the only key that can call `execute`. Cannot authorise a
///           plan and cannot withdraw. Compromise yields at most one already-signed plan.
///         * GUARDIAN: may trip the breaker. Cannot move funds.
///         * The contract holds no idle capital between cycles: profit is swept to
///           `plan.profitRecipient` inside the same transaction that earns it.
///
/// @dev    Execution frame
///         ---------------
///         execute()                       [outer frame: breaker, budget, replay guards]
///           └─ this.runCycle()            [self-call => atomic rollback boundary]
///                └─ morpho.flashLoan()
///                     └─ onMorphoFlashLoan()   [callback frame]
///                          ├─ assert delta == L exactly
///                          ├─ run legs (per-leg output assertions)
///                          ├─ assert R >= B0 + L + F + P
///                          └─ approve exactly L + F to Morpho
///           └─ assert post-pull R >= B0 + P
///           └─ sweep profit, settle budget
///
/// @dev    Why the cycle is a self-call and why failure is a SOFT failure
///         ------------------------------------------------------------
///         A revert anywhere in a transaction rolls back every storage write in that
///         transaction — including a breaker write. Therefore a breaker that must
///         survive a failed cycle cannot be written in the same frame that reverts.
///         `runCycle` is an external self-call, so its revert rolls back ONLY the
///         cycle (phase machine, approvals, swaps) while the outer frame stays alive
///         and persists `breakerOpen`. `execute` then returns `success = false`
///         instead of reverting, and emits `CycleFailed`.
///
///         CONSEQUENCE FOR INTEGRATORS: `execute` returning without revert does NOT
///         mean the cycle succeeded. The off-chain layer MUST check the `success`
///         return value (or the `CycleFailed` event) before treating a plan as filled.
///         This is enforced in packages/base-lane/src/submitter.ts.
contract BaseFlashExecutor is V6HFAccess, IMorphoFlashLoanCallback, IV6HFExecutor {
    using PhaseMachine for PhaseMachine.State;

    // ---------------------------------------------------------------------
    // EIP-712
    // ---------------------------------------------------------------------

    bytes32 public constant LEG_TYPEHASH = keccak256(
        "Leg(address router,address tokenIn,address tokenOut,uint256 amountIn,"
        "uint256 amountInBps,uint256 minAmountOut,uint24 poolFee,uint8 dexKind,"
        "bool stable,uint256 deadline)"
    );

    bytes32 public constant EXECUTION_PLAN_TYPEHASH = keccak256(
        "ExecutionPlan(address loanAsset,uint256 loanAmount,uint256 minNetProfitRaw,"
        "uint256 maxFlashFeeRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline,"
        "address profitRecipient,bytes32 legsHash)"
    );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("V6-HF");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint8 public constant DEX_V2 = 0;
    uint8 public constant DEX_V3 = 1;
    uint8 public constant DEX_AERODROME = 2;

    // Breaker reason codes — stable ABI for the off-chain supervisor.
    uint8 public constant BREAKER_INVARIANT = 1;
    uint8 public constant BREAKER_BUDGET = 2;
    uint8 public constant BREAKER_FEE_CAP = 3;
    uint8 public constant BREAKER_PROFIT_GATE = 4;
    uint8 public constant BREAKER_SWAP = 5;
    uint8 public constant BREAKER_MANUAL = 6;
    uint8 public constant BREAKER_HEALTH = 7;

    // ---------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------

    IMorpho public immutable morpho;
    address public immutable nativeToken;

    /// @notice Absolute ceiling on the flash fee in raw loan-asset units. A plan's
    ///         `maxFlashFeeRaw` can only tighten this, never loosen it.
    uint256 public immutable absoluteMaxFlashFeeRaw;

    // ---------------------------------------------------------------------
    // Budget state
    // ---------------------------------------------------------------------

    /// @notice Native wei available for gas across all cycles in the current epoch.
    uint256 public gasBudgetPoolWei;
    /// @notice Native wei reserved by in-flight cycles (always <= pool).
    uint256 public gasReservedWei;

    // ---------------------------------------------------------------------
    // Mutable state
    // ---------------------------------------------------------------------

    PhaseMachine.State private _phase;

    mapping(bytes32 => bool) public planConsumed;
    mapping(uint256 => bool) public nonceConsumed;

    bool public breakerOpen;
    uint8 public breakerReason;
    uint256 public breakerTrippedAt;
    uint256 public breakerTripCount;

    uint256 public cyclesSucceeded;
    uint256 public cyclesFailed;
    uint256 public cumulativeNetProfitRaw;

    mapping(address => bool) public routerAllowed;
    mapping(address => bool) public loanAssetAllowed;

    /// @dev Outer-frame reentrancy latch, independent of the phase machine.
    uint256 private _outerLock = 1;

    /// @dev Transient cycle context, overwritten at the start of every cycle.
    bytes32 private _activePlanHash;
    uint256 private _activePreBalance;
    uint256 private _activeLoanAmount;
    uint256 private _activeProfitFloor;
    uint256 private _activeFeeCap;
    address private _activeProfitRecipient;
    uint256 private _lastFeeRaw;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event CycleFailed(bytes32 indexed planHash, uint8 indexed reason, bytes revertData);
    event BreakerReset(address indexed by);
    event BudgetFunded(uint256 amountWei, uint256 newPoolWei);
    event BudgetSettled(uint256 reservedWei, uint256 actualWei, uint256 refundedWei);
    event RouterSet(address indexed router, bool allowed);
    event LoanAssetSet(address indexed asset, bool allowed);
    event ProfitSwept(address indexed token, address indexed to, uint256 amountRaw);
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

    /// @dev Callback may only be entered by Morpho, and only while a cycle is live.
    modifier onlyMorphoCallback() {
        if (msg.sender != address(morpho)) revert Errors.CallbackNotFromMorpho();
        if (_phase.phase != PhaseMachine.FLASH_ACTIVE) revert Errors.CallbackOutsideFlash();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert Errors.NotSelf();
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
        address morpho_,
        address nativeToken_,
        uint256 absoluteMaxFlashFeeRaw_
    ) V6HFAccess(owner_, authorizer_, executor_, guardian_) {
        if (morpho_ == address(0) || nativeToken_ == address(0)) revert Errors.SignerIsolationViolation();
        morpho = IMorpho(morpho_);
        nativeToken = nativeToken_;
        absoluteMaxFlashFeeRaw = absoluteMaxFlashFeeRaw_;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setRouter(address router, bool allowed) external onlyOwner {
        routerAllowed[router] = allowed;
        emit RouterSet(router, allowed);
    }

    function setLoanAsset(address asset, bool allowed) external onlyOwner {
        loanAssetAllowed[asset] = allowed;
        emit LoanAssetSet(asset, allowed);
    }

    /// @notice Refills the native gas budget pool.
    /// @dev    Payable: the owner sends `msg.value` and the pool is credited by
    ///         exactly that amount. `amountWei` is accepted for ABI stability and
    ///         MUST equal `msg.value` — a mismatch is rejected rather than
    ///         silently crediting a pool the contract cannot actually pay from.
    function fundGasBudget(uint256 amountWei) external payable onlyOwner {
        if (amountWei != msg.value) revert Errors.BudgetMismatch(amountWei, msg.value);
        gasBudgetPoolWei += amountWei;
        emit BudgetFunded(amountWei, gasBudgetPoolWei);
    }

    /// @notice Guardian or owner may trip the breaker manually (venue incident, etc.).
    function tripBreaker(uint8 reason) external {
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && msg.sender != _ownerAddr()) revert Errors.NotGuardian();
        _trip(reason);
    }

    /// @notice Owner-only reset. Deliberately manual: an automatic reset would defeat
    ///         the purpose of a sticky breaker.
    function resetBreaker() external onlyOwner {
        if (!breakerOpen) revert Errors.BreakerNotOpen();
        breakerOpen = false;
        breakerReason = 0;
        _phase.forceReset();
        emit BreakerReset(msg.sender);
    }

    /// @notice Recovers tokens. Owner only, never mid-cycle.
    function rescue(address token, address to, uint256 amountRaw) external onlyOwner {
        if (_phase.phase != PhaseMachine.IDLE) revert Errors.PhaseMismatch(PhaseMachine.IDLE, _phase.phase);
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

    function cycleId() external view returns (uint256) {
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

    /// @notice Canonical EIP-712 digest. The off-chain signer MUST reproduce this
    ///         construction byte-for-byte; the executor recomputes and compares.
    function hashPlan(ExecutionPlan calldata plan) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTION_PLAN_TYPEHASH,
                plan.loanAsset,
                plan.loanAmount,
                plan.minNetProfitRaw,
                plan.maxFlashFeeRaw,
                plan.gasBudgetWei,
                plan.nonce,
                plan.deadline,
                plan.profitRecipient,
                _hashLegs(plan.legs)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashLegs(Leg[] calldata legs) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](legs.length);
        for (uint256 i = 0; i < legs.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(
                    LEG_TYPEHASH,
                    legs[i].router,
                    legs[i].tokenIn,
                    legs[i].tokenOut,
                    legs[i].amountIn,
                    legs[i].amountInBps,
                    legs[i].minAmountOut,
                    legs[i].poolFee,
                    legs[i].dexKind,
                    legs[i].stable,
                    legs[i].deadline
                )
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    /// @notice Off-chain pre-flight mirror of the on-chain gate. Pure, no state.
    function previewGate(uint256 postBalance, uint256 preBalance, uint256 principal, uint256 fee, uint256 profitFloor)
        external
        pure
        returns (bool invariantOk, uint256 netProfit)
    {
        invariantOk = RawMath.invariantHolds(postBalance, preBalance, principal, fee, profitFloor);
        netProfit = RawMath.netProfitRaw(postBalance, preBalance, principal, fee);
    }

    // ---------------------------------------------------------------------
    // Execution entrypoint
    // ---------------------------------------------------------------------

    /// @inheritdoc IV6HFExecutor
    /// @dev Returns `(success, netProfitRaw)`. See the contract-level note: a
    ///      non-reverting return with `success == false` means the cycle failed and
    ///      the breaker is now open. Callers MUST check `success`.
    function execute(ExecutionPlan calldata plan, bytes calldata authorizerSignature)
        external
        onlyRole(EXECUTOR_ROLE)
        nonReentrantOuter
        breakerClosed
        returns (bool success, uint256 netProfitRaw)
    {
        // ---- 1. Static plan validation (cheap, before any external call) ----
        if (plan.loanAmount == 0) revert Errors.ZeroLoanAmount();
        if (plan.legs.length == 0) revert Errors.EmptyLegs();
        if (block.timestamp > plan.deadline) revert Errors.PlanExpired(plan.deadline, block.timestamp);
        if (!loanAssetAllowed[plan.loanAsset]) revert Errors.LoanAssetNotAllowed(plan.loanAsset);
        if (plan.profitRecipient == address(0)) revert Errors.SignerIsolationViolation();

        // ---- 2. Authorisation: EIP-712 signature from the isolated AUTHORIZER key ----
        bytes32 planHash = hashPlan(plan);
        if (planConsumed[planHash]) revert Errors.PlanAlreadyUsed(plan.nonce);
        if (nonceConsumed[plan.nonce]) revert Errors.PlanAlreadyUsed(plan.nonce);
        if (_recover(planHash, authorizerSignature) != _authorizerAddr()) revert Errors.BadSignature();

        // ---- 3. Fee-risk budget reservation (native gas) ----
        //     Reserve the declared ceiling BEFORE any external call so two concurrent
        //     cycles can never spend the same wei.
        uint256 available = gasBudgetPoolWei - gasReservedWei;
        if (plan.gasBudgetWei > available) revert Errors.BudgetUnavailable(plan.gasBudgetWei, available);
        gasReservedWei += plan.gasBudgetWei;

        uint256 gasAtStart = gasleft();
        uint256 reserved = plan.gasBudgetWei;

        // ---- 4. Run the cycle behind a self-call so the breaker survives a revert ----
        try this.runCycle(plan, planHash) returns (uint256 profit) {
            success = true;
            netProfitRaw = profit;
        } catch (bytes memory reason) {
            gasReservedWei -= reserved;
            cyclesFailed += 1;
            _trip(_classify(reason));
            emit CycleFailed(planHash, breakerReason, reason);
            return (false, 0);
        }

        // ---- 5. Settle the budget against actual gas ----
        uint256 gasUsed = gasAtStart - gasleft();
        uint256 actualWei = gasUsed * tx.gasprice;
        gasReservedWei -= reserved;

        if (actualWei > reserved) {
            // The plan under-declared its gas. The swaps already happened, so we
            // cannot unwind them; absorb the overrun from the pool and trip the
            // breaker so nothing else runs until a human reviews.
            gasBudgetPoolWei -= reserved;
            _trip(BREAKER_BUDGET);
            emit CycleFailed(planHash, BREAKER_BUDGET, "");
            return (false, netProfitRaw);
        }

        gasBudgetPoolWei -= actualWei;
        emit BudgetSettled(reserved, actualWei, reserved - actualWei);

        // ---- 6. Bookkeeping ----
        planConsumed[planHash] = true;
        nonceConsumed[plan.nonce] = true;
        cyclesSucceeded += 1;
        cumulativeNetProfitRaw += netProfitRaw;

        emit Executed(planHash, plan.loanAmount, _lastFeeRaw, netProfitRaw, netProfitRaw, actualWei);
    }

    /// @notice The cycle body. External so `execute` can wrap it in try/catch.
    ///         Only callable by the contract itself.
    function runCycle(ExecutionPlan calldata plan, bytes32 planHash) external onlySelf returns (uint256) {
        // B0 is recorded BEFORE the pull. It anchors every later assertion.
        uint256 preBalance = IERC20(plan.loanAsset).balanceOf(address(this));

        _phase.begin();
        _activePlanHash = planHash;
        _activePreBalance = preBalance;
        _activeLoanAmount = plan.loanAmount;
        _activeProfitFloor = plan.minNetProfitRaw;
        _activeFeeCap =
            plan.maxFlashFeeRaw < absoluteMaxFlashFeeRaw ? plan.maxFlashFeeRaw : absoluteMaxFlashFeeRaw;
        _activeProfitRecipient = plan.profitRecipient;

        morpho.flashLoan(plan.loanAsset, plan.loanAmount, abi.encode(plan));

        // ---- Post-pull assertion (outer side of the callback) ----
        // After Morpho has pulled L + F back, the executor must still hold >= B0 + P.
        uint256 postBalance = IERC20(plan.loanAsset).balanceOf(address(this));
        uint256 required = preBalance + plan.minNetProfitRaw;
        if (postBalance < required) revert Errors.InvariantViolated(postBalance, required);

        // ---- Sweep profit: the contract never accumulates idle capital ----
        uint256 profit = postBalance - preBalance;
        if (profit > 0) {
            if (!IERC20(plan.loanAsset).transfer(plan.profitRecipient, profit)) {
                revert Errors.NativeTransferFailed();
            }
            emit ProfitSwept(plan.loanAsset, plan.profitRecipient, profit);
        }

        _phase.settle();
        return profit;
    }

    // ---------------------------------------------------------------------
    // Morpho callback
    // ---------------------------------------------------------------------

    /// @inheritdoc IMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external onlyMorphoCallback {
        ExecutionPlan memory plan = abi.decode(data, (ExecutionPlan));

        // ---- Pre-pull assertion: the delta must be EXACTLY the principal ----
        // Catches fee-on-transfer / rebasing / malicious loan assets before any swap.
        uint256 balanceNow = IERC20(plan.loanAsset).balanceOf(address(this));
        if (balanceNow != _activePreBalance + assets) {
            revert Errors.InvariantViolated(balanceNow, _activePreBalance + assets);
        }
        if (assets != _activeLoanAmount) revert Errors.InvariantViolated(assets, _activeLoanAmount);

        // ---- Fee determination and cap enforcement ----
        uint256 fee = RawMath.flashFeeRaw(assets, morpho.fee());
        if (fee > _activeFeeCap) revert Errors.FlashFeeExceedsCap(fee, _activeFeeCap);
        _lastFeeRaw = fee;

        // ---- FLASH_ACTIVE -> SWAPPING ----
        _phase.advance(PhaseMachine.SWAPPING);

        for (uint256 i = 0; i < plan.legs.length; ++i) {
            _executeLeg(plan.legs[i], i);
        }

        // ---- SWAPPING -> REPAYING ----
        _phase.advance(PhaseMachine.REPAYING);

        // ---- Core invariant: R >= B0 + L + F + P ----
        uint256 postSwap = IERC20(plan.loanAsset).balanceOf(address(this));
        uint256 required = _activePreBalance + assets + fee + _activeProfitFloor;
        if (postSwap < required) revert Errors.InvariantViolated(postSwap, required);

        // ---- Approve exactly L + F to Morpho, never more ----
        _forceApprove(plan.loanAsset, address(morpho), assets + fee);
    }

    // ---------------------------------------------------------------------
    // Leg execution
    // ---------------------------------------------------------------------

    function _executeLeg(Leg memory leg, uint256 index) internal {
        if (!routerAllowed[leg.router]) revert Errors.SwapFailed(index);
        if (block.timestamp > leg.deadline) revert Errors.LegExpired(index);

        uint256 amountIn = leg.amountIn;
        if (amountIn == 0) {
            amountIn = RawMath.bps(IERC20(leg.tokenIn).balanceOf(address(this)), leg.amountInBps);
        }
        if (amountIn == 0) revert Errors.SwapFailed(index);

        _forceApprove(leg.tokenIn, leg.router, amountIn);

        uint256 before = IERC20(leg.tokenOut).balanceOf(address(this));

        if (leg.dexKind == DEX_V2) {
            address[] memory path = new address[](2);
            path[0] = leg.tokenIn;
            path[1] = leg.tokenOut;
            ISwapRouterV2(leg.router).swapExactTokensForTokens(
                amountIn, leg.minAmountOut, path, address(this), leg.deadline
            );
        } else if (leg.dexKind == DEX_V3) {
            ISwapRouterV3(leg.router).exactInputSingle(
                ISwapRouterV3.ExactInputSingleParams({
                    tokenIn: leg.tokenIn,
                    tokenOut: leg.tokenOut,
                    fee: leg.poolFee,
                    recipient: address(this),
                    deadline: leg.deadline,
                    amountIn: amountIn,
                    amountOutMinimum: leg.minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        } else if (leg.dexKind == DEX_AERODROME) {
            IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
            routes[0] = IAerodromeRouter.Route({
                from: leg.tokenIn,
                to: leg.tokenOut,
                stable: leg.stable,
                factory: address(0)
            });
            IAerodromeRouter(leg.router).swapExactTokensForTokens(
                amountIn, leg.minAmountOut, routes, address(this), leg.deadline
            );
        } else {
            revert Errors.UnsupportedDexKind(leg.dexKind);
        }

        // ---- Per-leg output assertion, independent of the router's own check ----
        uint256 received = IERC20(leg.tokenOut).balanceOf(address(this)) - before;
        if (received < leg.minAmountOut) revert Errors.InsufficientOutput(index, received, leg.minAmountOut);

        // Clear residual allowance so no router can pull later.
        _forceApprove(leg.tokenIn, leg.router, 0);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _forceApprove(address token, address spender, uint256 amount) internal {
        IERC20 t = IERC20(token);
        // USDT-style tokens require a zero-first approval.
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
        // Reject malleable signatures (EIP-2).
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
            emit BreakerTripped(reason, _activePlanHash, 0, 0);
        }
    }

    /// @dev Maps a bubbled revert payload onto a breaker reason code.
    function _classify(bytes memory reason) internal pure returns (uint8) {
        if (reason.length < 4) return BREAKER_HEALTH;
        bytes4 sel;
        assembly {
            sel := mload(add(reason, 0x20))
        }
        if (sel == Errors.InvariantViolated.selector) return BREAKER_INVARIANT;
        if (sel == Errors.BudgetExceeded.selector) return BREAKER_BUDGET;
        if (sel == Errors.FlashFeeExceedsCap.selector) return BREAKER_FEE_CAP;
        if (sel == Errors.NetProfitBelowGate.selector) return BREAKER_PROFIT_GATE;
        if (sel == Errors.InsufficientOutput.selector) return BREAKER_SWAP;
        if (sel == Errors.SwapFailed.selector) return BREAKER_SWAP;
        return BREAKER_HEALTH;
    }

    receive() external payable {}
}
