// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "../interfaces/ISwapRouter.sol";
import {IMorphoFlashLoanCallback} from "../interfaces/IMorpho.sol";

/// @notice Test-only Morpho Blue stand-in with identical flash-loan semantics:
///         transfer `assets` to the receiver, call the callback, then pull back
///         `assets + fee` via transferFrom. Reverts if repayment is short.
contract MockMorpho {
    uint256 public fee; // WAD

    constructor(uint256 feeWad) {
        fee = feeWad;
    }

    function setFee(uint256 feeWad) external {
        fee = feeWad;
    }

    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        uint256 feeAmount = (assets * fee + 1e18 - 1) / 1e18;
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));

        require(IERC20(token).transfer(msg.sender, assets), "transfer out");
        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);

        require(IERC20(token).transferFrom(msg.sender, address(this), assets + feeAmount), "repay");
        require(IERC20(token).balanceOf(address(this)) >= balanceBefore + feeAmount, "fee not paid");
    }
}
