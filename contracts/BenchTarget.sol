// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "./ERC7303.sol";

/**
 * BenchTarget — an ERC-7303 target whose single role BENCH_ROLE is bound to
 * K ERC-1155 control-token types supplied at deployment. Used to measure
 * admission latency as a function of the number of bindings (1, 2, 4, …).
 * `act()` is the protected on-chain action for gas measurements.
 */
contract BenchTarget is ERC721, ERC7303 {
    bytes32 public constant BENCH_ROLE = keccak256("BENCH_ROLE");
    uint256 public actions;

    constructor(address[] memory controlTokens, uint256[] memory typeIds)
        ERC721("Bench Target", "BENCH")
    {
        require(controlTokens.length == typeIds.length, "length mismatch");
        for (uint256 i = 0; i < controlTokens.length; i++) {
            _grantRoleByERC1155(BENCH_ROLE, controlTokens[i], typeIds[i]);
        }
    }

    function act() external onlyHasToken(BENCH_ROLE, msg.sender) {
        actions++;
    }

    function supportsInterface(bytes4 interfaceId)
        public view override returns (bool)
    {
        return interfaceId == type(IERC7303).interfaceId || super.supportsInterface(interfaceId);
    }
}
