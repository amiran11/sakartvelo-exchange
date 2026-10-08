// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "./InvestToken.sol";

/// @notice The parts of Governance this contract reads. Governance itself
/// lives in its own contract (Governance.sol) since v8, which keeps this
/// one under the 24,576-byte contract size limit.
interface IGovernance {
    function companyGovernor(uint256 companyId) external view returns (address);
    function governorOperatingKey(uint256 companyId) external view returns (address);
    function governorTermEnd(uint256 companyId) external view returns (uint256);
    function termNumber(uint256 companyId) external view returns (uint256);
}

/// @title RoundAuction (v8)
/// @notice Proportional, round-based privatization auction for share NFTs.
///
///   - Each round's LOWEST active bid is the baseline unit (1 share).
///   - Every other active bid is entitled to ceil(bid / baseline) shares.
///   - Bids are processed highest-amount-first, earliest bid first on ties.
///     A bid gets its FULL entitlement if enough shares remain this round,
///     or nothing this round (no partial fills); unfilled bids carry
///     forward automatically.
///   - Every settlement makes progress: the lowest bid IS the baseline, so
///     its own entitlement is always exactly 1 share and always fits if
///     nothing else did. (v7's "stall breaker" fallback could therefore
///     never run, and was removed as dead code.)
///   - If the company sells out, every still-active bid is refunded.
///
/// v8 changes, all from SECURITY_REVIEW.md Findings 11-14:
///   - Settlement cost is bounded by MAX_ACTIVE_BIDS (100) and
///     MAX_SHARES_PER_ROUND (300), both measured against Arbitrum's
///     32,000,000 gas per-transaction limit. Bids are sorted in memory.
///   - One active bid per wallet. The cap counts ACTIVE bids only, so a
///     company can take unlimited bids over its lifetime.
///   - Corporate bids refunded at sellout go back to the origin company's
///     reinvestable income, not to a keyless synthetic address.
///   - Share market checks the seller still owns the share at purchase.
///   - Shares mint without the ERC721 receiver callback, so a contract
///     wallet cannot make settlement revert.
///   - Every holder's share count keeps a timestamped history, so votes
///     and dividends can use balances "as of" a fixed moment.
///
/// FICTIONAL SIMULATION. Not a real financial product, security, or claim
/// on any real-world asset.
contract RoundAuction is ERC721, Ownable {
    using Checkpoints for Checkpoints.Trace208;

    string public constant DISCLAIMER = "FICTIONAL SIMULATION. Not a real financial product, security, or claim on any real-world asset. Any resemblance to real entities is a gamified rule-set only.";

    InvestToken public immutable investToken;
    uint256 public nextTokenId;
    uint256 public constant ROUND_COOLDOWN = 5 minutes;
    uint256 public constant LOCK_PERIOD = 7 days;
    uint256 public constant HOST_FEE_BPS = 100; // 1%
    uint256 public constant MIN_BID = 1 * 10 ** 18; // 1 whole INVEST
    uint256 public constant MAX_ACTIVE_BIDS = 100;
    uint256 public constant MAX_SHARES_PER_ROUND = 300;
    uint256 public constant TRADABILITY_THRESHOLD_BPS = 5100; // 51%

    address public host;
    uint256 public hostFeeAccrued;
    address public treasury;
    IGovernance public governance;
    bool public globalTradabilityUnlocked;

    // Field order kept identical to v7, so existing readers of companies()
    // (CompanyTreasury, the site) decode it unchanged.
    struct Company {
        string name;
        uint256 totalShares;
        uint256 sharesIssued;
        uint256 currentRound;
        uint256 roundEnd;
        uint256 roundDuration;
        bool finalized;
        uint256 firstMintedAt;
        uint256 capital;
    }

    struct Bid {
        address bidder;
        uint256 amount;
        uint256 seq; // global placement order, for earliest-first tie-breaks
    }

    mapping(uint256 => Company) public companies;
    mapping(uint256 => Bid[]) internal activeBids; // companyId => active bids only
    mapping(uint256 => mapping(address => uint256)) public activeBidSlot; // companyId => bidder => index + 1 (0 = none)
    uint256 public nextBidSeq;

    // tokenId => companyId (high 128 bits) | ordinal within its company (low 128 bits).
    // One storage slot per share instead of two keeps minting cheaper.
    mapping(uint256 => uint256) internal shareInfo;

    mapping(uint256 => mapping(address => Checkpoints.Trace208)) internal holdingHistory;
    mapping(uint256 => Checkpoints.Trace208) internal issuedHistory;

    mapping(uint256 => uint256) public reinvestableIncome;
    mapping(address => uint256) public corporateHolderToCompanyPlusOne;
    mapping(uint256 => uint256) public compensationOriginCompany;
    mapping(uint256 => uint256) public compensationUnlockTerm;

    uint256 public companiesListed;
    uint256 public companiesFinalized;

    event CompanyListed(uint256 indexed companyId, string name, uint256 totalShares, uint256 roundEnd);
    event BidPlaced(uint256 indexed companyId, address indexed bidder, uint256 amount, uint256 bidIndex);
    event BidFilled(uint256 indexed companyId, address indexed bidder, uint256 shares, uint256 paid);
    event BidRefunded(uint256 indexed companyId, address indexed bidder, uint256 amount);
    event RoundSettled(uint256 indexed companyId, uint256 indexed round, uint256 sharesIssuedThisRound, uint256 baselineAmount);
    event RoundReopened(uint256 indexed companyId, uint256 indexed newRound, uint256 roundEnd);
    event CompanySoldOut(uint256 indexed companyId, uint256 refundedBidders);
    event HostFeesWithdrawn(address indexed host, uint256 amount);
    event HostSet(address indexed host);
    event TreasurySet(address indexed treasury);
    event GovernanceSet(address indexed governance);
    event GlobalTradabilityUnlocked(uint256 indexed companyId, uint256 sharesIssued, uint256 totalShares);
    event CorporateInvestment(uint256 indexed fromCompanyId, uint256 indexed toCompanyId, uint256 amount);

    constructor(address _investToken) ERC721("Sovereign Share (Round Auction)", "RSHARE") Ownable(msg.sender) {
        investToken = InvestToken(_investToken);
        host = msg.sender;
    }

    // ---------------------------------------------------------------------
    // Admin wiring. Treasury and Governance can each be set exactly once,
    // so the owner key can't later redirect custody or governor checks.
    // ---------------------------------------------------------------------

    function setHost(address _host) external onlyOwner {
        require(_host != address(0), "RA: zero address");
        host = _host;
        emit HostSet(_host);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(treasury == address(0), "RA: treasury already set");
        require(_treasury != address(0), "RA: zero address");
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    function setGovernance(address _governance) external onlyOwner {
        require(address(governance) == address(0), "RA: governance already set");
        require(_governance != address(0), "RA: zero address");
        governance = IGovernance(_governance);
        emit GovernanceSet(_governance);
    }

    function withdrawHostFees() external {
        require(msg.sender == host, "RA: not host");
        uint256 amount = hostFeeAccrued;
        require(amount > 0, "RA: nothing to withdraw");
        hostFeeAccrued = 0;
        investToken.transfer(host, amount);
        emit HostFeesWithdrawn(host, amount);
    }

    modifier onlyTreasury() {
        require(msg.sender == treasury, "RA: not treasury");
        _;
    }

    modifier onlyGovernor(uint256 companyId) {
        require(msg.sender == governance.governorOperatingKey(companyId), "RA: not operating key");
        require(block.timestamp < governance.governorTermEnd(companyId), "RA: term expired");
        _;
    }

    /// @notice Invariant: this contract holds INVEST >= the sum of every
    /// company's capital + reinvestable income + host fees + active bids.
    /// A negative delta pays the real tokens to the treasury in the same
    /// call; a positive delta requires the treasury to have sent them first.
    function adjustCapital(uint256 companyId, int256 delta) external onlyTreasury {
        if (delta >= 0) {
            companies[companyId].capital += uint256(delta);
        } else {
            uint256 dec = uint256(-delta);
            require(companies[companyId].capital >= dec, "RA: capital underflow");
            companies[companyId].capital -= dec;
            investToken.transfer(msg.sender, dec);
        }
    }

    function addReinvestableIncome(uint256 companyId, uint256 amount) external onlyTreasury {
        reinvestableIncome[companyId] += amount;
    }

    function listCompany(uint256 companyId, string calldata name, uint256 totalShares, uint256 roundDuration) external onlyOwner {
        require(companies[companyId].totalShares == 0, "RA: already listed");
        require(totalShares > 0 && totalShares < type(uint128).max, "RA: bad share count");
        require(roundDuration > 0, "RA: zero duration");
        companies[companyId] = Company(name, totalShares, 0, 1, block.timestamp + roundDuration, roundDuration, false, 0, 0);
        companiesListed++;
        corporateHolderToCompanyPlusOne[corporateHolder(companyId)] = companyId + 1;
        emit CompanyListed(companyId, name, totalShares, companies[companyId].roundEnd);
    }

    // ---------------------------------------------------------------------
    // Bidding
    // ---------------------------------------------------------------------

    function placeBid(uint256 companyId, uint256 amount) external {
        investToken.transferFrom(msg.sender, address(this), amount);
        _addBid(companyId, msg.sender, amount);
    }

    /// @notice A governor commits this company's reinvestable income (never
    /// its original capital) as a bid in another company's open round.
    function invest(uint256 fromCompanyId, uint256 toCompanyId, uint256 amount) external onlyGovernor(fromCompanyId) {
        require(reinvestableIncome[fromCompanyId] >= amount, "RA: no reinvest income");
        reinvestableIncome[fromCompanyId] -= amount;
        _addBid(toCompanyId, corporateHolder(fromCompanyId), amount);
        emit CorporateInvestment(fromCompanyId, toCompanyId, amount);
    }

    function _addBid(uint256 companyId, address bidder, uint256 amount) internal {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "RA: unknown company");
        require(!c.finalized, "RA: sold out");
        require(block.timestamp < c.roundEnd, "RA: round closed");
        require(amount >= MIN_BID, "RA: bid below 1 INVEST");
        require(activeBidSlot[companyId][bidder] == 0, "RA: already have active bid");
        Bid[] storage list = activeBids[companyId];
        require(list.length < MAX_ACTIVE_BIDS, "RA: active bid cap reached");
        uint256 seq = nextBidSeq++;
        list.push(Bid(bidder, amount, seq));
        activeBidSlot[companyId][bidder] = list.length;
        emit BidPlaced(companyId, bidder, amount, seq);
    }

    /// @notice Every active bid for a company, for the site to display.
    function getActiveBids(uint256 companyId) external view returns (Bid[] memory) {
        return activeBids[companyId];
    }

    function activeBidCount(uint256 companyId) external view returns (uint256) {
        return activeBids[companyId].length;
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Permissionless once a round closes.
    function settleRound(uint256 companyId) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "RA: unknown company");
        require(!c.finalized, "RA: sold out");
        require(block.timestamp >= c.roundEnd, "RA: round still open");

        Bid[] storage list = activeBids[companyId];
        uint256 n = list.length;
        if (n == 0) {
            _openNextRound(companyId, c);
            return;
        }

        // Copy to memory once; all sorting and allocation happens there.
        Bid[] memory bs = new Bid[](n);
        uint256 minAmount = type(uint256).max;
        for (uint256 i = 0; i < n; i++) {
            bs[i] = list[i];
            if (bs[i].amount < minAmount) minAmount = bs[i].amount;
        }
        _sortDesc(bs);

        uint256 trueRemaining = c.totalShares - c.sharesIssued;
        uint256 sharesLeft = trueRemaining > MAX_SHARES_PER_ROUND ? MAX_SHARES_PER_ROUND : trueRemaining;
        uint256 issued = 0;
        uint256 roundCapital = 0;
        uint256 roundFee = 0;
        if (c.firstMintedAt == 0) c.firstMintedAt = block.timestamp;

        // Proportional pass: full entitlement or nothing this round.
        for (uint256 k = 0; k < n && sharesLeft > 0; k++) {
            uint256 ent = (bs[k].amount + minAmount - 1) / minAmount;
            if (ent <= sharesLeft) {
                _mintShares(companyId, c, bs[k].bidder, ent);
                sharesLeft -= ent;
                issued += ent;
                uint256 fee = (bs[k].amount * HOST_FEE_BPS) / 10_000;
                roundFee += fee;
                roundCapital += bs[k].amount - fee;
                emit BidFilled(companyId, bs[k].bidder, ent, bs[k].amount);
                bs[k].amount = 0; // filled
            }
        }

        c.capital += roundCapital;
        hostFeeAccrued += roundFee;
        issuedHistory[companyId].push(uint48(block.timestamp), uint208(c.sharesIssued));

        if (!globalTradabilityUnlocked && c.sharesIssued * 10_000 >= c.totalShares * TRADABILITY_THRESHOLD_BPS) {
            globalTradabilityUnlocked = true;
            emit GlobalTradabilityUnlocked(companyId, c.sharesIssued, c.totalShares);
        }
        emit RoundSettled(companyId, c.currentRound, issued, minAmount);

        bool soldOut = c.sharesIssued == c.totalShares;
        uint256 refunded = 0;

        // Rewrite the active list from memory: survivors only, in place.
        for (uint256 i = 0; i < n; i++) {
            delete activeBidSlot[companyId][bs[i].bidder];
        }
        uint256 w = 0;
        for (uint256 k = 0; k < n; k++) {
            if (bs[k].amount == 0) continue;
            if (soldOut) {
                _refund(companyId, bs[k].bidder, bs[k].amount);
                refunded++;
                continue;
            }
            list[w] = bs[k];
            activeBidSlot[companyId][bs[k].bidder] = w + 1;
            w++;
        }
        while (list.length > w) list.pop();

        if (soldOut) {
            c.finalized = true;
            companiesFinalized++;
            emit CompanySoldOut(companyId, refunded);
        } else {
            _openNextRound(companyId, c);
        }
    }

    function _openNextRound(uint256 companyId, Company storage c) internal {
        c.currentRound++;
        c.roundEnd = block.timestamp + ROUND_COOLDOWN + c.roundDuration;
        emit RoundReopened(companyId, c.currentRound, c.roundEnd);
    }

    /// @dev Highest amount first, earliest bid first on ties. Insertion
    /// sort in memory: at most 100 entries, so at most ~5,000 cheap moves.
    function _sortDesc(Bid[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; i++) {
            Bid memory key = a[i];
            uint256 j = i;
            while (j > 0 && (a[j - 1].amount < key.amount || (a[j - 1].amount == key.amount && a[j - 1].seq > key.seq))) {
                a[j] = a[j - 1];
                j--;
            }
            a[j] = key;
        }
    }

    /// @dev Refunds a citizen in INVEST, or a corporate bidder back into its
    /// origin company's reinvestable income (the tokens never leave here).
    function _refund(uint256 companyId, address bidder, uint256 amount) internal {
        uint256 originPlusOne = corporateHolderToCompanyPlusOne[bidder];
        if (originPlusOne != 0) {
            reinvestableIncome[originPlusOne - 1] += amount;
        } else {
            investToken.transfer(bidder, amount);
        }
        emit BidRefunded(companyId, bidder, amount);
    }

    /// @dev Mints `qty` shares. For a corporate (reinvestment) win, 1%
    /// (rounded down) goes to the origin company's sitting governor as
    /// in-kind compensation, locked until that company reaches term + 2.
    function _mintShares(uint256 companyId, Company storage c, address to, uint256 qty) internal {
        uint256 originPlusOne = corporateHolderToCompanyPlusOne[to];
        if (originPlusOne != 0 && address(governance) != address(0)) {
            uint256 originId = originPlusOne - 1;
            address gov = governance.companyGovernor(originId);
            uint256 govCut = gov != address(0) ? qty / 100 : 0;
            if (govCut > 0) {
                uint256 unlockTerm = governance.termNumber(originId) + 2;
                uint256 first = nextTokenId;
                _mintBatch(companyId, c, gov, govCut);
                for (uint256 t = first; t < first + govCut; t++) {
                    compensationOriginCompany[t] = originId;
                    compensationUnlockTerm[t] = unlockTerm;
                }
                qty -= govCut;
            }
        }
        _mintBatch(companyId, c, to, qty);
    }

    function _mintBatch(uint256 companyId, Company storage c, address to, uint256 qty) internal {
        if (qty == 0) return;
        uint256 ordinal = c.sharesIssued;
        uint256 tokenId = nextTokenId;
        for (uint256 s = 0; s < qty; s++) {
            ordinal++;
            shareInfo[tokenId] = (companyId << 128) | ordinal;
            _mint(to, tokenId); // no receiver callback: a contract can't block settlement
            tokenId++;
        }
        nextTokenId = tokenId;
        c.sharesIssued = ordinal;
        _addHolding(companyId, to, qty);
    }

    // ---------------------------------------------------------------------
    // Share balances, current and historical
    // ---------------------------------------------------------------------

    function shareCompany(uint256 tokenId) public view returns (uint256) {
        return shareInfo[tokenId] >> 128;
    }

    function shareOrdinal(uint256 tokenId) public view returns (uint256) {
        return shareInfo[tokenId] & type(uint128).max;
    }

    function companyShareCount(uint256 companyId, address holder) public view returns (uint256) {
        return holdingHistory[companyId][holder].latest();
    }

    /// @notice Shares `holder` held in `companyId` at the end of second `ts`.
    function shareCountAt(uint256 companyId, address holder, uint256 ts) external view returns (uint256) {
        return holdingHistory[companyId][holder].upperLookupRecent(uint48(ts));
    }

    /// @notice Shares of `companyId` issued as of the end of second `ts`.
    function sharesIssuedAt(uint256 companyId, uint256 ts) external view returns (uint256) {
        return issuedHistory[companyId].upperLookupRecent(uint48(ts));
    }

    function _addHolding(uint256 companyId, address holder, uint256 qty) internal {
        Checkpoints.Trace208 storage h = holdingHistory[companyId][holder];
        h.push(uint48(block.timestamp), h.latest() + uint208(qty));
    }

    function _subHolding(uint256 companyId, address holder, uint256 qty) internal {
        Checkpoints.Trace208 storage h = holdingHistory[companyId][holder];
        h.push(uint48(block.timestamp), h.latest() - uint208(qty));
    }

    /// @dev Transfer lock (LOCK_PERIOD after a company's first mint, plus
    /// the governor-compensation term lock), and balance history upkeep.
    /// Mints skip this branch; their history is written once per batch.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            uint256 companyId = shareCompany(tokenId);
            require(block.timestamp >= companies[companyId].firstMintedAt + LOCK_PERIOD, "RA: shares still locked");
            uint256 requiredTerm = compensationUnlockTerm[tokenId];
            if (requiredTerm > 0) {
                require(governance.termNumber(compensationOriginCompany[tokenId]) >= requiredTerm, "RA: comp shares locked");
            }
            _subHolding(companyId, from, 1);
            _addHolding(companyId, to, 1);
        }
        return super._update(to, tokenId, auth);
    }

    // ---------------------------------------------------------------------
    // Share market
    // ---------------------------------------------------------------------

    struct Listing {
        uint256 tokenId;
        address seller;
        uint256 price;
        bool active;
        bool isCorporateSale;
        uint256 creditCompanyId;
    }
    mapping(uint256 => Listing) public listings;
    uint256 public nextListingId;

    event ShareListed(uint256 indexed listingId, uint256 indexed tokenId, address indexed seller, uint256 price);
    event ShareSold(uint256 indexed listingId, uint256 indexed tokenId, address seller, address buyer, uint256 price);
    event ListingCancelled(uint256 indexed listingId);

    function listShare(uint256 tokenId, uint256 price) external {
        require(ownerOf(tokenId) == msg.sender, "RA: not the owner");
        _list(tokenId, msg.sender, price, false, 0);
    }

    function governorListShare(uint256 ownerCompanyId, uint256 tokenId, uint256 price) external onlyGovernor(ownerCompanyId) {
        address corp = corporateHolder(ownerCompanyId);
        require(ownerOf(tokenId) == corp, "RA: org lacks share");
        _list(tokenId, corp, price, true, ownerCompanyId);
    }

    function _list(uint256 tokenId, address seller, uint256 price, bool corp, uint256 creditId) internal {
        require(price > 0, "RA: price must be > 0");
        require(block.timestamp >= companies[shareCompany(tokenId)].firstMintedAt + LOCK_PERIOD, "RA: still locked");
        listings[nextListingId] = Listing(tokenId, seller, price, true, corp, creditId);
        emit ShareListed(nextListingId, tokenId, seller, price);
        nextListingId++;
    }

    /// @notice A listing is only valid while its seller still owns the
    /// share; a stale or duplicate listing simply fails here.
    function buyShare(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "RA: not active");
        require(ownerOf(l.tokenId) == l.seller, "RA: seller no longer owns share");
        l.active = false;
        investToken.transferFrom(msg.sender, address(this), l.price);
        if (l.isCorporateSale) {
            companies[l.creditCompanyId].capital += l.price;
        } else {
            investToken.transfer(l.seller, l.price);
        }
        // auth = 0: the corporate holder has no key to approve; ownership
        // was checked above, and _update still enforces every lock.
        _update(msg.sender, l.tokenId, address(0));
        emit ShareSold(listingId, l.tokenId, l.seller, msg.sender, l.price);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "RA: not active");
        if (l.isCorporateSale) {
            require(msg.sender == governance.governorOperatingKey(l.creditCompanyId), "RA: not operating key");
        } else {
            require(msg.sender == l.seller, "RA: not seller");
        }
        l.active = false;
        emit ListingCancelled(listingId);
    }

    /// @dev Synthetic, keyless address standing for a company as a
    /// shareholder in another company. Same namespace as v7.
    function corporateHolder(uint256 companyId) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("SOVEREIGN_LOTS_CORP_ROUND", companyId)))));
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "RA: nonexistent token");
        Company storage c = companies[shareCompany(tokenId)];
        string memory ord = Strings.toString(shareOrdinal(tokenId));
        string memory total = Strings.toString(c.totalShares);
        string memory svg = string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">',
            '<rect width="400" height="400" fill="#141B18"/>',
            '<circle cx="200" cy="180" r="130" fill="none" stroke="#C98A3E" stroke-width="8"/>',
            '<text x="200" y="140" font-family="serif" font-weight="bold" font-size="22" fill="#EDE6D6" text-anchor="middle">', c.name, '</text>',
            '<text x="200" y="190" font-family="monospace" font-size="18" fill="#C98A3E" text-anchor="middle">SHARE ', ord, ' OF ', total, '</text>',
            '<text x="200" y="360" font-family="monospace" font-size="10" fill="#EDE6D6" opacity="0.5" text-anchor="middle">FICTIONAL SIMULATION - NOT A REAL FINANCIAL PRODUCT</text>',
            '</svg>'
        ));
        string memory json = string(abi.encodePacked(
            '{"name":"', c.name, ' - Share ', ord, '/', total, '",',
            '"description":"Sovereign Share NFT from a fictional privatization simulation (Round Auction). Not a real financial product, security, or claim on any real-world asset.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '"}'
        ));
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }
}
