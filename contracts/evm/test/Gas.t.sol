// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Blake3} from "../src/Blake3.sol";
import {PorwVerifier} from "../src/PorwVerifier.sol";

/// Gas measurements for the EVM feasibility gate, at realistic tree depths:
/// a 70 GB model = ~17M 4 KiB tiles => weights-tree depth 25; a large
/// per-slot coverage set => partials depth up to 25 (21 used here for a 2M
/// tile coverage). Numbers are logged per case; run with `forge test -vv
/// --match-contract GasBench`.
contract GasBench is Test {
    PorwVerifier v;

    uint64 constant TILE_IDX = 3;
    uint64 constant MODEL_N_LEAVES = 17_000_000;
    uint64 constant COVERAGE_N_LEAVES = 2_000_000;
    uint32 constant SLOT_SEED = 1970174283;
    bytes32 constant CHALLENGE = 0x0909090909090909090909090909090909090909090909090909090909090909;
    bytes32 constant DEVICE = 0x0303030303030303030303030303030303030303030303030303030303030303;

    bytes tile;
    uint32 trueS;
    bytes32[] wProof; // depth 25 (17M-tile model)
    bytes32[] pProof; // depth 21 (2M-tile coverage)
    bytes32 modelRoot;
    bytes32 partialsRoot;

    function tileBytes(uint256 tileIdx) internal pure returns (bytes memory out) {
        out = new bytes(4096);
        unchecked {
            for (uint256 j = 0; j < 4096; j++) {
                uint64 x = uint64((tileIdx * 4096 + j) * 2654435761);
                out[j] = bytes1(uint8((x >> 7) & 0xFF));
            }
        }
    }

    function foldRoot(bytes32 leaf, bytes32[] memory proof, uint256 index) internal pure returns (bytes32 acc) {
        acc = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            acc = index % 2 == 0 ? Blake3.hash(bytes.concat(acc, proof[i])) : Blake3.hash(bytes.concat(proof[i], acc));
            index /= 2;
        }
    }

    function setUp() public {
        v = new PorwVerifier();
        tile = tileBytes(TILE_IDX);
        trueS = v.sketchTile(SLOT_SEED, TILE_IDX, tile);

        wProof = new bytes32[](25);
        for (uint256 i = 0; i < 25; i++) {
            wProof[i] = keccak256(abi.encode("w", i));
        }
        pProof = new bytes32[](21);
        for (uint256 i = 0; i < 21; i++) {
            pProof[i] = keccak256(abi.encode("p", i));
        }
        // Roots chosen so every check passes and the full path executes:
        // the committed value is trueS+1, so the verdict is Fraud.
        partialsRoot = foldRoot(v.partialsLeaf(TILE_IDX, trueS + 1), pProof, 1);
        modelRoot = foldRoot(v.weightsLeaf(TILE_IDX, tile), wProof, TILE_IDX);
    }

    function test_gas_sketch_tile() public view {
        uint256 g0 = gasleft();
        v.sketchTile(SLOT_SEED, TILE_IDX, tile);
        console2.log("sketchTile (4096B, 1024 words):", g0 - gasleft());
    }

    function test_gas_blake3_single_block() public view {
        uint256 g0 = gasleft();
        v.partialsLeaf(TILE_IDX, trueS);
        console2.log("partialsLeaf (12B blake3, 1 compression):", g0 - gasleft());
    }

    function test_gas_blake3_tile_hash() public view {
        uint256 g0 = gasleft();
        v.weightsLeaf(TILE_IDX, tile);
        console2.log("weightsLeaf (4104B blake3, ~69 compressions):", g0 - gasleft());
    }

    function test_gas_merkle_blake3_depth25() public view {
        bytes32 leaf = keccak256("leaf");
        uint256 g0 = gasleft();
        v.merkleVerify(modelRoot, leaf, TILE_IDX, wProof);
        console2.log("merkleVerify blake3 depth-25:", g0 - gasleft());
    }

    function test_gas_merkle_keccak_depth25() public view {
        bytes32 leaf = keccak256("leaf");
        uint256 g0 = gasleft();
        v.merkleVerifyKeccak(modelRoot, leaf, TILE_IDX, wProof);
        console2.log("merkleVerify keccak depth-25:", g0 - gasleft());
    }

    function test_gas_opening_committed_depth21() public view {
        uint256 g0 = gasleft();
        v.verifyOpeningCommitted(partialsRoot, 1 << 21, TILE_IDX, trueS + 1, 1, pProof);
        console2.log("verifyOpeningCommitted depth-21:", g0 - gasleft());
    }

    function fraudProofCalldata() internal view returns (bytes memory) {
        return abi.encodeCall(
            PorwVerifier.verifyTileFraudProof,
            (
                partialsRoot,
                COVERAGE_N_LEAVES,
                modelRoot,
                modelRoot,
                MODEL_N_LEAVES,
                CHALLENGE,
                DEVICE,
                TILE_IDX,
                trueS + 1,
                uint64(1),
                pProof,
                tile,
                wProof
            )
        );
    }

    function wordAt(bytes memory data, uint256 offset) internal pure returns (bytes32 word) {
        require(offset + 32 <= data.length, "word out of bounds");
        assembly ("memory-safe") {
            word := mload(add(add(data, 0x20), offset))
        }
    }

    function calldataComposition(bytes memory data)
        internal
        pure
        returns (uint256 zeroBytes, uint256 nonZeroBytes, uint256 calldataGas)
    {
        for (uint256 i = 0; i < data.length; i++) {
            if (data[i] == 0) zeroBytes++;
            else nonZeroBytes++;
        }
        calldataGas = zeroBytes * 4 + nonZeroBytes * 16;
    }

    function test_gas_ecrecover_baseline() public {
        bytes32 h = keccak256("m");
        // Any valid signature; use a fixed known-good vector via vm.sign.
        (address a, uint256 pk) = makeAddrAndKey("worker");
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, h);
        uint256 g0 = gasleft();
        address rec = ecrecover(h, vv, r, s);
        console2.log("ecrecover (device signature check):", g0 - gasleft());
        assertEq(rec, a);
    }

    function test_exact_fraud_proof_calldata_and_total_gas() public view {
        bytes memory callData = fraudProofCalldata();

        // 13 ABI head words, plus one length word for each dynamic value and
        // their padded bodies. The leading four bytes are the selector.
        uint256 expectedLength =
            4 + 13 * 32 + (1 + pProof.length) * 32 + (1 + tile.length / 32) * 32 + (1 + wProof.length) * 32;
        assertEq(callData.length, expectedLength);
        assertEq(bytes4(wordAt(callData, 0)), PorwVerifier.verifyTileFraudProof.selector);

        uint256 partialsOffset = uint256(wordAt(callData, 4 + 10 * 32));
        uint256 tileOffset = uint256(wordAt(callData, 4 + 11 * 32));
        uint256 weightsOffset = uint256(wordAt(callData, 4 + 12 * 32));
        assertEq(uint256(wordAt(callData, 4 + partialsOffset)), pProof.length);
        assertEq(uint256(wordAt(callData, 4 + tileOffset)), tile.length);
        assertEq(uint256(wordAt(callData, 4 + weightsOffset)), wProof.length);

        (uint256 zeroBytes, uint256 nonZeroBytes, uint256 intrinsicCalldataGas) = calldataComposition(callData);
        assertEq(zeroBytes + nonZeroBytes, callData.length);

        uint256 g0 = gasleft();
        (bool ok, bytes memory result) = address(v).staticcall(callData);
        uint256 executionGas = g0 - gasleft();
        assertTrue(ok);
        uint8 verdict = abi.decode(result, (uint8));
        assertEq(verdict, 0);
        uint256 totalGas = 21_000 + intrinsicCalldataGas + executionGas;

        console2.log("fraud-proof calldata bytes:", callData.length);
        console2.log("fraud-proof calldata zero bytes:", zeroBytes);
        console2.log("fraud-proof calldata non-zero bytes:", nonZeroBytes);
        console2.log("fraud-proof intrinsic calldata gas (EIP-2028):", intrinsicCalldataGas);
        console2.log("fraud-proof execution gas:", executionGas);
        console2.log("fraud-proof total gas (21000 + calldata + execution):", totalGas);
    }
}
