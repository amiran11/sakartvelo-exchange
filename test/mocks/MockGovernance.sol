// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Test stand-in for Governance: lets tests set governor state directly.
contract MockGovernance {
    mapping(uint256 => address) public companyGovernor;
    mapping(uint256 => address) public governorOperatingKey;
    mapping(uint256 => uint256) public governorTermEnd;
    mapping(uint256 => uint256) public termNumber;

    function set(uint256 id, address gov, address key, uint256 termEnd, uint256 term) external {
        companyGovernor[id] = gov;
        governorOperatingKey[id] = key;
        governorTermEnd[id] = termEnd;
        termNumber[id] = term;
    }
}
