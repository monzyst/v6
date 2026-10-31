// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IMorpho (Morpho Blue, flash-loan surface only)
/// @notice Minimal, ABI-exact surface of Morpho Blue used by V6-HF.
/// @dev Morpho Blue is deployed on Base at 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb.
///      The flash loan is uncollateralised: Morpho transfers `assets` to the receiver,
///      calls `onMorphoFlashLoan`, then pulls back `assets + fee` via transferFrom.
interface IMorpho {
    /// @notice Returns the current fee (in WAD, 1e18 = 100%) charged on flash loans.
    function fee() external view returns (uint256);

    /// @notice Executes a flash loan of `assets` units of `token` to `receiver`.
    /// @param token    The loan asset.
    /// @param assets   Raw amount (token base units) to borrow.
    /// @param data     Opaque payload forwarded verbatim to the callback.
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// @title IMorphoFlashLoanCallback
/// @notice Callback interface the receiver must implement.
interface IMorphoFlashLoanCallback {
    /// @param assets Raw amount lent (token base units).
    /// @param data   Payload supplied by the caller of `flashLoan`.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
