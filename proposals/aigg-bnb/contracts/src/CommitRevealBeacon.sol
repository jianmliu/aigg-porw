// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

import "aigg-porw/interfaces/IBeacon.sol";

/// @notice Epoch beacon for PoSA chains (BSC / opBNB), where block.prevrandao is a constant.
///         Per epoch: bonded committers commit keccak(secret || sender) during the first COMMIT_BLOCKS,
///         reveal during the next REVEAL_BLOCKS; beaconFor(e) = keccak(revealed secrets in reveal order || e)
///         after the reveal window. Not revealing forfeits the committer's deposit to the pool and excludes
///         its commitment (RANDAO trade-off: the last revealer can bias by withholding, bounded by the deposit).
///         The claim manager only rolls an epoch whose beacon is ready, so claims never precede the beacon.
contract CommitRevealBeacon is IBeacon {
    uint64 public immutable EPOCH_BLOCKS;
    uint64 public immutable COMMIT_BLOCKS;
    uint64 public immutable REVEAL_BLOCKS;
    uint256 public immutable DEPOSIT;
    struct Commit { bytes32 hash; bool revealed; uint256 deposit; }
    mapping(uint64 => mapping(address => Commit)) public commits;
    mapping(uint64 => address[]) internal committers;
    mapping(uint64 => bytes32) internal acc;      // running keccak of revealed secrets
    mapping(uint64 => uint32) public revealedCount;
    uint256 public pool;                          // forfeited deposits (claimable by governance / burned in a deployment)
    event Committed(uint64 indexed epoch, address indexed who);
    event Revealed(uint64 indexed epoch, address indexed who);

    constructor(uint64 epochBlocks, uint64 commitBlocks, uint64 revealBlocks, uint256 deposit) {
        require(commitBlocks + revealBlocks <= epochBlocks, "windows");
        EPOCH_BLOCKS = epochBlocks; COMMIT_BLOCKS = commitBlocks; REVEAL_BLOCKS = revealBlocks; DEPOSIT = deposit;
    }
    function currentEpoch() public view returns (uint64) { return uint64(block.number) / EPOCH_BLOCKS; }
    function epochStart(uint64 e) public view returns (uint64) { return e * EPOCH_BLOCKS; }

    /// @notice commit for the epoch that starts next (so the beacon is fixed before that epoch's claims)
    function commit(bytes32 h) external payable {
        require(msg.value == DEPOSIT, "deposit");
        uint64 e = currentEpoch() + 1; uint64 s = epochStart(e);
        // commit window: the last COMMIT_BLOCKS blocks before epoch e starts
        require(block.number + COMMIT_BLOCKS >= s && block.number < s, "commit window");
        require(commits[e][msg.sender].hash == bytes32(0), "committed");
        commits[e][msg.sender] = Commit(h, false, msg.value); committers[e].push(msg.sender);
        emit Committed(e, msg.sender);
    }
    /// @notice reveal during the first REVEAL_BLOCKS blocks of epoch e
    function reveal(uint64 e, bytes32 secret) external {
        uint64 s = epochStart(e);
        require(block.number >= s && block.number < s + REVEAL_BLOCKS, "reveal window");
        Commit storage c = commits[e][msg.sender];
        require(c.hash != bytes32(0) && !c.revealed && keccak256(abi.encodePacked(secret, msg.sender)) == c.hash, "bad reveal");
        c.revealed = true; revealedCount[e] += 1;
        acc[e] = keccak256(abi.encodePacked(acc[e], secret));
        uint256 d = c.deposit; c.deposit = 0;
        (bool ok,) = msg.sender.call{value: d}(""); require(ok, "refund");
        emit Revealed(e, msg.sender);
    }
    /// @notice anyone may sweep an unrevealed commitment's deposit into the pool after the reveal window
    function forfeit(uint64 e, address who) external {
        require(block.number >= epochStart(e) + REVEAL_BLOCKS, "reveal open");
        Commit storage c = commits[e][who]; require(c.hash != bytes32(0) && !c.revealed && c.deposit > 0, "nothing");
        pool += c.deposit; c.deposit = 0;
    }
    /// @inheritdoc IBeacon
    function beaconFor(uint64 e) external view returns (bytes32) {
        if (block.number < epochStart(e) + REVEAL_BLOCKS) return bytes32(0); // not ready
        if (revealedCount[e] == 0) return bytes32(0);                         // no honest revealer: no beacon (epoch skipped)
        return keccak256(abi.encodePacked(acc[e], e));
    }
    function committersOf(uint64 e) external view returns (address[] memory) { return committers[e]; }
}
