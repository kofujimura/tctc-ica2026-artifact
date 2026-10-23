// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./ERC7303.sol";

/**
 * BindableTarget — an ERC-7303 target administered by its own organization.
 * Its owner names one local role and binds it, after deployment, to control
 * tokens that other organizations issue. Nobody but the owner can change the
 * bindings, and the owner has no authority over the tokens themselves.
 * Used for the issuer–target separation run (bench/separation.mjs) and the
 * executed operation counts (bench/admin-ops.mjs).
 */
contract BindableTarget is ERC7303, Ownable {
    bytes32 public immutable ROLE;
    uint256 public actions;

    constructor(string memory roleName) Ownable(msg.sender) {
        ROLE = keccak256(bytes(roleName));
    }

    function bindERC1155(address controlToken, uint256 typeId) external onlyOwner {
        _grantRoleByERC1155(ROLE, controlToken, typeId);
    }

    function bindERC721(address controlToken) external onlyOwner {
        _grantRoleByERC721(ROLE, controlToken);
    }

    function act() external onlyHasToken(ROLE, msg.sender) {
        actions++;
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IERC7303).interfaceId || interfaceId == 0x01ffc9a7;
    }
}
