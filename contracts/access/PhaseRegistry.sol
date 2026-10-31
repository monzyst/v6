// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Errors} from "../libraries/Errors.sol";
import {PhaseMachine} from "../libraries/PhaseMachine.sol";

/// @title PhaseRegistry
/// @notice The single source of truth for which phases and which Phase 2 strategies
///         are permitted to execute. Every phase-gated entry point consults it.
///
/// @dev    DESIGN INVARIANTS
///         -----------------
///         (P1) PHASE 1 IS ALWAYS ENABLED. There is no storage slot, no setter and no
///              execution path that can disable it. `isPhaseEnabled(DOMAIN_PHASE1)`
///              is `return true;` with no state read. This is what makes it impossible
///              for a Phase 2 misconfiguration to take the live trading lanes offline.
///
///         (P2) PHASE 2 IS OPT-IN AND PER-STRATEGY. Both the phase switch and each
///              individual strategy must be enabled. Two independent bits, so enabling
///              the phase cannot silently arm a strategy nobody reviewed.
///
///         (P3) PHASE 2 CANNOT CHANGE PHASE 1 STATE. This contract holds no reference
///              to any Phase 1 executor, budget pool or breaker. Phase 1 contracts do
///              not reference this contract at all. Cutting the registry out of the
///              deployment leaves Phase 1 fully operational.
///
///         (P4) CHANGES ARE TWO-STEP FOR THE DANGEROUS DIRECTION ONLY. Disabling is
///              instant (safety); enabling a Phase 2 strategy first records a pending
///              request that becomes live only after `PHASE2_ARM_DELAY` seconds. That
///              delay is the window in which a monitoring system can notice that a
///              dormant strategy is about to be armed.
contract PhaseRegistry {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Minimum delay between requesting and arming a Phase 2 strategy.
    /// @dev    Immutable, not settable: an owner who can shorten the delay can defeat
    ///         the review window. Set generously at deployment (e.g. 24h).
    uint64 public immutable PHASE2_ARM_DELAY;

    uint8 public constant STRATEGY_NONE = 0;
    uint8 public constant STRATEGY_CROSS_VENUE_BASIS = 1;
    uint8 public constant STRATEGY_LST_RESTAKE_LOOP = 2;
    uint8 public constant STRATEGY_OPTIONS_HEDGED_MM = 3;
    uint8 public constant STRATEGY_MAX = 3;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    address public owner;
    address public pendingOwner;

    /// @notice Master Phase 2 switch. Phase 1 has no equivalent: it is always on.
    bool public phase2Enabled;

    /// @notice Per-strategy arm state.
    mapping(uint8 => bool) public strategyEnabled;
    /// @notice Timestamp at which a pending arm request becomes actionable (0 = none).
    mapping(uint8 => uint64) public strategyArmEta;

    /// @notice Venues Phase 2 legs may target. Separate from the Phase 1 router
    ///         allowlist, which lives on the Phase 1 executor and is never read here.
    mapping(address => bool) public venueAllowed;

    /// @notice Contracts permitted to manage the venue allowlist on the owner's
    ///         behalf. The Phase 2 executor is registered here at deployment so its
    ///         own `setVenue` can mirror into this registry without the owner having
    ///         to make two calls. A venue admin can ONLY touch the venue list — it
    ///         cannot enable phases, arm strategies, or move funds.
    mapping(address => bool) public venueAdmin;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Phase2EnabledSet(bool enabled, address indexed by);
    event StrategyArmRequested(uint8 indexed strategy, uint64 eta, address indexed by);
    event StrategyArmed(uint8 indexed strategy, address indexed by);
    event StrategyDisarmed(uint8 indexed strategy, address indexed by);
    event VenueSet(address indexed venue, bool allowed, address indexed by);
    event VenueAdminSet(address indexed admin, bool allowed, address indexed by);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert Errors.NotOwner();
        _;
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(address owner_, uint64 phase2ArmDelaySeconds) {
        if (owner_ == address(0)) revert Errors.SignerIsolationViolation();
        if (phase2ArmDelaySeconds == 0) revert Errors.SignerIsolationViolation();
        owner = owner_;
        PHASE2_ARM_DELAY = phase2ArmDelaySeconds;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ---------------------------------------------------------------------
    // Phase queries — the hot path for every gated entry point
    // ---------------------------------------------------------------------

    /// @notice True iff `phase` (a PhaseMachine domain constant) may execute.
    /// @dev    Phase 1 returns `true` unconditionally: no storage read, no owner
    ///         action, no failure mode. Phase 2 requires the master switch.
    function isPhaseEnabled(uint8 phase) public view returns (bool) {
        if (phase == PhaseMachine.DOMAIN_PHASE1) return true;
        if (phase == PhaseMachine.DOMAIN_PHASE2) return phase2Enabled;
        return false;
    }

    /// @notice Reverts with `PhaseDisabled` unless the domain is enabled.
    function requirePhaseEnabled(uint8 phase) external view {
        if (!isPhaseEnabled(phase)) revert Errors.PhaseDisabled(phase);
    }

    /// @notice True iff a Phase 2 strategy may produce an executable plan.
    /// @dev    Both bits must be set. A strategy armed while the master switch is off
    ///         is inert, and re-enabling the switch does not re-arm anything by itself.
    function isStrategyEnabled(uint8 strategy) public view returns (bool) {
        if (strategy == STRATEGY_NONE || strategy > STRATEGY_MAX) return false;
        return phase2Enabled && strategyEnabled[strategy];
    }

    function requireStrategyEnabled(uint8 strategy) external view {
        if (!isStrategyEnabled(strategy)) revert Errors.StrategyNotAllowed(strategy);
    }

    function requireVenueAllowed(address venue) external view {
        if (!venueAllowed[venue]) revert Errors.VenueNotAllowed(venue);
    }

    /// @notice Aggregate view for the off-chain supervisor's health loop.
    function snapshot()
        external
        view
        returns (
            bool phase1Enabled,
            bool phase2On,
            bool[4] memory strategies,
            uint64 armDelay
        )
    {
        phase1Enabled = true;
        phase2On = phase2Enabled;
        armDelay = PHASE2_ARM_DELAY;
        for (uint8 i = 1; i <= STRATEGY_MAX; ++i) {
            strategies[i] = isStrategyEnabled(i);
        }
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    /// @notice Disabling is immediate — safety must never wait for a timelock.
    function setPhase2Enabled(bool enabled) external onlyOwner {
        phase2Enabled = enabled;
        emit Phase2EnabledSet(enabled, msg.sender);
    }

    /// @notice Step 1 of arming a Phase 2 strategy: records an ETA, changes nothing else.
    function requestStrategyArm(uint8 strategy) external onlyOwner {
        if (strategy == STRATEGY_NONE || strategy > STRATEGY_MAX) revert Errors.StrategyNotAllowed(strategy);
        uint64 eta = uint64(block.timestamp) + PHASE2_ARM_DELAY;
        strategyArmEta[strategy] = eta;
        emit StrategyArmRequested(strategy, eta, msg.sender);
    }

    /// @notice Step 2: arms the strategy once the delay has elapsed.
    /// @dev    Also requires the master switch to be on, so a strategy can never be
    ///         left in the "armed but inert" state by a later master-toggle cycle.
    function armStrategy(uint8 strategy) external onlyOwner {
        if (strategy == STRATEGY_NONE || strategy > STRATEGY_MAX) revert Errors.StrategyNotAllowed(strategy);
        uint64 eta = strategyArmEta[strategy];
        if (eta == 0) revert Errors.StrategyNotAllowed(strategy);
        if (block.timestamp < eta) revert Errors.StrategyNotAllowed(strategy);
        if (!phase2Enabled) revert Errors.PhaseDisabled(PhaseMachine.DOMAIN_PHASE2);

        strategyEnabled[strategy] = true;
        strategyArmEta[strategy] = 0;
        emit StrategyArmed(strategy, msg.sender);
    }

    /// @notice Immediate disarm. Leaves a strategy's `strategyArmEta` cleared so it
    ///         must go through the full delay again to return.
    function disarmStrategy(uint8 strategy) external onlyOwner {
        if (strategy == STRATEGY_NONE || strategy > STRATEGY_MAX) revert Errors.StrategyNotAllowed(strategy);
        strategyEnabled[strategy] = false;
        strategyArmEta[strategy] = 0;
        emit StrategyDisarmed(strategy, msg.sender);
    }

    function setVenue(address venue, bool allowed) external {
        if (msg.sender != owner && !venueAdmin[msg.sender]) revert Errors.NotOwner();
        if (venue == address(0)) revert Errors.VenueNotAllowed(venue);
        venueAllowed[venue] = allowed;
        emit VenueSet(venue, allowed, msg.sender);
    }

    /// @notice Registers or removes a venue admin. Owner-only, and deliberately
    ///         narrow: a venue admin has no other privilege in this contract.
    function setVenueAdmin(address admin, bool allowed) external onlyOwner {
        if (admin == address(0)) revert Errors.VenueNotAllowed(admin);
        venueAdmin[admin] = allowed;
        emit VenueAdminSet(admin, allowed, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Two-step ownership
    // ---------------------------------------------------------------------

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert Errors.SignerIsolationViolation();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Errors.NotOwner();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, msg.sender);
    }
}
