// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Errors} from "./Errors.sol";

/// @title RawMath
/// @notice Every economic quantity in V6-HF is an unsigned integer in the base units
///         of a specific token. This library is the single place where those integers
///         are combined, so each formula is auditable in isolation.
///
///         Unit conventions (enforced by convention + off-chain validation):
///           - `*Raw`      : token base units (10^decimals per whole token)
///           - `*Wei`      : native gas token base units (10^18 per native on Base)
///           - `*Bps`      : basis points, 1e4 = 100%
///           - `WAD`       : 1e18 fixed point, used only for Morpho's fee ratio
library RawMath {
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant WAD = 1e18;

    /// @notice Gross surplus in loan-asset raw units.
    /// @dev    S = R - B0 - L, where
    ///           R  = post-cycle balance of loanAsset held by the executor
    ///           B0 = pre-pull balance (recorded before flashLoan was called)
    ///           L  = loan principal in raw units
    ///         Reverts on underflow rather than wrapping.
    function grossSurplusRaw(uint256 postBalance, uint256 preBalance, uint256 principal)
        internal
        pure
        returns (uint256)
    {
        if (postBalance < preBalance + principal) revert Errors.SurplusUnderflow();
        unchecked {
            return postBalance - preBalance - principal;
        }
    }

    /// @notice Net profit in loan-asset raw units.
    /// @dev    N = R - B0 - L - F, where F is the flash fee actually charged.
    function netProfitRaw(uint256 postBalance, uint256 preBalance, uint256 principal, uint256 fee)
        internal
        pure
        returns (uint256)
    {
        uint256 gross = grossSurplusRaw(postBalance, preBalance, principal);
        if (gross < fee) revert Errors.SurplusUnderflow();
        unchecked {
            return gross - fee;
        }
    }

    /// @notice Flash fee in raw units for a given principal and Morpho WAD fee ratio.
    /// @dev    F = ceil(L * feeWad / 1e18). Morpho rounds in its own favour; we mirror
    ///         the ceiling so our accounting is never optimistic by 1 wei.
    function flashFeeRaw(uint256 principal, uint256 feeWad) internal pure returns (uint256) {
        uint256 product = principal * feeWad;
        return (product + WAD - 1) / WAD;
    }

    /// @notice Converts a raw profit amount into native wei at an integer price.
    /// @dev    nativeWei = floor(raw * 1e18 / rawPerNative), where `rawPerNative` is the
    ///         number of raw token units equal to 1 whole native token, expressed in the
    ///         SAME 1e18 scale. Flooring is deliberate: gas-credit estimates must never
    ///         overstate the native value of a profit.
    function nativeFromRaw(uint256 rawAmount, uint256 rawPerNative) internal pure returns (uint256) {
        if (rawPerNative == 0) revert Errors.SurplusUnderflow();
        return (rawAmount * WAD) / rawPerNative;
    }

    /// @notice bps of an amount, floored.
    function bps(uint256 amount, uint256 bpsValue) internal pure returns (uint256) {
        return (amount * bpsValue) / BPS_DENOMINATOR;
    }

    /// @notice The submission gate. Returns true iff the plan may be broadcast.
    /// @dev    Gate: N >= P, where P = plan.minNetProfitRaw. Strictly integer.
    function meetsGate(uint256 netProfit, uint256 minNetProfitRaw) internal pure returns (bool) {
        return netProfit >= minNetProfitRaw;
    }

    /// @notice The on-chain safety invariant: R >= B0 + L + F + P.
    /// @dev    Expressed as a single comparison so it can never be partially applied.
    function invariantHolds(uint256 postBalance, uint256 preBalance, uint256 principal, uint256 fee, uint256 profitFloor)
        internal
        pure
        returns (bool)
    {
        return postBalance >= preBalance + principal + fee + profitFloor;
    }

    // ---------------------------------------------------------------------
    // Phase 2 — SIGNED carry
    // ---------------------------------------------------------------------

    /// @notice Phase 2 signed carry in accounting-asset raw units.
    /// @dev    carry = R - B0 - D, evaluated in int256.
    ///
    ///         Why signed: Phase 2 deploys capital into a position that is unwound
    ///         over several transactions, so a de-risking close can legitimately
    ///         realise a loss. Phase 1's unsigned `invariantHolds` cannot express
    ///         "lose at most X", which is exactly what an emergency exit needs.
    ///
    ///         With `floor >= 0` the constraint `carry >= floor` is algebraically
    ///         identical to Phase 1's `R >= B0 + D + floor`.
    ///
    ///         Overflow: `postBalance` and `preBalance` are uint256 balances. The
    ///         difference is computed after an explicit ordering test and widened to
    ///         int256, so no uint256->int256 cast can truncate: both operands are
    ///         bounded by total token supply, far below 2^255.
    function netCarryRaw(uint256 postBalance, uint256 preBalance, uint256 deployedRaw)
        internal
        pure
        returns (int256)
    {
        // surplus = R - B0, as a signed value, without ever computing a negative uint.
        int256 surplus;
        if (postBalance >= preBalance) {
            surplus = int256(postBalance - preBalance);
        } else {
            surplus = -int256(preBalance - postBalance);
        }
        // D is capped at supply, so the cast is safe; checked arithmetic below
        // reverts (rather than wrapping) on any overflow.
        return surplus - int256(deployedRaw);
    }

    /// @notice True iff the signed carry satisfies the plan's floor.
    /// @dev    `carry >= floor`. Single comparison, never partially applied.
    function carryMeetsFloor(int256 carryRaw, int256 floorRaw) internal pure returns (bool) {
        return carryRaw >= floorRaw;
    }
}
