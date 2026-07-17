// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./InvestToken.sol";

/// @title ShareAuction
/// @notice Lists companies for auction. Anyone can bid INVEST on a company's
/// share pool before the deadline. When finalized, the top N bidders (N =
/// totalShares) each mint one Share NFT and pay their own bid (pay-as-bid,
/// multi-unit, sealed until finalize). Everyone else is refunded in full.
/// Minted shares are locked and cannot be transferred until LOCK_PERIOD has
/// passed — mirroring "governance before liquidity" in the white paper.
///
/// NOTE: finalize() sorts bids on-chain with an O(n^2) insertion sort. This
/// is fine for a demo/testnet with a small number of bidders per company. A
/// production deployment at national scale would move sorting off-chain and
/// settle via a Merkle-proof claim contract instead.
contract ShareAuction is ERC721, Ownable {
    InvestToken public immutable investToken;
    uint256 public nextTokenId;
    uint256 public constant LOCK_PERIOD = 7 days;

    /// @notice Every winning bid is split at settlement: 99% capitalizes the
    /// company (stays locked in this contract, spendable only by whatever
    /// governance takes over the company later), 1% accrues to the host.
    uint256 public constant HOST_FEE_BPS = 100; // 100 / 10000 = 1%
    address public host;
    uint256 public hostFeeAccrued;

    struct Company {
        string name;
        uint256 totalShares;
        uint256 sharesIssued;
        uint256 auctionEnd;
        uint256 mintedAt; // set at finalize(); starts the transfer lock
        bool finalized;
        uint256 capital; // the 99% pool raised for this company
    }

    struct Bid {
        address bidder;
        uint256 amount;
    }

    mapping(uint256 => Company) public companies;
    mapping(uint256 => Bid[]) public bids;
    mapping(uint256 => uint256) public shareCompany; // tokenId => companyId
    mapping(uint256 => mapping(address => uint256)) public companyShareCount; // companyId => holder => shares held

    /// @notice Governance-before-liquidity: once a company sells out, its
    /// shareholders (weighted 1 share = 1 vote) elect a governor who can then
    /// spend the company's 99% capital pool — reinvest it into another
    /// company's live auction ("buy"), or pay it back out to current
    /// shareholders as a dividend ("sell"/liquidate a position).
    uint256 public constant GOVERNANCE_VOTE_WINDOW = 3 days;
    mapping(uint256 => uint256) public governanceVoteEnd; // 0 = not opened yet
    mapping(uint256 => mapping(address => uint256)) public votes; // companyId => candidate => weight
    mapping(uint256 => mapping(address => bool)) public hasVoted; // companyId => voter => voted
    mapping(uint256 => address) public leadingCandidate;
    mapping(uint256 => uint256) public leadingVotes;
    mapping(uint256 => address) public companyGovernor;

    event CompanyListed(uint256 indexed companyId, string name, uint256 totalShares, uint256 auctionEnd);
    event BidPlaced(uint256 indexed companyId, address indexed bidder, uint256 amount);
    event AuctionFinalized(uint256 indexed companyId, uint256 winningShares, uint256 clearingPrice, uint256 capitalRaised, uint256 hostFee);
    event HostFeesWithdrawn(address indexed host, uint256 amount);
    event HostSet(address indexed host);
    event GovernanceOpened(uint256 indexed companyId, uint256 voteEnd);
    event Voted(uint256 indexed companyId, address indexed voter, address indexed candidate, uint256 weight);
    event GovernorElected(uint256 indexed companyId, address indexed governor, uint256 winningVotes);
    event CorporateInvestment(uint256 indexed fromCompanyId, uint256 indexed toCompanyId, uint256 amount);
    event DividendDistributed(uint256 indexed companyId, uint256 totalAmount);

    constructor(address _investToken) ERC721("Sovereign Share", "SHARE") Ownable(msg.sender) {
        investToken = InvestToken(_investToken);
        host = msg.sender;
    }

    function setHost(address _host) external onlyOwner {
        require(_host != address(0), "ShareAuction: zero address");
        host = _host;
        emit HostSet(_host);
    }

    /// @notice Pulls the accrued 1% host fee out to `host`. Works directly —
    /// InvestToken lets the auction house pay funds out freely, it only
    /// restricts citizens spending their own balance elsewhere.
    function withdrawHostFees() external {
        require(msg.sender == host, "ShareAuction: not host");
        uint256 amount = hostFeeAccrued;
        require(amount > 0, "ShareAuction: nothing to withdraw");
        hostFeeAccrued = 0;
        investToken.transfer(host, amount);
        emit HostFeesWithdrawn(host, amount);
    }

    function listCompany(
        uint256 companyId,
        string calldata name,
        uint256 totalShares,
        uint256 durationSeconds
    ) external onlyOwner {
        require(companies[companyId].totalShares == 0, "ShareAuction: already listed");
        require(totalShares > 0, "ShareAuction: no shares");
        uint256 end = block.timestamp + durationSeconds;
        companies[companyId] = Company(name, totalShares, 0, end, 0, false, 0);
        emit CompanyListed(companyId, name, totalShares, end);
    }

    /// @notice Locks `amount` INVEST into this contract as a bid. A bidder
    /// may call this multiple times to raise their own standing bid.
    function placeBid(uint256 companyId, uint256 amount) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "ShareAuction: unknown company");
        require(block.timestamp < c.auctionEnd, "ShareAuction: auction closed");
        require(amount > 0, "ShareAuction: bid must be > 0");
        investToken.transferFrom(msg.sender, address(this), amount);
        bids[companyId].push(Bid(msg.sender, amount));
        emit BidPlaced(companyId, msg.sender, amount);
    }

    function finalize(uint256 companyId) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "ShareAuction: unknown company");
        require(block.timestamp >= c.auctionEnd, "ShareAuction: still open");
        require(!c.finalized, "ShareAuction: already finalized");
        c.finalized = true;
        c.mintedAt = block.timestamp;

        Bid[] storage b = bids[companyId];
        for (uint256 i = 1; i < b.length; i++) {
            Bid memory key = b[i];
            uint256 j = i;
            while (j > 0 && b[j - 1].amount < key.amount) {
                b[j] = b[j - 1];
                j--;
            }
            b[j] = key;
        }

        uint256 winners = c.totalShares < b.length ? c.totalShares : b.length;
        uint256 clearing = winners > 0 ? b[winners - 1].amount : 0;
        uint256 roundHostFee = 0;
        uint256 roundCapital = 0;

        for (uint256 i = 0; i < b.length; i++) {
            if (i < winners) {
                uint256 tokenId = nextTokenId++;
                _safeMint(b[i].bidder, tokenId);
                shareCompany[tokenId] = companyId;
                c.sharesIssued++;
                companyShareCount[companyId][b[i].bidder]++;

                uint256 fee = (b[i].amount * HOST_FEE_BPS) / 10_000;
                uint256 capitalCut = b[i].amount - fee;
                roundHostFee += fee;
                roundCapital += capitalCut;
                // Both cuts stay inside this contract's INVEST balance — the
                // capital cut is now the company's, the fee cut is the
                // host's, tracked separately below.
            } else {
                investToken.transfer(b[i].bidder, b[i].amount);
            }
        }
        c.capital += roundCapital;
        hostFeeAccrued += roundHostFee;
        emit AuctionFinalized(companyId, winners, clearing, roundCapital, roundHostFee);
    }

    /// @dev Blocks transfer of any share until its company's lock period has
    /// elapsed since finalize(). Minting (from == 0) is always allowed. Also
    /// keeps companyShareCount accurate so governance votes always reflect
    /// who currently holds shares, not just who originally won them.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        uint256 companyId = shareCompany[tokenId];
        if (from != address(0) && to != address(0)) {
            Company storage c = companies[companyId];
            require(block.timestamp >= c.mintedAt + LOCK_PERIOD, "ShareAuction: shares still locked");
            companyShareCount[companyId][from]--;
            companyShareCount[companyId][to]++;
        }
        return super._update(to, tokenId, auth);
    }

    // ---------------------------------------------------------------------
    // Governance: elect a governor, then buy (invest in another company's
    // auction) or sell (distribute capital back to shareholders as dividend)
    // ---------------------------------------------------------------------

    function openGovernanceVote(uint256 companyId) external {
        Company storage c = companies[companyId];
        require(c.finalized, "ShareAuction: not finalized");
        require(governanceVoteEnd[companyId] == 0, "ShareAuction: already open");
        governanceVoteEnd[companyId] = block.timestamp + GOVERNANCE_VOTE_WINDOW;
        emit GovernanceOpened(companyId, governanceVoteEnd[companyId]);
    }

    /// @notice One vote per shareholder wallet, weighted by how many shares
    /// of THIS company they currently hold. Sybil note: this is naturally
    /// harder to farm than the citizen allocation itself, because a vote's
    /// weight is proportional to real capital actually committed at auction
    /// — spinning up extra wallets only helps an attacker if they can also
    /// fund each one with a full winning bid, not just a free claim.
    function vote(uint256 companyId, address candidate) external {
        require(governanceVoteEnd[companyId] != 0 && block.timestamp < governanceVoteEnd[companyId], "ShareAuction: voting closed");
        require(!hasVoted[companyId][msg.sender], "ShareAuction: already voted");
        uint256 weight = companyShareCount[companyId][msg.sender];
        require(weight > 0, "ShareAuction: not a shareholder");
        hasVoted[companyId][msg.sender] = true;
        votes[companyId][candidate] += weight;
        if (votes[companyId][candidate] > leadingVotes[companyId]) {
            leadingVotes[companyId] = votes[companyId][candidate];
            leadingCandidate[companyId] = candidate;
        }
        emit Voted(companyId, msg.sender, candidate, weight);
    }

    function finalizeGovernance(uint256 companyId) external {
        require(governanceVoteEnd[companyId] != 0 && block.timestamp >= governanceVoteEnd[companyId], "ShareAuction: voting still open");
        require(companyGovernor[companyId] == address(0), "ShareAuction: governor already set");
        companyGovernor[companyId] = leadingCandidate[companyId];
        emit GovernorElected(companyId, leadingCandidate[companyId], leadingVotes[companyId]);
    }

    modifier onlyGovernor(uint256 companyId) {
        require(msg.sender == companyGovernor[companyId], "ShareAuction: not governor");
        _;
    }

    /// @notice BUY: the governor commits this company's capital as a bid
    /// into another company's still-open auction — one company taking a
    /// stake in another, the way a real conglomerate would.
    function invest(uint256 fromCompanyId, uint256 toCompanyId, uint256 amount) external onlyGovernor(fromCompanyId) {
        Company storage from = companies[fromCompanyId];
        require(from.capital >= amount, "ShareAuction: insufficient capital");
        Company storage to = companies[toCompanyId];
        require(to.totalShares > 0, "ShareAuction: unknown target company");
        require(block.timestamp < to.auctionEnd, "ShareAuction: target auction closed");
        from.capital -= amount;
        address corpBidder = corporateHolder(fromCompanyId);
        bids[toCompanyId].push(Bid(corpBidder, amount));
        emit CorporateInvestment(fromCompanyId, toCompanyId, amount);
    }

    /// @notice SELL / liquidate: the governor pays capital back out to a
    /// given list of current shareholders, pro-rata to shares held. Solidity
    /// can't iterate "everyone who holds a share" on its own, so the caller
    /// supplies the holder list (e.g. from off-chain indexing of Transfer
    /// events) — anyone not included simply isn't paid this round.
    function distribute(uint256 companyId, address[] calldata holders, uint256 amount) external onlyGovernor(companyId) {
        Company storage c = companies[companyId];
        require(c.capital >= amount, "ShareAuction: insufficient capital");
        require(c.sharesIssued > 0, "ShareAuction: no shares issued");
        c.capital -= amount;
        for (uint256 i = 0; i < holders.length; i++) {
            uint256 held = companyShareCount[companyId][holders[i]];
            if (held == 0) continue;
            uint256 cut = (amount * held) / c.sharesIssued;
            if (cut > 0) investToken.transfer(holders[i], cut);
        }
        emit DividendDistributed(companyId, amount);
    }

    /// @dev A synthetic, non-transferable "address" representing a company's
    /// own treasury as a shareholder in another company. Cross-holdings are
    /// tracked the same way any wallet's shares are (companyShareCount,
    /// shareCompany) so the corporate holder can vote in the target
    /// company's governance too, just like a real parent/subsidiary stake.
    function corporateHolder(uint256 companyId) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("SOVEREIGN_LOTS_CORP", companyId)))));
    }
}
