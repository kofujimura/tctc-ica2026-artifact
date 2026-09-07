// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/manager/AccessManager.sol";

/**
 * BenchAccessManager — the shared-registry baseline for RQ2.
 *
 * OpenZeppelin's AccessManager keeps role membership for many targets in one
 * contract and maps each target's function selectors to a role, so a single
 * grant or revoke reaches every target that names this manager as its
 * authority. It is the strongest of the conventional baselines: like the
 * externalized scheme it needs only O(A+N) state. The subclass exists so
 * that Hardhat emits an artifact under contracts/.
 */
contract BenchAccessManager is AccessManager {
    constructor(address initialAdmin) AccessManager(initialAdmin) {}
}
