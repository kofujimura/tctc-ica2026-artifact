// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/manager/AccessManaged.sol";

/**
 * ManagedTarget — a target under the shared-registry baseline. It holds no
 * membership of its own: `restricted` asks the single authority named at
 * deployment whether the caller may invoke this selector.
 */
contract ManagedTarget is AccessManaged {
    uint256 public actions;

    constructor(address initialAuthority) AccessManaged(initialAuthority) {}

    function act() external restricted {
        actions++;
    }
}
