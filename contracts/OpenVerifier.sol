// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./InvestToken.sol";

/// @title OpenVerifier
/// @notice A tiny, single-purpose helper: lets ANYONE verify themselves as
/// a citizen on InvestToken, permissionlessly. Deployed separately and
/// granted InvestToken's `verifier` role (via setVerifier) rather than
/// modifying InvestToken itself — avoids redeploying InvestToken and
/// every downstream contract that references its address immutably.
///
/// FICTIONAL SIMULATION. Not a real financial product, security, or claim
/// on any real-world asset.
///
/// @dev Deliberate tradeoff, stated plainly: this removes any Sybil
/// resistance from citizen verification. Anyone can generate unlimited
/// wallets and self-verify each one, up to InvestToken's overall
/// maxCitizens cap — there is no proof-of-personhood check here. Given
/// this project's fictional/simulation nature, that's an accepted
/// tradeoff in exchange for letting people participate without needing
/// the owner to manually approve every address.
contract OpenVerifier {
    InvestToken public immutable investToken;

    /// @notice Roughly $20 in ETH at time of writing (~$2,413/ETH on
    /// Arbitrum One). Fixed in wei, not a live USD figure — Solidity has
    /// no built-in price feed, so this will drift out of sync with $20 as
    /// ETH's price moves; a real price oracle (e.g. Chainlink) would be
    /// needed to keep it pinned to an actual dollar amount over time.
    /// Purpose: raises the real cost of spinning up disposable wallets
    /// purely to claim repeatedly — not foolproof (anyone with real
    /// capital can still fund many wallets), but a genuine on-chain check,
    /// unlike a CAPTCHA, which a contract cannot verify at all.
    uint256 public constant MIN_BALANCE = 0.0083 ether;

    event SelfVerified(address indexed citizen);

    constructor(address _investToken) {
        investToken = InvestToken(_investToken);
    }

    /// @notice Verifies the caller as a citizen on InvestToken. Anyone can
    /// call this for themselves, any number of times (idempotent), as
    /// long as their wallet holds at least MIN_BALANCE in ETH at call
    /// time. Does NOT claim INVEST itself; call InvestToken.claim()
    /// separately afterward.
    function verifySelf() external {
        require(msg.sender.balance >= MIN_BALANCE, "OpenVerifier: insufficient ETH balance");
        investToken.setVerifiedCitizen(msg.sender, true);
        emit SelfVerified(msg.sender);
    }
}
