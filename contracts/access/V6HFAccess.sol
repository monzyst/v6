// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Errors} from "../libraries/Errors.sol";

/// @title V6HFAccess
/// @notice Four-role privilege separation with a hard, enforced signer-isolation rule.
///
///         OWNER      : governance. Grants/revokes roles, sets the authorizer, withdraws.
///         AUTHORIZER : the ONLY key that may sign an ExecutionPlan (EIP-712). Cold.
///         EXECUTOR   : the ONLY key that may broadcast `execute`. Hot, low-value.
///         GUARDIAN   : may pause and trip the breaker. Cannot move funds.
///
///         Isolation invariant (enforced on every mutation):
///             authorizer ∉ {owner} ∪ executors
///         so a compromised hot submitter key can never also authorise a pull.
abstract contract V6HFAccess {
    bytes32 public constant OWNER_ROLE = keccak256("V6HF_OWNER");
    bytes32 public constant AUTHORIZER_ROLE = keccak256("V6HF_AUTHORIZER");
    bytes32 public constant EXECUTOR_ROLE = keccak256("V6HF_EXECUTOR");
    bytes32 public constant GUARDIAN_ROLE = keccak256("V6HF_GUARDIAN");

    mapping(bytes32 => mapping(address => bool)) private _roles;
    mapping(address => bool) private _isExecutor;
    address private _authorizer;
    address private _owner;

    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event AuthorizerChanged(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert Errors.NotOwner();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert Errors.NotOwner();
        _;
    }

    modifier onlyAuthorizer() {
        if (msg.sender != _authorizer) revert Errors.NotAuthorizer();
        _;
    }

    constructor(address owner_, address authorizer_, address executor_, address guardian_) {
        if (owner_ == address(0) || authorizer_ == address(0) || executor_ == address(0)) {
            revert Errors.SignerIsolationViolation();
        }
        if (authorizer_ == owner_ || authorizer_ == executor_) revert Errors.SignerIsolationViolation();
        _owner = owner_;
        _authorizer = authorizer_;
        _roles[OWNER_ROLE][owner_] = true;
        _roles[AUTHORIZER_ROLE][authorizer_] = true;
        _roles[EXECUTOR_ROLE][executor_] = true;
        _isExecutor[executor_] = true;
        if (guardian_ != address(0)) _roles[GUARDIAN_ROLE][guardian_] = true;
        emit OwnershipTransferred(address(0), owner_);
        emit AuthorizerChanged(address(0), authorizer_);
        emit RoleGranted(EXECUTOR_ROLE, executor_);
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function authorizer() external view returns (address) {
        return _authorizer;
    }

    /// @dev Internal accessors so derived contracts never pay an external call.
    function _ownerAddr() internal view returns (address) {
        return _owner;
    }

    function _authorizerAddr() internal view returns (address) {
        return _authorizer;
    }

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function isExecutor(address account) external view returns (bool) {
        return _isExecutor[account];
    }

    /// @notice Grants a role, refusing any grant that would break signer isolation.
    function grantRole(bytes32 role, address account) external onlyOwner {
        if (account == address(0)) revert Errors.SignerIsolationViolation();
        if (role == AUTHORIZER_ROLE) revert Errors.SignerIsolationViolation(); // use setAuthorizer
        if (role == EXECUTOR_ROLE) {
            if (account == _authorizer) revert Errors.SignerIsolationViolation();
            _isExecutor[account] = true;
        }
        _roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyOwner {
        if (role == AUTHORIZER_ROLE) revert Errors.SignerIsolationViolation(); // use setAuthorizer
        if (role == EXECUTOR_ROLE) _isExecutor[account] = false;
        _roles[role][account] = false;
        emit RoleRevoked(role, account);
    }

    /// @notice Rotates the authorizing key. Rejects any key that is also an executor
    ///         or the owner, preserving the isolation invariant across rotation.
    function setAuthorizer(address next) external onlyOwner {
        if (next == address(0) || next == _owner || _isExecutor[next]) {
            revert Errors.SignerIsolationViolation();
        }
        address prev = _authorizer;
        _roles[AUTHORIZER_ROLE][prev] = false;
        _roles[AUTHORIZER_ROLE][next] = true;
        _authorizer = next;
        emit AuthorizerChanged(prev, next);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0) || next == _authorizer) revert Errors.SignerIsolationViolation();
        address prev = _owner;
        _roles[OWNER_ROLE][prev] = false;
        _roles[OWNER_ROLE][next] = true;
        _owner = next;
        emit OwnershipTransferred(prev, next);
    }
}
