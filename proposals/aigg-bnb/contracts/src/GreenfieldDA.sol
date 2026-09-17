// SPDX-License-Identifier: 0BSD
pragma solidity ^0.8.20;

/// @notice The `MEP.weightsDA` pointer format for Greenfield: UTF-8 "gnfd://<bucket>/<object>".
///         Integrity is never the pointer's job — every node verifies the downloaded bytes against
///         `model_id` (keccak weights root). This library only validates the pointer's form so a
///         registry front-end can reject typos before a MEP is immutably registered.
library GreenfieldDA {
    bytes constant PREFIX = "gnfd://";
    function isGreenfieldPointer(bytes memory da) internal pure returns (bool) {
        if (da.length <= PREFIX.length + 1 || da.length > 512) return false;
        for (uint256 i = 0; i < PREFIX.length; i++) if (da[i] != PREFIX[i]) return false;
        uint256 slash = 0; bool seenSlash = false;
        for (uint256 i = PREFIX.length; i < da.length; i++) {
            bytes1 c = da[i];
            if (c == "/") { if (!seenSlash) { if (i == PREFIX.length) return false; seenSlash = true; slash = i; } continue; }
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-" || c == "." || c == "_" || (seenSlash && ((c >= "A" && c <= "Z")));
            if (!ok) return false;
        }
        return seenSlash && slash + 1 < da.length; // bucket and object both non-empty
    }
    function split(bytes memory da) internal pure returns (string memory bucket, string memory object) {
        require(isGreenfieldPointer(da), "not a gnfd pointer");
        uint256 slash = PREFIX.length; while (da[slash] != "/") slash++;
        bytes memory b = new bytes(slash - PREFIX.length); for (uint256 i = 0; i < b.length; i++) b[i] = da[PREFIX.length + i];
        bytes memory o = new bytes(da.length - slash - 1); for (uint256 i = 0; i < o.length; i++) o[i] = da[slash + 1 + i];
        return (string(b), string(o));
    }
}
