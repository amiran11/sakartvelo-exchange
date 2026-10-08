// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Plain test token with open minting.
contract MockERC20 is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// Test token that burns 1% of every transfer, to check deposits credit
/// only what actually arrives.
contract FeeToken is ERC20 {
    constructor() ERC20("FEE", "FEE") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}
