// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "../interfaces/ISwapRouter.sol";

/// @notice Test-only constant-rate V2 router. `rateNumerator/rateDenominator`
///         defines tokenOut per tokenIn. Used to drive deterministic P&L in tests.
contract MockRouterV2 {
    uint256 public rateNumerator;
    uint256 public rateDenominator;

    constructor(uint256 num, uint256 den) {
        rateNumerator = num;
        rateDenominator = den;
    }

    function setRate(uint256 num, uint256 den) external {
        rateNumerator = num;
        rateDenominator = den;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length == 2, "path");
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "pull");
        uint256 out = (amountIn * rateNumerator) / rateDenominator;
        require(out >= amountOutMin, "slippage");
        require(IERC20(path[1]).transfer(to, out), "push");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}
