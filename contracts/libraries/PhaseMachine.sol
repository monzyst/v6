// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Errors} from "./Errors.sol";

/// @title PhaseMachine
/// @notice A strict, forward-only state machine that makes out-of-order and reentrant
///         execution structurally impossible. Hosts BOTH phase state spaces:
///
///         PHASE 1 (atomic, single-transaction, flash-funded)
///           IDLE(0) ─begin()▶ FLASH_ACTIVE(1) ─▶ SWAPPING(2) ─▶ REPAYING(3) ─settle()▶ IDLE
///
///         PHASE 2 (multi-transaction position lifecycle)
///           P2_IDLE(10) ─beginP2()▶ P2_POSITION_OPEN(11) ─▶ P2_HEDGING(12)
///                       ─▶ P2_CLOSING(13) ─settleP2()▶ P2_IDLE(10)
///
/// @dev    WHY THE TWO SPACES ARE DISJOINT AND WHY THAT MATTERS
///         ---------------------------------------------------
///         Every Phase 1 state is in [0,3]. Every Phase 2 state is in [10,13].
///         `isLegal(from, to)` therefore cannot return true for any (Phase 1, Phase 2)
///         or (Phase 2, Phase 1) pair — the disjointness is arithmetic, not policy.
///         A Phase 2 amount can never drive a Phase 1 transition and vice versa,
///         because no such edge exists in the table. `domainOf()` makes the same
///         fact inspectable at runtime for the off-chain supervisor.
///
///         The `State` struct is deliberately UNCHANGED from the Phase 1 release:
///         a fresh `State` is `{phase: 0, cycleId: 0, entered: false}`, which is
///         exactly Phase 1's IDLE. Phase 1 executors need no initialisation and
///         their behaviour is byte-identical. A Phase 2 executor instead calls
///         `initPhase2()` in its constructor, which moves the fresh state from
///         IDLE(0) to P2_IDLE(10) — a one-way, constructor-only transition that
///         `isLegal` expressly forbids at runtime.
library PhaseMachine {
    // ---------------------------------------------------------------------
    // Phase 1 state space — FROZEN. Values are ABI (event payloads, views).
    // ---------------------------------------------------------------------
    uint8 internal constant IDLE = 0;
    uint8 internal constant FLASH_ACTIVE = 1;
    uint8 internal constant SWAPPING = 2;
    uint8 internal constant REPAYING = 3;

    // ---------------------------------------------------------------------
    // Phase 2 state space — disjoint by construction (>= 10).
    // ---------------------------------------------------------------------
    uint8 internal constant P2_IDLE = 10;
    uint8 internal constant P2_POSITION_OPEN = 11;
    uint8 internal constant P2_HEDGING = 12;
    uint8 internal constant P2_CLOSING = 13;

    uint8 internal constant DOMAIN_NONE = 0;
    uint8 internal constant DOMAIN_PHASE1 = 1;
    uint8 internal constant DOMAIN_PHASE2 = 2;

    struct State {
        uint8 phase;
        uint256 cycleId;
        bool entered; // reentrancy latch, independent of phase
    }

    /// @notice Domain of a phase value. Used by the supervisor and by tests to
    ///         assert that a stored phase belongs to the expected space.
    function domainOf(uint8 phase) internal pure returns (uint8) {
        if (phase <= REPAYING) return DOMAIN_PHASE1;
        if (phase >= P2_IDLE && phase <= P2_CLOSING) return DOMAIN_PHASE2;
        return DOMAIN_NONE;
    }

    /// @dev _LEGAL[from][to] == true iff the transition is permitted.
    ///      Phase 1 edges are exactly those of the Phase 1 release; Phase 2 edges
    ///      are their own connected component. No edge crosses domains.
    function isLegal(uint8 from, uint8 to) internal pure returns (bool) {
        // ---- Phase 1 component (unchanged) ----
        if (from == IDLE && to == FLASH_ACTIVE) return true;
        if (from == FLASH_ACTIVE && to == SWAPPING) return true;
        if (from == SWAPPING && to == REPAYING) return true;
        if (from == REPAYING && to == IDLE) return true;

        // ---- Phase 2 component ----
        if (from == P2_IDLE && to == P2_POSITION_OPEN) return true;
        if (from == P2_POSITION_OPEN && to == P2_HEDGING) return true;
        if (from == P2_HEDGING && to == P2_POSITION_OPEN) return true; // re-hedge
        if (from == P2_POSITION_OPEN && to == P2_CLOSING) return true;
        if (from == P2_HEDGING && to == P2_CLOSING) return true;
        if (from == P2_CLOSING && to == P2_IDLE) return true;

        return false;
    }

    // ---------------------------------------------------------------------
    // Phase 1 transitions (unchanged semantics)
    // ---------------------------------------------------------------------

    function begin(State storage s) internal returns (uint256 cycleId) {
        if (s.entered) revert Errors.ReentrancyBlocked();
        if (s.phase != IDLE) revert Errors.PhaseMismatch(IDLE, s.phase);
        s.entered = true;
        s.cycleId += 1;
        s.phase = FLASH_ACTIVE;
        return s.cycleId;
    }

    function settle(State storage s) internal {
        if (s.phase != REPAYING) revert Errors.PhaseMismatch(REPAYING, s.phase);
        s.phase = IDLE;
        s.entered = false;
    }

    // ---------------------------------------------------------------------
    // Phase 2 transitions
    // ---------------------------------------------------------------------

    /// @notice One-way constructor bootstrap: IDLE(0) -> P2_IDLE(10).
    /// @dev    Reverts if called on already-initialised state. Because `isLegal`
    ///         contains no IDLE->P2_IDLE edge, there is no runtime path that can
    ///         perform this move — only construction can.
    function initPhase2(State storage s) internal {
        if (s.phase != IDLE) revert Errors.PhaseMismatch(IDLE, s.phase);
        s.phase = P2_IDLE;
    }

    function beginP2(State storage s) internal returns (uint256 cycleId) {
        if (s.entered) revert Errors.ReentrancyBlocked();
        if (s.phase != P2_IDLE) revert Errors.PhaseMismatch(P2_IDLE, s.phase);
        s.entered = true;
        s.cycleId += 1;
        s.phase = P2_POSITION_OPEN;
        return s.cycleId;
    }

    function settleP2(State storage s) internal {
        if (s.phase != P2_CLOSING) revert Errors.PhaseMismatch(P2_CLOSING, s.phase);
        s.phase = P2_IDLE;
        s.entered = false;
    }

    // ---------------------------------------------------------------------
    // Shared helpers
    // ---------------------------------------------------------------------

    function advance(State storage s, uint8 to) internal {
        if (!isLegal(s.phase, to)) revert Errors.PhaseMismatch(to, s.phase);
        s.phase = to;
    }

    function requirePhase(State storage s, uint8 expected) internal view {
        if (s.phase != expected) revert Errors.PhaseMismatch(expected, s.phase);
    }

    /// @dev Reverts unless the state is in the Phase 1 domain and specifically IDLE.
    function requirePhase1Idle(State storage s) internal view {
        requirePhase(s, IDLE);
    }

    /// @dev Reverts unless the state is in the Phase 2 domain (any P2 phase).
    function requirePhase2Domain(State storage s) internal view {
        if (domainOf(s.phase) != DOMAIN_PHASE2) revert Errors.PhaseMismatch(P2_IDLE, s.phase);
    }

    /// @dev Hard reset used only by the emergency path. Never callable mid-callback.
    ///      Resets to the IDLE of whichever domain the state currently occupies, so
    ///      a Phase 2 emergency reset cannot hand a Phase 2 state back to Phase 1.
    function forceReset(State storage s) internal {
        s.phase = domainOf(s.phase) == DOMAIN_PHASE2 ? P2_IDLE : IDLE;
        s.entered = false;
    }
}
