// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "./ERC7303.sol";

/**
 * RecordTarget — the on-chain enforcement point of the agent case study.
 * record() stores a hash and is gated by BENCH_ROLE, bound to the same
 * credential collection as every other target in the study.
 */
contract RecordTarget is ERC7303 {
    bytes32 public constant BENCH_ROLE = keccak256("BENCH_ROLE");
    event Recorded(address indexed by, bytes32 hash);
    mapping(address => uint256) public count;

    constructor(address controlToken, uint256 typeId) {
        _grantRoleByERC1155(BENCH_ROLE, controlToken, typeId);
    }

    function record(bytes32 hash) external onlyHasToken(BENCH_ROLE, msg.sender) {
        count[msg.sender]++;
        emit Recorded(msg.sender, hash);
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IERC7303).interfaceId || interfaceId == 0x01ffc9a7;
    }
}
