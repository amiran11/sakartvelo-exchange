// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./InvestToken.sol";

/// @title RoundAuction
/// @notice A second, alternative auction mechanic alongside ShareAuction —
/// not a replacement. Where ShareAuction settles a company in one shot
/// (top N bidders by raw amount win), RoundAuction runs repeated rounds
/// until every share is sold, using proportional pricing instead of
/// winner-take-all:
///
///   - Each round's LOWEST active bid is the baseline unit (1 share).
///   - Every other active bid gets ceil(bid / baseline) shares — so
///     someone bidding 3x the baseline is entitled to roughly 3x the
///     shares, not the same single share as everyone else.
///   - Bids are processed highest-amount-first. Whoever's turn comes up
///     gets their FULL entitlement if enough shares remain, or nothing
///     this round (all-or-nothing, no partial fills) — ties broken by
///     whoever bid earliest.
///   - A bid that doesn't win this round stays active and automatically
///     carries into the next round, no need to re-bid.
///   - If the company sells out exactly mid-round, everyone still active
///     is refunded in full — there's no future round left for their bid
///     to ever resolve into.
///   - If shares remain but the round didn't fully use them (e.g. nobody
///     bid, or entitlements didn't divide evenly), a new round opens
///     after ROUND_COOLDOWN, permissionlessly triggerable by anyone —
///     nothing on a blockchain can fire itself on a timer, so "automatic"
///     means "callable by anyone once eligible," same pattern as
///     finalize()/tallyRound() elsewhere in this project.
///   - Stall breaker: if EVERY active bidder's full entitlement exceeds
///     what's left (proportional pass issues zero shares), the same
///     settleRound() call immediately falls back to 1 share per bidder,
///     same highest-first/earliest-tiebreak order, until shares or
///     bidders run out. Without this, an unchanged set of active bids
///     would reproduce the identical stall every future round forever,
///     with no path to resolve short of a new, smaller bid happening to
///     arrive. Guarantees real progress on every settlement.
///
/// FICTIONAL SIMULATION. Not a real financial product, security, or claim
/// on any real-world asset. Any resemblance to real entities is a
/// gamified rule-set only.
///
/// Worth being explicit about a real tradeoff, not hidden: this mechanic
/// has no reserve/floor price, unlike standard auction theory (English,
/// Dutch, sealed-bid) which assumes a seller protected by a minimum
/// acceptable price. A thinly-bid round here still sells shares at
/// whatever the lowest active bid happens to be — pure competition-based
/// pricing, deliberately, per how this was designed.
contract RoundAuction is ERC721, Ownable {
    string public constant DISCLAIMER = "FICTIONAL SIMULATION. Not a real financial product, security, or claim on any real-world asset. Any resemblance to real entities is a gamified rule-set only.";

    InvestToken public immutable investToken;
    uint256 public nextTokenId;
    uint256 public constant ROUND_COOLDOWN = 5 minutes;
    uint256 public constant LOCK_PERIOD = 7 days;

    struct Company {
        string name;
        uint256 totalShares;
        uint256 sharesIssued;
        uint256 currentRound;
        uint256 roundEnd;
        uint256 roundDuration; // reused for every round after the first
        bool finalized; // true only once totalShares are fully issued
        uint256 firstMintedAt; // set on this company's very first mint, starts the transfer lock
    }

    struct RoundBid {
        address bidder;
        uint256 amount;
        bool active; // false once won (spent) or refunded — never removed, just flagged
    }

    mapping(uint256 => Company) public companies;
    mapping(uint256 => RoundBid[]) public bids; // companyId => every bid ever placed, active or not
    mapping(uint256 => uint256) public shareCompany; // tokenId => companyId
    mapping(uint256 => uint256) public shareOrdinal; // tokenId => which share # of its company

    event CompanyListed(uint256 indexed companyId, string name, uint256 totalShares, uint256 roundEnd);
    event BidPlaced(uint256 indexed companyId, address indexed bidder, uint256 amount, uint256 bidIndex);
    event RoundSettled(uint256 indexed companyId, uint256 indexed round, uint256 sharesIssuedThisRound, uint256 baselineAmount);
    event RoundReopened(uint256 indexed companyId, uint256 indexed newRound, uint256 roundEnd);
    event CompanySoldOut(uint256 indexed companyId, uint256 refundedBidders);

    constructor(address _investToken) ERC721("Sovereign Share (Round Auction)", "RSHARE") Ownable(msg.sender) {
        investToken = InvestToken(_investToken);
    }

    function listCompany(uint256 companyId, string calldata name, uint256 totalShares, uint256 roundDuration) external onlyOwner {
        require(companies[companyId].totalShares == 0, "RoundAuction: already listed");
        require(totalShares > 0, "RoundAuction: no shares");
        require(roundDuration > 0, "RoundAuction: zero duration");
        companies[companyId] = Company({
            name: name,
            totalShares: totalShares,
            sharesIssued: 0,
            currentRound: 1,
            roundEnd: block.timestamp + roundDuration,
            roundDuration: roundDuration,
            finalized: false,
            firstMintedAt: 0
        });
        emit CompanyListed(companyId, name, totalShares, companies[companyId].roundEnd);
    }

    /// @notice Same real gap closed as ShareAuction's MIN_BID: "> 0" alone
    /// permits a bid as small as one wei-unit. Matters even more here —
    /// beyond the same bid-count gas-spam risk, an extreme low bid also
    /// distorts settleRound()'s baseline (the LOWEST active bid sets
    /// everyone else's proportional entitlement), so a near-zero bid could
    /// inflate other bidders' entitlements to absurd multiples.
    uint256 public constant MIN_BID = 1 * 10 ** 18; // 1 whole INVEST

    function placeBid(uint256 companyId, uint256 amount) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "RoundAuction: unknown company");
        require(!c.finalized, "RoundAuction: sold out");
        require(block.timestamp < c.roundEnd, "RoundAuction: round closed, awaiting settlement");
        require(amount >= MIN_BID, "RoundAuction: bid below minimum (1 INVEST)");
        investToken.transferFrom(msg.sender, address(this), amount);
        bids[companyId].push(RoundBid(msg.sender, amount, true));
        emit BidPlaced(companyId, msg.sender, amount, bids[companyId].length - 1);
    }

    /// @notice Permissionless — anyone can trigger settlement once a round
    /// closes. Does the actual proportional, highest-first allocation.
    function settleRound(uint256 companyId) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "RoundAuction: unknown company");
        require(!c.finalized, "RoundAuction: already sold out");
        require(block.timestamp >= c.roundEnd, "RoundAuction: round still open");

        RoundBid[] storage b = bids[companyId];

        // Find the baseline (lowest active bid) and collect active indices.
        uint256 minAmount = type(uint256).max;
        uint256 activeCount = 0;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i].active) {
                activeCount++;
                if (b[i].amount < minAmount) minAmount = b[i].amount;
            }
        }

        if (activeCount == 0) {
            c.currentRound++;
            c.roundEnd = block.timestamp + ROUND_COOLDOWN + c.roundDuration;
            emit RoundReopened(companyId, c.currentRound, c.roundEnd);
            return;
        }

        // Build and sort active indices descending by amount (insertion
        // sort — same O(n^2) approach already used elsewhere in this
        // project, fine at demo scale, not for national volume). Ties
        // keep their original relative order, which is earliest-bid-first
        // since indices only ever increase as bids are placed.
        uint256[] memory idx = new uint256[](activeCount);
        uint256 p = 0;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i].active) { idx[p] = i; p++; }
        }
        for (uint256 i = 1; i < idx.length; i++) {
            uint256 key = idx[i];
            uint256 keyAmount = b[key].amount;
            uint256 j = i;
            while (j > 0 && b[idx[j - 1]].amount < keyAmount) {
                idx[j] = idx[j - 1];
                j--;
            }
            idx[j] = key;
        }

        uint256 sharesRemaining = c.totalShares - c.sharesIssued;
        uint256 issuedThisRound = 0;

        for (uint256 k = 0; k < idx.length; k++) {
            if (sharesRemaining == 0) break;
            RoundBid storage bid = b[idx[k]];
            uint256 entitlement = (bid.amount + minAmount - 1) / minAmount; // ceil division

            if (entitlement <= sharesRemaining) {
                if (c.firstMintedAt == 0) c.firstMintedAt = block.timestamp;
                for (uint256 s = 0; s < entitlement; s++) {
                    uint256 tokenId = nextTokenId++;
                    _safeMint(bid.bidder, tokenId);
                    shareCompany[tokenId] = companyId;
                    c.sharesIssued++;
                    shareOrdinal[tokenId] = c.sharesIssued;
                }
                sharesRemaining -= entitlement;
                issuedThisRound += entitlement;
                bid.active = false; // won — spent, does not carry forward
            }
            // else: leave active = true — automatically carries into next round
        }

        // Stall breaker: if every active bidder's full entitlement exceeded
        // what remained, the proportional pass above issues nothing, and
        // with an unchanged baseline/entitlements, the exact same stall
        // would repeat every future round forever unless a smaller new bid
        // happens to arrive. Rather than risk that, fall back — same
        // transaction, no extra round or cooldown needed — to 1 share per
        // bidder, same highest-first/earliest-tiebreak order, until shares
        // or bidders run out. Guarantees real progress on every single
        // settleRound() call whenever at least one active bid and one
        // share exist.
        if (issuedThisRound == 0 && sharesRemaining > 0) {
            for (uint256 k = 0; k < idx.length; k++) {
                if (sharesRemaining == 0) break;
                RoundBid storage bid = b[idx[k]];
                if (!bid.active) continue;
                if (c.firstMintedAt == 0) c.firstMintedAt = block.timestamp;
                uint256 tokenId = nextTokenId++;
                _safeMint(bid.bidder, tokenId);
                shareCompany[tokenId] = companyId;
                c.sharesIssued++;
                shareOrdinal[tokenId] = c.sharesIssued;
                sharesRemaining -= 1;
                issuedThisRound += 1;
                bid.active = false;
            }
        }

        emit RoundSettled(companyId, c.currentRound, issuedThisRound, minAmount);

        if (sharesRemaining == 0) {
            c.finalized = true;
            uint256 refunded = 0;
            for (uint256 i = 0; i < b.length; i++) {
                if (b[i].active) {
                    investToken.transfer(b[i].bidder, b[i].amount);
                    b[i].active = false;
                    refunded++;
                }
            }
            emit CompanySoldOut(companyId, refunded);
        } else {
            c.currentRound++;
            c.roundEnd = block.timestamp + ROUND_COOLDOWN + c.roundDuration;
            emit RoundReopened(companyId, c.currentRound, c.roundEnd);
        }
    }

    /// @dev Same transfer lock as ShareAuction — nothing moves until
    /// LOCK_PERIOD has passed since this company's first-ever mint.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            Company storage c = companies[shareCompany[tokenId]];
            require(block.timestamp >= c.firstMintedAt + LOCK_PERIOD, "RoundAuction: shares still locked");
        }
        return super._update(to, tokenId, auth);
    }
}
