// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PorwVerifier} from "../src/PorwVerifier.sol";
import {PoRWBenchFixture} from "../src/bench/PoRWBenchFixture.sol";

/// Gas measurements for the EVM feasibility gate, at realistic tree depths:
/// a 70 GB model = ~17M 4 KiB tiles => weights-tree depth 25; a large
/// per-slot coverage set => partials depth up to 25 (21 used here for a 2M
/// tile coverage). Numbers are logged per case; run with `forge test -vv
/// --match-contract GasBench`.
contract GasBench is Test, PoRWBenchFixture {
    PorwVerifier v;

    bytes tile;
    uint32 trueS;
    bytes32[] wProof; // depth 25 (17M-tile model)
    bytes32[] pProof; // depth 21 (2M-tile coverage)
    bytes32 modelRoot;
    bytes32 partialsRoot;

    function setUp() public {
        v = new PorwVerifier();
        FraudFixture memory fixture = buildCanonicalFraudFixture(v);
        tile = fixture.tile;
        trueS = fixture.trueS;
        wProof = fixture.weightsProof;
        pProof = fixture.partialsProof;
        modelRoot = fixture.modelRoot;
        partialsRoot = fixture.partialsRoot;
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
        FraudFixture memory fixture = FraudFixture({
            tile: tile,
            trueS: trueS,
            weightsProof: wProof,
            partialsProof: pProof,
            modelRoot: modelRoot,
            partialsRoot: partialsRoot
        });
        return fraudProofCalldata(v, fixture);
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

        // Independent lock for scripts/canonical-benchmark.json. A successful
        // transaction with any other calldata or verifier runtime is not the
        // canonical Fraud benchmark.
        assertEq(sha256(callData), 0x9922c1eb76e5b34830f97ccb2ae109f58ccf14771f3f95fa14f1505f12dd35bb);
        assertEq(sha256(address(v).code), 0x5f71922f25b2ab6d7e0e7dc808d4895c923d6cd159165bf47cff5b7fb211e716);

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
