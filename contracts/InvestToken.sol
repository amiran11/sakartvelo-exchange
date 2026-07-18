// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Minimal interface into ShareAuction — avoids a circular import
/// (ShareAuction already imports InvestToken to hold a reference back).
interface IShareAuction {
    function privatizationConcluded() external view returns (bool);
}

/// @title InvestToken
/// @notice A closed-loop, non-transferable ERC-20. Every wallet can claim one
/// equal allocation. It can only be spent into the ShareAuction contract —
/// it can never be sent wallet-to-wallet or sold for another token. This
/// mirrors the white paper's rule that "Invest" cannot be cashed out, only
/// used to bid for shares.
contract InvestToken is ERC20, Ownable {
    /// @notice This is a fictional virtual-state simulation. Any resemblance
    /// to real countries, governments, companies, agencies, or assets is
    /// fictional and exists solely as a gamified rule-set. Nothing here is a
    /// real financial product, security, or claim on any real-world asset.
    string public constant DISCLAIMER = "FICTIONAL SIMULATION. Not a real financial product, security, or claim on any real-world asset. Any resemblance to real entities is a gamified rule-set only.";

    uint256 public constant CITIZEN_ALLOCATION = 1000 * 10 ** 18;

    mapping(address => bool) public claimed;
    address public auctionHouse;

    /// @notice Hard ceiling on how many allocations can ever be minted,
    /// independent of the verification gate below. verifiedCitizen only
    /// stops unverified addresses from claiming — nothing stops the owner
    /// (or whoever controls that mapping) from verifying more addresses
    /// than there are real citizens, whether by mistake or not. This cap is
    /// the backstop: total emission can never exceed maxCitizens *
    /// CITIZEN_ALLOCATION, full stop, regardless of how verification is
    /// run. In a real deployment this would be set to the actual eligible
    /// population (e.g. Georgia's citizen count), not left unbounded.
    uint256 public maxCitizens;
    uint256 public citizenCount;

    /// @dev On-chain code cannot tell whether two wallets belong to the same
    /// human — that's the fundamental sybil problem. This gate doesn't solve
    /// it, it just moves the question to whoever controls it: here, the
    /// contract owner flips a bool per address, which is a stand-in for a
    /// real identity check (a government ID registry, or a proof-of-personhood
    /// service like Worldcoin/BrightID/Gitcoin Passport in production). Without
    /// something upstream verifying "one human, one wallet," any allocation
    /// scheme can be farmed with throwaway addresses.
    mapping(address => bool) public verifiedCitizen;

    /// @dev INVEST is otherwise closed-loop. This whitelist is a narrow,
    /// explicit exception for specific withdrawable payouts (e.g. the host's
    /// 1% fee) beyond what the rule below already allows.
    mapping(address => bool) public authorizedSink;

    event Claimed(address indexed citizen, uint256 amount);
    event AuctionHouseSet(address indexed auctionHouse);
    event AuthorizedSinkSet(address indexed account, bool allowed);
    event CitizenVerified(address indexed citizen, bool verified);
    event MaxCitizensSet(uint256 newMax);

    constructor(uint256 _maxCitizens) ERC20("Invest", "INVEST") Ownable(msg.sender) {
        maxCitizens = _maxCitizens;
        emit MaxCitizensSet(_maxCitizens);
    }

    /// @notice Can be raised or lowered later, but never below citizenCount —
    /// existing allocations are never invalidated by tightening the cap.
    /// Changing this is a public, on-chain event; there's no silent way to
    /// inflate the emission ceiling.
    function setMaxCitizens(uint256 newMax) external onlyOwner {
        require(newMax >= citizenCount, "InvestToken: below current citizen count");
        maxCitizens = newMax;
        emit MaxCitizensSet(newMax);
    }

    function setVerifiedCitizen(address citizen, bool verified) external onlyOwner {
        verifiedCitizen[citizen] = verified;
        emit CitizenVerified(citizen, verified);
    }

    function setVerifiedCitizens(address[] calldata citizens, bool verified) external onlyOwner {
        for (uint256 i = 0; i < citizens.length; i++) {
            verifiedCitizen[citizens[i]] = verified;
            emit CitizenVerified(citizens[i], verified);
        }
    }

    /// @notice One-time equal allocation per wallet, gated to verified
    /// citizens only, capped at maxCitizens total, and only while the state
    /// still has shares left to sell (ShareAuction.privatizationConcluded()
    /// is false). Both caps apply — maxCitizens is a hard number ceiling
    /// independent of the process; the privatization check ties emission to
    /// whether there's still anything to bid on, matching the white paper's
    /// rule that Invest is distributed "until the privatization process is
    /// concluded." Before auctionHouse is set, or before any company has
    /// been listed, this check is skipped — citizens can claim ahead of the
    /// first auction opening.
    function claim() external {
        require(verifiedCitizen[msg.sender], "InvestToken: not a verified citizen");
        require(!claimed[msg.sender], "InvestToken: already claimed");
        require(citizenCount < maxCitizens, "InvestToken: emission cap reached");
        if (auctionHouse != address(0)) {
            require(!IShareAuction(auctionHouse).privatizationConcluded(), "InvestToken: privatization concluded, no new allocations");
        }
        claimed[msg.sender] = true;
        citizenCount++;
        _mint(msg.sender, CITIZEN_ALLOCATION);
        emit Claimed(msg.sender, CITIZEN_ALLOCATION);
    }

    function setAuctionHouse(address _auctionHouse) external onlyOwner {
        require(_auctionHouse != address(0), "InvestToken: zero address");
        auctionHouse = _auctionHouse;
        emit AuctionHouseSet(_auctionHouse);
    }

    function setAuthorizedSink(address account, bool allowed) external onlyOwner {
        authorizedSink[account] = allowed;
        emit AuthorizedSinkSet(account, allowed);
    }

    /// @dev The closed loop only restricts citizens spending their own
    /// balance: it must go to the auction house or an authorized sink,
    /// nothing else — that's what stops a citizen reselling their free
    /// allocation for cash. It does NOT restrict the auction house or an
    /// authorized sink (e.g. CompanyTreasury) paying money back out (bid
    /// refunds, governor-issued dividends, treasury auction proceeds, host
    /// fee withdrawals) since that's the system distributing funds it
    /// legitimately collected, not a citizen cashing out their voucher.
    /// authorizedSink is checked symmetrically on both `to` and `from` for
    /// exactly this reason — a trusted contract like CompanyTreasury needs
    /// to both receive citizen payments (bids, INVEST-market purchases) and
    /// pay citizens back out (refunds, dividends) from the same address.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            bool citizenSpendingIn = (to == auctionHouse) || authorizedSink[to];
            bool systemPayingOut = (from == auctionHouse) || authorizedSink[from];
            require(citizenSpendingIn || systemPayingOut, "InvestToken: closed loop - citizens may only spend INVEST into the auction house or an authorized sink");
        }
        super._update(from, to, value);
    }
}
