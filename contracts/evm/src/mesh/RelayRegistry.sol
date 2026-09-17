// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @notice Bonded list of stage-1 relay endpoints (WebSocket pub/sub hubs). Relays are never trusted
///         for correctness — envelopes are signed and settlement is on-chain — only for liveness, so
///         instances fan out to several and the bond gives operators an identity to be dropped by.
///         Anyone may register; exit after a delay. Clients read `relays()` and pick >= 2.
contract RelayRegistry {
    uint256 public immutable BOND;
    uint64 public immutable EXIT_DELAY;
    struct Relay { string url; uint256 bond; uint64 exitAt; bool active; }
    mapping(address => Relay) public relays_;
    address[] public operators;
    event RelayRegistered(address indexed operator, string url);
    event RelayExit(address indexed operator, uint64 exitAt);

    constructor(uint256 bond, uint64 exitDelay) { BOND = bond; EXIT_DELAY = exitDelay; }

    function register(string calldata url) external payable {
        Relay storage r = relays_[msg.sender];
        require(bytes(url).length > 0 && bytes(url).length <= 256, "url");
        if (!r.active) { require(msg.value == BOND, "bond"); r.bond = msg.value; r.active = true; operators.push(msg.sender); }
        else require(msg.value == 0 && r.exitAt == 0, "state"); // an active relay may update its url
        r.url = url;
        emit RelayRegistered(msg.sender, url);
    }
    function requestExit() external { Relay storage r = relays_[msg.sender]; require(r.active && r.exitAt == 0, "state"); r.exitAt = uint64(block.number) + EXIT_DELAY; emit RelayExit(msg.sender, r.exitAt); }
    function finalizeExit() external {
        Relay storage r = relays_[msg.sender]; require(r.active && r.exitAt != 0 && block.number >= r.exitAt, "not yet");
        uint256 b = r.bond; delete relays_[msg.sender];
        for (uint256 i = 0; i < operators.length; i++) if (operators[i] == msg.sender) { operators[i] = operators[operators.length - 1]; operators.pop(); break; }
        (bool ok,) = msg.sender.call{value: b}(""); require(ok, "pay");
    }
    /// @notice active, non-exiting relays
    function relays() external view returns (address[] memory ops, string[] memory urls) {
        uint256 n = 0; for (uint256 i = 0; i < operators.length; i++) if (relays_[operators[i]].exitAt == 0) n++;
        ops = new address[](n); urls = new string[](n); uint256 k = 0;
        for (uint256 i = 0; i < operators.length; i++) { Relay storage r = relays_[operators[i]]; if (r.exitAt == 0) { ops[k] = operators[i]; urls[k] = r.url; k++; } }
    }
}
