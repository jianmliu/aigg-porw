// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {PorwVerifier} from "../src/PorwVerifier.sol";
import {PoRWBenchFixture} from "../src/bench/PoRWBenchFixture.sol";

contract AnvilBench is Script, PoRWBenchFixture {
    // Anvil's documented first public development key. NEVER use this key for
    // production, public testnets, or any account holding real assets.
    uint256 internal constant ANVIL_PUBLIC_DEV_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        vm.startBroadcast(ANVIL_PUBLIC_DEV_KEY);
        PorwVerifier verifier = new PorwVerifier();
        vm.stopBroadcast();

        FraudFixture memory fixture = buildCanonicalFraudFixture(verifier);
        bytes memory callData = fraudProofCalldata(verifier, fixture);

        vm.startBroadcast(ANVIL_PUBLIC_DEV_KEY);
        (bool ok, bytes memory result) = address(verifier).call(callData);
        require(ok, "verifier call reverted");
        require(abi.decode(result, (uint8)) == 0, "expected Fraud verdict");
        vm.stopBroadcast();
    }
}
