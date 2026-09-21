// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @notice Shared compute occupancy. Capacity filters eligibility; it never changes stake weight.
/// Leases expire only AFTER their final block. Reducing capacity never cancels outstanding work.
contract HostCapacity {
    uint16 public constant MAX_SLOTS = 64;
    address public immutable owner;
    mapping(address => bool) public authorizedMarkets;
    mapping(address => uint16) public capacityOf;
    struct Lease { address market; uint64 expiresAt; bytes32 taskId; }
    mapping(address => Lease[]) private leases;
    event MarketAuthorization(address indexed market, bool authorized);
    event CapacitySet(address indexed host, uint16 capacity);
    event Reserved(address indexed market, bytes32 indexed taskId, address indexed host, uint64 expiresAt);
    event Released(address indexed market, bytes32 indexed taskId, address indexed host);
    constructor() { owner = msg.sender; }
    function setMarket(address market, bool authorized) external {
        require(msg.sender == owner, "owner"); require(market != address(0), "market");
        authorizedMarkets[market] = authorized; emit MarketAuthorization(market, authorized);
    }
    function setCapacity(uint16 capacity) external {
        require(capacity <= MAX_SLOTS, "capacity"); capacityOf[msg.sender] = capacity;
        emit CapacitySet(msg.sender, capacity);
    }
    function activeSlots(address host) public view returns (uint16 active) {
        Lease[] storage slots = leases[host];
        for (uint256 i; i < slots.length; i++) if (slots[i].market != address(0) && block.number <= slots[i].expiresAt) active++;
    }
    function availableSlots(address host) external view returns (uint16) { (,,uint16 free) = snapshot(host); return free; }
    function snapshot(address host) public view returns (uint16 limit, uint16 active, uint16 free) {
        limit = capacityOf[host]; active = activeSlots(host); free = limit > active ? limit - active : 0;
    }
    function reserve(bytes32 taskId, address host, uint64 expiresAt) external returns (bool) {
        require(authorizedMarkets[msg.sender], "market"); require(expiresAt >= block.number, "expiry");
        Lease[] storage slots = leases[host]; uint256 vacant = slots.length; uint16 active;
        for (uint256 i; i < slots.length; i++) {
            Lease storage slot = slots[i];
            if (slot.market != address(0) && block.number <= slot.expiresAt) {
                if (slot.market == msg.sender && slot.taskId == taskId) return false;
                active++;
            } else if (vacant == slots.length) vacant = i;
        }
        if (active >= capacityOf[host]) return false;
        Lease memory next = Lease(msg.sender, expiresAt, taskId);
        if (vacant == slots.length) slots.push(next); else slots[vacant] = next;
        emit Reserved(msg.sender, taskId, host, expiresAt); return true;
    }
    /// @notice Revoked markets may still release their own exact leases; stale releases are harmless.
    function release(bytes32 taskId, address host) external {
        Lease[] storage slots = leases[host];
        for (uint256 i; i < slots.length; i++) {
            if (slots[i].market == msg.sender && slots[i].taskId == taskId) {
                delete slots[i]; emit Released(msg.sender, taskId, host); return;
            }
        }
    }
}
