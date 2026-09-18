// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @notice EIP-712 typed data for the mesh: residency claims, task results, and session-key
///         delegations. Wallets sign these structs (eth_signTypedData_v4); a browser tab normally
///         holds an ephemeral session key that the bonded wallet delegates once (Delegation), so
///         per-epoch claims and per-task results never prompt the wallet.
library PorwEIP712 {
    string constant NAME = "PoRW Mesh";
    string constant VERSION = "1";
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant CLAIM_TYPEHASH = keccak256("Claim(bytes32 schemeDigest,bytes32 mepId,bytes32 modelId,bytes32 partialsRoot,uint64 coverageBytes,bytes32 challenge)");
    bytes32 constant RESULT_TYPEHASH = keccak256("Result(bytes32 taskId,bytes32 execDigest,bytes32 execRoot)");
    bytes32 constant DELEGATION_TYPEHASH = keccak256("Delegation(address instance,address session,uint64 expiry)");

    function domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), block.chainid, verifyingContract));
    }
    function digest(bytes32 ds, bytes32 structHash) internal pure returns (bytes32) { return keccak256(abi.encodePacked("\x19\x01", ds, structHash)); }
    function claimStructHash(bytes32 schemeDigest, bytes32 mepId, bytes32 modelId, bytes32 partialsRoot, uint64 coverageBytes, bytes32 challenge) internal pure returns (bytes32) {
        return keccak256(abi.encode(CLAIM_TYPEHASH, schemeDigest, mepId, modelId, partialsRoot, coverageBytes, challenge));
    }
    function resultStructHash(bytes32 taskId, bytes32 execDigest, bytes32 execRoot) internal pure returns (bytes32) { return keccak256(abi.encode(RESULT_TYPEHASH, taskId, execDigest, execRoot)); }
    function delegationStructHash(address instance, address session, uint64 expiry) internal pure returns (bytes32) { return keccak256(abi.encode(DELEGATION_TYPEHASH, instance, session, expiry)); }
    /// @dev r||s||v (v = 27/28 or 0/1); returns address(0) on malformed input
    function recover(bytes32 h, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset, 32)) v := byte(0, calldataload(add(sig.offset, 64))) }
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0); // low-s only
        return ecrecover(h, v, r, s);
    }
}
