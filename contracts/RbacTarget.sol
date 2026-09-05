// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * RbacTarget — the per-target RBAC baseline (OpenZeppelin AccessControl):
 * every target keeps its own user–role table, so a shared qualification
 * must be granted and revoked once per target. Used for RQ2 gas/operation
 * counts against the externalized (mint/burn) scheme.
 */
contract RbacTarget is AccessControl {
    bytes32 public constant BENCH_ROLE = keccak256("BENCH_ROLE");
    uint256 public actions;

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function act() external onlyRole(BENCH_ROLE) {
        actions++;
    }
}
