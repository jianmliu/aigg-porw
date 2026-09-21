// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/mesh/MEPRegistry.sol";
import "../src/mesh/InstanceRegistry.sol";

interface IBaseRegistration {
    function registerDerivedMEP(IMEPRegistry.MEP calldata m, bytes32 base) external returns (bytes32);
    function registerDerivedMEPWithTerms(IMEPRegistry.MEP calldata m, bytes32 base, address beneficiary, uint16 bps)
        external
        returns (bytes32);
    function baseOf(bytes32 id) external view returns (bytes32);
}

interface IBaseEnrollment {
    function setMEPRegistry(address r) external;
    function enrollmentMep(bytes32 id) external view returns (bytes32);
}

contract BaseClaims {
    mapping(address => mapping(bytes32 => uint64)) public lastValidEpochPlus1;

    function set(address a, bytes32 id, uint64 e) external {
        lastValidEpochPlus1[a][id] = e;
    }
}

contract BaseEnrollmentTest is Test {
    MEPRegistry registry;
    InstanceRegistry instances;
    IBaseRegistration bases;
    IBaseEnrollment enrollment;
    BaseClaims claims;
    bytes32 base;
    address constant HOST = address(0x123);

    function profile(uint256 seed) internal pure returns (IMEPRegistry.MEP memory) {
        return
            IMEPRegistry.MEP(
                bytes32(seed), SCHEME_SKETCH_TILE_KECCAK_V3, bytes32(uint256(9)), 10, 20, bytes32(seed + 100), ""
            );
    }

    function setUp() public {
        registry = new MEPRegistry();
        instances = new InstanceRegistry(1 ether, 10);
        bases = IBaseRegistration(address(registry));
        enrollment = IBaseEnrollment(address(instances));
        base = registry.registerMEP(profile(1));
        claims = new BaseClaims();
        vm.deal(address(this), 100 ether);
    }

    function configure() internal {
        enrollment.setMEPRegistry(address(registry));
        instances.setClaimManager(address(claims));
    }

    function bond(address a, bytes32 id, uint256 value) internal {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        instances.bondFor{value: value}(a, ids);
    }

    function test_runtime_hash_vector() public pure {
        bytes32 raw = 0x580ae348fa8d127fa04811abfdebc0109fa0b8596cad5d1aaa3ffb04b5c474ec;
        bytes32 root = 0x1111111111111111111111111111111111111111111111111111111111111111;
        bytes32 child = PorwMeshHash.mepIdWithBase(raw, root);
        assertEq(child, 0xddb08cb666f3b1db1dee519b5839f726e0c713bc5f121b524477e7398cc8a019);
        assertEq(
            PorwMeshHash.mepIdWithTerms(child, address(0xb0b), 1000),
            0x222415c44a2994cbcac0058bd238d52d21460d4a7e7dce084f7d56fc2da84cb4
        );
    }

    function test_configuration_authority_and_invalid_terms() public {
        vm.prank(HOST);
        vm.expectRevert(bytes("set"));
        enrollment.setMEPRegistry(address(registry));
        vm.expectRevert("registry");
        enrollment.setMEPRegistry(address(0));
        vm.expectRevert("terms");
        bases.registerDerivedMEPWithTerms(profile(2), base, address(0), 100);
        vm.expectRevert("terms");
        bases.registerDerivedMEPWithTerms(profile(2), base, HOST, 0);
        vm.expectRevert("terms");
        bases.registerDerivedMEPWithTerms(profile(2), base, HOST, 10001);
        // An intended self-reference has no previously registered root and is rejected.
        bytes32 raw = registry.registerMEP(profile(2));
        bytes32 intended = PorwMeshHash.mepIdWithBase(raw, base);
        vm.expectRevert("unknown base");
        bases.registerDerivedMEP(profile(2), intended);
    }

    function test_identity() public {
        bytes32 raw = registry.registerMEP(profile(2));
        bytes32 child = bases.registerDerivedMEP(profile(2), base);
        assertEq(child, keccak256(abi.encodePacked(keccak256("aigg:mep:base:v1"), raw, base)));
        assertTrue(raw != child);
        assertEq(bases.baseOf(raw), bytes32(0));
        assertEq(bases.baseOf(child), base);
        bytes32 second = registry.registerMEP(profile(3));
        assertTrue(bases.registerDerivedMEP(profile(2), second) != child);
        vm.expectRevert("registered");
        bases.registerDerivedMEP(profile(2), base);
        bytes32 terms = bases.registerDerivedMEPWithTerms(profile(2), base, HOST, 100);
        assertEq(terms, keccak256(abi.encodePacked(child, HOST, uint16(100))));
        assertEq(bases.baseOf(terms), base);
    }

    function test_invalid_bases() public {
        vm.expectRevert("unknown base");
        bases.registerDerivedMEP(profile(2), bytes32(0));
        bytes32 child = bases.registerDerivedMEP(profile(2), base);
        vm.expectRevert("nested base");
        bases.registerDerivedMEP(profile(3), child);
        vm.expectRevert("unknown base");
        bases.registerDerivedMEP(profile(3), bytes32(uint256(123)));
        IMEPRegistry.MEP memory m = profile(3);
        m.neurons++;
        vm.expectRevert("base layout");
        bases.registerDerivedMEP(m, base);
        m = profile(3);
        m.execKind = bytes32(0);
        vm.expectRevert("base layout");
        bases.registerDerivedMEP(m, base);
        m = profile(3);
        m.synapses++;
        vm.expectRevert("base layout");
        bases.registerDerivedMEP(m, base);
    }

    function test_base_claim_future_child_snapshot() public {
        configure();
        bond(HOST, base, 2 ether);
        claims.set(HOST, base, 5);
        bytes32 child = bases.registerDerivedMEP(profile(2), base);
        assertEq(enrollment.enrollmentMep(child), base);
        assertTrue(instances.inMep(child, HOST));
        assertEq(instances.enrolled(child), 1);
        assertEq(instances.weightCap(child), 2);
        assertTrue(instances.isEligible(HOST, child, 5));
        assertFalse(instances.isEligible(HOST, child, 6));
        assertEq(instances.eligibleVotes(child, 5).length, 2);
        uint256 snapshot = instances.enrolled(child);
        bond(address(0x456), child, 1 ether);
        assertEq(instances.enrolled(base), 2);
        assertEq(instances.sortitionPick(child, 5, snapshot, 1), HOST);
        bond(HOST, child, 1 ether);
        assertEq(instances.enrolled(base), 2);
        assertEq(instances.weightCap(child), 3);
        claims.set(HOST, base, 0);
        assertFalse(instances.isEligible(HOST, child, 5));
    }

    function test_exit_slash_unknown() public {
        configure();
        bytes32 child = bases.registerDerivedMEP(profile(2), base);
        bond(HOST, child, 2 ether);
        instances.setSlasher(address(this), true);
        instances.slash(HOST, 2 ether, address(0), bytes32(0));
        assertFalse(instances.isBondedFor(HOST, child));
        bond(HOST, base, 1 ether);
        vm.prank(HOST);
        instances.requestExit();
        assertFalse(instances.isEligible(HOST, child, 0));
        vm.roll(block.number + 10);
        vm.prank(HOST);
        instances.finalizeExit();
        assertEq(instances.bonded(HOST), 0);
        vm.expectRevert("unknown mep");
        bond(HOST, bytes32(uint256(888)), 1 ether);
        vm.expectRevert("unknown mep");
        instances.enrolled(bytes32(uint256(888)));
        vm.expectRevert(bytes("set"));
        enrollment.setMEPRegistry(address(registry));
    }

    function test_legacy_no_configuration_drift() public {
        bytes32 unknown = bytes32(uint256(888));
        bond(HOST, unknown, 1 ether);
        assertTrue(instances.inMep(unknown, HOST));
        assertEq(enrollment.enrollmentMep(unknown), unknown);
        vm.expectRevert("already bonded");
        enrollment.setMEPRegistry(address(registry));
    }
}
