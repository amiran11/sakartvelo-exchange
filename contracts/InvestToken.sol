// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title InvestToken
/// @notice A closed-loop, non-transferable ERC-20. Every wallet can claim one
/// equal allocation. It can only be spent into the ShareAuction contract —
/// it can never be sent wallet-to-wallet or sold for another token. This
/// mirrors the white paper's rule that "Invest" cannot be cashed out, only
/// used to bid for shares.
contract InvestToken is ERC20, Ownable {
    uint256 public constant CITIZEN_ALLOCATION = 1000 * 10 ** 18;

    mapping(address => bool) public claimed;
    address public auctionHouse;

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

    constructor() ERC20("Invest", "INVEST") Ownable(msg.sender) {}

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
    /// citizens only. This stops the trivial version of sybil farming
    /// (spin up N unverified wallets, claim N allocations) — it does not
    /// stop a verified individual who controls multiple verified identities,
    /// which is exactly the harder, unsolved half of the problem.
    function claim() external {
        require(verifiedCitizen[msg.sender], "InvestToken: not a verified citizen");
        require(!claimed[msg.sender], "InvestToken: already claimed");
        claimed[msg.sender] = true;
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
    /// balance: it must go to the auction house, nothing else — that's what
    /// stops a citizen reselling their free allocation for cash. It does NOT
    /// restrict the auction house paying money back out (bid refunds,
    /// governor-issued dividends, host fee withdrawals) since that's the
    /// system distributing funds it legitimately collected, not a citizen
    /// cashing out their voucher.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            bool citizenSpendingIn = (to == auctionHouse);
            bool systemPayingOut = (from == auctionHouse) || authorizedSink[to];
            require(citizenSpendingIn || systemPayingOut, "InvestToken: closed loop - citizens may only spend INVEST into the auction house");
        }
        super._update(from, to, value);
    }
}
