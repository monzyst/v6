// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "../interfaces/ISwapRouter.sol";

/// @notice Test-only Phase 2 venue adapter. Implements the exact
///         `executeLeg(tokenIn, tokenOut, amountIn, minAmountOut)` surface that
///         `Phase2Executor._executeLeg` calls, with a configurable integer rate.
///
/// @dev    A real Phase 2 venue adapter (Aave/Morpho supply, Ethena basis, an LST
///         stake/unstake router, a perp hedge venue) implements the same four
///         arguments and returns nothing the executor trusts: the executor re-reads
///         its own output-token balance and asserts the delta itself. That is why the
///         mock can be a constant-rate stub without weakening any assertion.
contract MockPhase2Venue {
    uint256 public rateNumerator;
    uint256 public rateDenominator;

    /// @dev When true the venue "loses" capital at this rate instead of earning it.
    ///      Used to drive negative-carry paths in tests.
    bool public lossMode;

    error LegReverted(string reason);

    constructor(uint256 num, uint256 den) {
        require(den != 0, "den");
        rateNumerator = num;
        rateDenominator = den;
    }

    function setRate(uint256 num, uint256 den) external {
        require(den != 0, "den");
        rateNumerator = num;
        rateDenominator = den;
    }

    function setLossMode(bool on) external {
        lossMode = on;
    }

    function executeLeg(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 out)
    {
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull");
        out = (amountIn * rateNumerator) / rateDenominator;
        if (out < minAmountOut) revert LegReverted("slippage");
        require(IERC20(tokenOut).transfer(msg.sender, out), "push");
    }
}
