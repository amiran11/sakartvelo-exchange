// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
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
    using SafeERC20 for IERC20;

    /// @notice This is a fictional virtual-state simulation. Any resemblance
    /// to real countries, governments, companies, agencies, or assets is
    /// fictional and exists solely as a gamified rule-set. Nothing here is a
    /// real financial product, security, or claim on any real-world asset.
    string public constant DISCLAIMER = "FICTIONAL SIMULATION. Not a real financial product, security, or claim on any real-world asset. Any resemblance to real entities is a gamified rule-set only.";

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
    mapping(uint256 => uint256) public shareOrdinal; // tokenId => which share # of its company (1-indexed)
    mapping(uint256 => mapping(address => uint256)) public companyShareCount; // companyId => holder => shares held

    /// @notice How many companies have been listed vs. finalized, so
    /// InvestToken can ask "does the state still have shares to sell?"
    /// instead of relying on a fixed headcount. Once every listed company
    /// is finalized, privatizationConcluded() flips true and claim() stops
    /// minting new allocations — matching the white paper's rule that
    /// Invest is distributed "until the privatization process is concluded."
    ///
    /// CAVEAT: this assumes every company you intend to privatize gets
    /// listed before any of them finalize. If you plan to list companies in
    /// waves (list a few, finalize them, list more later), this will flip
    /// "concluded" between waves and pause claiming prematurely — list
    /// everything up front, or don't rely on this signal for a staged
    /// rollout.
    uint256 public companiesListed;
    uint256 public companiesFinalized;

    /// @notice Governance-before-liquidity, now a real election instead of a
    /// single vote: once a company is at least half-assigned, shareholders
    /// can declare candidacy with a short program; shareholders then vote in
    /// rounds until someone clears 51% of votes CAST that round (a runoff —
    /// if nobody clears the bar, every candidate except the top two is
    /// eliminated and another round opens). The elected governor holds
    /// office for one term, then a fresh election has to run — a new
    /// person, a new address, controls the company next.
    uint256 public constant GOVERNANCE_VOTE_WINDOW = 3 days;
    uint256 public constant TERM_LENGTH = 30 days;
    uint256 public constant MAX_PROGRAM_BYTES = 4500; // ~700 words, practical proxy — see declareCandidacy()
    uint256 public constant ELECTION_THRESHOLD_BPS = 5100; // 51%

    struct Candidate {
        string program;
        bool registered;
    }
    mapping(uint256 => mapping(address => Candidate)) public candidates; // companyId => candidate => Candidate
    mapping(uint256 => address[]) public candidateList; // companyId => all candidates ever declared, in order
    mapping(uint256 => mapping(address => bool)) public eliminated; // companyId => candidate => out of the running this term

    mapping(uint256 => uint256) public governanceRound; // companyId => current round, 0 = not started
    mapping(uint256 => uint256) public governanceVoteEnd; // companyId => this round's deadline
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public roundVotes; // companyId => round => candidate => weight
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public roundHasVoted; // companyId => round => voter => voted
    mapping(uint256 => mapping(uint256 => uint256)) public roundTotalVotesCast; // companyId => round => total weight cast

    mapping(uint256 => address) public companyGovernor;
    mapping(uint256 => uint256) public governorTermEnd; // companyId => timestamp the current governor's authority expires
    mapping(uint256 => uint256) public termNumber; // companyId => how many governors have ever served, counting the current one

    /// @notice The elected candidate's own wallet is their real-world
    /// identity, not necessarily the key that should hold day-to-day
    /// operating power. Each newly-installed governor must call
    /// setOperatingKey() once to register a fresh keypair for this term
    /// specifically — a genuinely new public/private key controlling the
    /// company, distinct from the officeholder's personal wallet, and
    /// automatically worthless once the term ends (a new term always
    /// starts with this reset to address(0), forcing a fresh key again).
    mapping(uint256 => address) public governorOperatingKey;

    /// @notice A mandatory shareholder vote that runs once a governor's term
    /// is over (1% dividend or reinvest) lives in CompanyTreasury now, along
    /// with multi-asset custody, the treasury commit-reveal auction, the
    /// vendor payment vote, and the INVEST secondary market — all split out
    /// purely because this contract's deployed bytecode exceeded Ethereum's
    /// 24,576-byte limit (EIP-170) once that functionality lived here too.
    /// ShareAuction still archives when each term ended (below), since
    /// CompanyTreasury's policy vote needs that timestamp and only
    /// ShareAuction knows it (it's set the moment the next governor is
    /// installed, in _installGovernor).
    mapping(uint256 => mapping(uint256 => uint256)) public termEndedAt; // companyId => term => when that term's governorTermEnd was

    /// @notice The only contract allowed to move a company's INVEST capital
    /// on CompanyTreasury's behalf (dividends, treasury auction proceeds,
    /// vendor payments, the INVEST market) — set once after deploying
    /// CompanyTreasury. Everything else that touches `capital` (invest(),
    /// governorListShare(), the primary auction's 99% split) still does so
    /// directly, since it never left this contract.
    address public treasury;

    /// @notice Post-lock secondary market for Share NFTs. A citizen who
    /// owns a share can list it; anyone can buy it for INVEST. Stays here
    /// (rather than moving to CompanyTreasury with everything else) because
    /// it moves actual NFTs, which only this ERC-721 contract can do.
    struct Listing {
        uint256 tokenId;
        address seller;
        uint256 price;
        bool active;
        bool isCorporateSale; // true if this is an organization selling a cross-held share (see governorListShare)
        uint256 creditCompanyId; // meaningful only when isCorporateSale is true
    }
    mapping(uint256 => Listing) public listings;
    uint256 public nextListingId;

    event CompanyListed(uint256 indexed companyId, string name, uint256 totalShares, uint256 auctionEnd);
    event BidPlaced(uint256 indexed companyId, address indexed bidder, uint256 amount);
    event AuctionFinalized(uint256 indexed companyId, uint256 winningShares, uint256 clearingPrice, uint256 capitalRaised, uint256 hostFee);
    event HostFeesWithdrawn(address indexed host, uint256 amount);
    event HostSet(address indexed host);
    event GovernanceOpened(uint256 indexed companyId, uint256 voteEnd);
    event CandidateDeclared(uint256 indexed companyId, address indexed candidate, string program);
    event Voted(uint256 indexed companyId, uint256 indexed round, address indexed voter, address candidate, uint256 weight);
    event RoundAdvanced(uint256 indexed companyId, uint256 newRound, address firstPlace, address secondPlace);
    event GovernorElected(uint256 indexed companyId, address indexed governor, uint256 winningVotes, uint256 termEnd);
    event NewTermStarted(uint256 indexed companyId);
    event OperatingKeySet(uint256 indexed companyId, address indexed governor, address indexed operatingKey);
    event TreasurySet(address indexed treasury);
    event CorporateInvestment(uint256 indexed fromCompanyId, uint256 indexed toCompanyId, uint256 amount);
    event ShareListed(uint256 indexed listingId, uint256 indexed tokenId, address indexed seller, uint256 price);
    event ShareSold(uint256 indexed listingId, uint256 indexed tokenId, address seller, address buyer, uint256 price);
    event ListingCancelled(uint256 indexed listingId);

    constructor(address _investToken) ERC721("Sovereign Share", "SHARE") Ownable(msg.sender) {
        investToken = InvestToken(_investToken);
        host = msg.sender;
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "ShareAuction: zero address");
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    modifier onlyTreasury() {
        require(msg.sender == treasury, "ShareAuction: not treasury");
        _;
    }

    /// @notice The only way a company's INVEST capital changes from outside
    /// this contract — restricted to the registered CompanyTreasury address.
    /// A positive delta credits capital (auction/vendor-payment proceeds); a
    /// negative one debits it (dividends, buying INVEST market offers).
    function adjustCapital(uint256 companyId, int256 delta) external onlyTreasury {
        if (delta >= 0) {
            companies[companyId].capital += uint256(delta);
        } else {
            uint256 dec = uint256(-delta);
            require(companies[companyId].capital >= dec, "ShareAuction: capital underflow");
            companies[companyId].capital -= dec;
        }
    }

    function setHost(address _host) external onlyOwner {
        require(_host != address(0), "ShareAuction: zero address");
        host = _host;
        emit HostSet(_host);
    }

    /// @notice False until at least one company has been listed; true once
    /// every listed company has been finalized (sold out or its auction
    /// settled). This is what InvestToken checks before minting a new
    /// citizen allocation.
    function privatizationConcluded() external view returns (bool) {
        return companiesListed > 0 && companiesFinalized >= companiesListed;
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
        companiesListed++;
        emit CompanyListed(companyId, name, totalShares, end);
    }

    event CompanyRelisted(uint256 indexed companyId, uint256 auctionEnd);

    /// @notice If a listed company's auction closed with ZERO winning bids
    /// (sharesIssued == 0 after finalize()), the owner can reopen the same
    /// companyId for a fresh round instead of it being permanently stuck —
    /// confirmed live, twice in one testing session, that finalize()'s
    /// unconditional one-shot settlement had no retry path at all, which
    /// doesn't match how a real privatization process should behave when
    /// an asset draws no bids.
    ///
    /// Deliberately narrow: only callable when sharesIssued == 0. A
    /// company with ANY real winners can never be relisted this way —
    /// reopening bidding on something citizens already hold shares in
    /// would dilute real ownership, a completely different and much worse
    /// problem than the one this fixes. Safe to skip clearing bids[]:
    /// sharesIssued == 0 can only happen if the bids array was genuinely
    /// empty at finalization (winners = min(totalShares, bids.length),
    /// and totalShares is always > 0 by listCompany's own require) — so
    /// there is nothing left over to refund or clean up.
    function relistIfUnfilled(uint256 companyId, uint256 durationSeconds) external onlyOwner {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "ShareAuction: unknown company");
        require(c.finalized, "ShareAuction: not finalized yet");
        require(c.sharesIssued == 0, "ShareAuction: has real winners, cannot relist");
        c.finalized = false;
        c.auctionEnd = block.timestamp + durationSeconds;
        c.mintedAt = 0;
        companiesFinalized--;
        emit CompanyRelisted(companyId, c.auctionEnd);
    }

    /// @notice The only floor placeBid() used to enforce was "> 0" —
    /// meaning a bid could be a single wei-unit, 0.000000000000000001
    /// INVEST. That gap is real, not academic: since bid COUNT (not bid
    /// VALUE) is what drives finalize()'s O(n^2) sorting cost, someone
    /// could split a modest budget into an enormous number of near-zero
    /// bids and push a company's gas cost past the block limit, making it
    /// permanently unfinalizable — with a full 1000-INVEST citizen
    /// allocation, that was never actually blocked by "everyone only gets
    /// 1000 INVEST" the way it might have seemed to.
    uint256 public constant MIN_BID = 1 * 10 ** 18; // 1 whole INVEST

    /// @notice Hard ceiling on total bids ever placed for a single company.
    /// MIN_BID alone stops someone splitting a budget into unlimited
    /// near-zero bids, but even at 1 INVEST minimum, enough distinct
    /// bidders (or one bidder calling repeatedly) can still push bid
    /// COUNT past what finalize()'s O(n^2) sort can process in one block
    /// — and unlike a bad bid, there is no recovery from that: finalize()
    /// would revert identically on every retry, forever, with every
    /// bidder's INVEST stuck. 500 is comfortably below where that sort
    /// becomes a real risk on Arbitrum, while remaining far above what any
    /// real single-company auction is expected to draw.
    uint256 public constant MAX_BIDS = 500;

    /// @notice Locks `amount` INVEST into this contract as a bid. A bidder
    /// may call this multiple times to raise their own standing bid.
    function placeBid(uint256 companyId, uint256 amount) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "ShareAuction: unknown company");
        require(block.timestamp < c.auctionEnd, "ShareAuction: auction closed");
        require(amount >= MIN_BID, "ShareAuction: bid below minimum (1 INVEST)");
        require(bids[companyId].length < MAX_BIDS, "ShareAuction: bid cap reached for this company");
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
        companiesFinalized++;

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
                shareOrdinal[tokenId] = c.sharesIssued; // 1-indexed: "share N of totalShares"
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
    // Governance: declare candidacy, run a runoff election, install a
    // time-limited governor, then buy/sell/hold assets through them.
    // ---------------------------------------------------------------------

    /// @notice Opens candidacy + voting once at least half the company's
    /// shares have real owners (c.sharesIssued * 2 >= c.totalShares) — no
    /// need to wait for a company to fully sell out. Requires the company
    /// to be finalized first, since sharesIssued is only known for certain
    /// after finalize() runs (auctions here settle in one shot, not
    /// incrementally lot-by-lot the way the companion game does).
    function openGovernanceVote(uint256 companyId) external {
        Company storage c = companies[companyId];
        require(c.finalized, "ShareAuction: not finalized");
        require(c.sharesIssued * 2 >= c.totalShares, "ShareAuction: fewer than 50% of shares assigned");
        require(governanceRound[companyId] == 0, "ShareAuction: already open");
        require(candidateList[companyId].length > 0, "ShareAuction: no candidates yet");
        governanceRound[companyId] = 1;
        governanceVoteEnd[companyId] = block.timestamp + GOVERNANCE_VOTE_WINDOW;
        emit GovernanceOpened(companyId, governanceVoteEnd[companyId]);
    }

    /// @notice Any current shareholder of this company can put themselves
    /// forward, once the 50% threshold is met, with a short program.
    /// MAX_PROGRAM_BYTES is a byte-length cap, not a literal word counter —
    /// Solidity can't count words cheaply on-chain, so ~4500 bytes is used
    /// as a practical stand-in for "~700 words." Enforcing an exact word
    /// count would need it checked off-chain before submission instead.
    function declareCandidacy(uint256 companyId, string calldata program) external {
        Company storage c = companies[companyId];
        require(c.finalized, "ShareAuction: not finalized");
        require(c.sharesIssued * 2 >= c.totalShares, "ShareAuction: fewer than 50% of shares assigned");
        require(companyShareCount[companyId][msg.sender] > 0, "ShareAuction: not a shareholder");
        require(bytes(program).length <= MAX_PROGRAM_BYTES, "ShareAuction: program too long (~700 words max)");
        require(!candidates[companyId][msg.sender].registered, "ShareAuction: already a candidate");
        candidates[companyId][msg.sender] = Candidate(program, true);
        candidateList[companyId].push(msg.sender);
        emit CandidateDeclared(companyId, msg.sender, program);
    }

    /// @notice One vote per shareholder wallet per round, weighted by shares
    /// of THIS company currently held.
    function vote(uint256 companyId, address candidate) external {
        uint256 round = governanceRound[companyId];
        require(round > 0, "ShareAuction: voting not open");
        require(block.timestamp < governanceVoteEnd[companyId], "ShareAuction: voting closed");
        require(candidates[companyId][candidate].registered, "ShareAuction: not a candidate");
        require(!eliminated[companyId][candidate], "ShareAuction: candidate eliminated");
        require(!roundHasVoted[companyId][round][msg.sender], "ShareAuction: already voted this round");
        uint256 weight = companyShareCount[companyId][msg.sender];
        require(weight > 0, "ShareAuction: not a shareholder");
        roundHasVoted[companyId][round][msg.sender] = true;
        roundVotes[companyId][round][candidate] += weight;
        roundTotalVotesCast[companyId][round] += weight;
        emit Voted(companyId, round, msg.sender, candidate, weight);
    }

    /// @notice corporateHolder(fromCompanyId) has no private key — nothing
    /// can ever sign a transaction as it, since it's a synthetic address
    /// computed purely so the NFT standard has something to point
    /// ownerOf() at (see corporateHolder() below). That meant a real,
    /// counted stake — shares one company holds in another via invest() —
    /// contributed to a target company's 50%-assigned governance
    /// threshold but could never actually cast a vote, permanently inert.
    /// This closes that gap: the INVESTING company's own governor, using
    /// their real operating key, casts the vote on behalf of whatever
    /// weight their corporateHolder actually holds in the target company —
    /// same underlying vote-tracking state as vote() above, just keyed by
    /// the corporate address instead of msg.sender directly.
    function voteAsCorporation(uint256 fromCompanyId, uint256 toCompanyId, address candidate) external onlyGovernor(fromCompanyId) {
        uint256 round = governanceRound[toCompanyId];
        require(round > 0, "ShareAuction: voting not open");
        require(block.timestamp < governanceVoteEnd[toCompanyId], "ShareAuction: voting closed");
        require(candidates[toCompanyId][candidate].registered, "ShareAuction: not a candidate");
        require(!eliminated[toCompanyId][candidate], "ShareAuction: candidate eliminated");
        address corp = corporateHolder(fromCompanyId);
        require(!roundHasVoted[toCompanyId][round][corp], "ShareAuction: already voted this round");
        uint256 weight = companyShareCount[toCompanyId][corp];
        require(weight > 0, "ShareAuction: no shares held there");
        roundHasVoted[toCompanyId][round][corp] = true;
        roundVotes[toCompanyId][round][candidate] += weight;
        roundTotalVotesCast[toCompanyId][round] += weight;
        emit Voted(toCompanyId, round, corp, candidate, weight);
    }

    /// @notice Callable by anyone once the round's window has closed. Elects
    /// the governor if someone cleared 51% of votes cast this round.
    /// Otherwise this is a runoff: every candidate except the current top
    /// two gets eliminated and a fresh round opens — repeat until someone
    /// clears the bar. Once only two (or fewer) candidates remain and there's
    /// still no 51% majority, the round's plurality leader wins outright
    /// rather than looping on a possible exact tie forever.
    function tallyRound(uint256 companyId) external {
        uint256 round = governanceRound[companyId];
        require(round > 0, "ShareAuction: voting not open");
        require(block.timestamp >= governanceVoteEnd[companyId], "ShareAuction: voting still open");
        require(companyGovernor[companyId] == address(0), "ShareAuction: governor already set");

        address[] storage list = candidateList[companyId];
        address first = address(0);
        address second = address(0);
        uint256 firstVotes = 0;
        uint256 secondVotes = 0;
        uint256 remaining = 0;
        for (uint256 i = 0; i < list.length; i++) {
            address cand = list[i];
            if (eliminated[companyId][cand]) continue;
            remaining++;
            uint256 v = roundVotes[companyId][round][cand];
            if (v > firstVotes) {
                second = first; secondVotes = firstVotes;
                first = cand; firstVotes = v;
            } else if (v > secondVotes) {
                second = cand; secondVotes = v;
            }
        }

        uint256 totalCast = roundTotalVotesCast[companyId][round];
        bool clearedMajority = totalCast > 0 && firstVotes * 10_000 >= totalCast * ELECTION_THRESHOLD_BPS;

        if (clearedMajority || remaining <= 2) {
            require(first != address(0), "ShareAuction: no votes cast");
            _installGovernor(companyId, first, firstVotes);
            return;
        }

        // Runoff: eliminate everyone except the top two, open another round.
        for (uint256 i = 0; i < list.length; i++) {
            address cand = list[i];
            if (!eliminated[companyId][cand] && cand != first && cand != second) {
                eliminated[companyId][cand] = true;
            }
        }
        governanceRound[companyId] = round + 1;
        governanceVoteEnd[companyId] = block.timestamp + GOVERNANCE_VOTE_WINDOW;
        emit RoundAdvanced(companyId, round + 1, first, second);
    }

    function _installGovernor(uint256 companyId, address winner, uint256 winningVotes) internal {
        if (termNumber[companyId] > 0) {
            termEndedAt[companyId][termNumber[companyId]] = governorTermEnd[companyId];
        }
        termNumber[companyId] += 1;
        companyGovernor[companyId] = winner;
        governorTermEnd[companyId] = block.timestamp + TERM_LENGTH;
        governorOperatingKey[companyId] = address(0); // must be freshly set by the new governor
        emit GovernorElected(companyId, winner, winningVotes, governorTermEnd[companyId]);
    }

    /// @notice The newly-elected governor registers a fresh keypair to
    /// actually operate with this term — generate it client-side (the same
    /// way a citizen wallet gets generated), then call this once from your
    /// real identity wallet to authorize it. Every governor action below
    /// checks this key, not the officeholder's personal wallet directly.
    function setOperatingKey(uint256 companyId, address operatingKey) external {
        require(msg.sender == companyGovernor[companyId], "ShareAuction: not governor");
        require(block.timestamp < governorTermEnd[companyId], "ShareAuction: term expired");
        require(operatingKey != address(0), "ShareAuction: zero address");
        governorOperatingKey[companyId] = operatingKey;
        emit OperatingKeySet(companyId, msg.sender, operatingKey);
    }

    /// @notice Once a governor's term expires, anyone can reset the company
    /// for a new election — clears the old candidate list, vote history,
    /// and governor, so a genuinely fresh cycle runs. This is what makes
    /// "wallet changes and the key changes every election" true in
    /// practice: companyGovernor becomes address(0) again, and whoever wins
    /// the next election is a different real-world wallet, holding a
    /// different private key, controlling the company for the next term —
    /// without physically migrating the company's held assets to a new
    /// contract address, which would be far more expensive and risky than
    /// rotating who's authorized to control the existing one.
    function startNewTerm(uint256 companyId) external {
        require(companyGovernor[companyId] != address(0), "ShareAuction: no sitting governor");
        require(block.timestamp >= governorTermEnd[companyId], "ShareAuction: current term not over");
        address[] storage list = candidateList[companyId];
        for (uint256 i = 0; i < list.length; i++) {
            delete candidates[companyId][list[i]];
            delete eliminated[companyId][list[i]];
        }
        delete candidateList[companyId];
        companyGovernor[companyId] = address(0);
        governorOperatingKey[companyId] = address(0);
        governorTermEnd[companyId] = 0;
        governanceRound[companyId] = 0;
        governanceVoteEnd[companyId] = 0;
        emit NewTermStarted(companyId);
    }

    /// @dev Checks the term's registered OPERATING KEY, not the elected
    /// officeholder's personal wallet — that's the whole point of
    /// setOperatingKey(). Before a governor has set one (right after
    /// election, or if they never bother to), operatingKey is address(0)
    /// and every governor-only action simply reverts until they do.
    modifier onlyGovernor(uint256 companyId) {
        require(msg.sender == governorOperatingKey[companyId], "ShareAuction: not the current operating key");
        require(block.timestamp < governorTermEnd[companyId], "ShareAuction: term expired");
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

    // ---------------------------------------------------------------------
    // Secondary market: the "sell" side. A citizen can list any share they
    // own once it's past its lock period; a governor can list a share their
    // organization holds in another company (a cross-holding built up via
    // invest()) and route the proceeds back into that organization's
    // capital pool instead of to a wallet nobody controls.
    // ---------------------------------------------------------------------

    function listShare(uint256 tokenId, uint256 price) external {
        require(ownerOf(tokenId) == msg.sender, "ShareAuction: not the owner");
        require(price > 0, "ShareAuction: price must be > 0");
        Company storage c = companies[shareCompany[tokenId]];
        require(block.timestamp >= c.mintedAt + LOCK_PERIOD, "ShareAuction: still locked");
        listings[nextListingId] = Listing(tokenId, msg.sender, price, true, false, 0);
        emit ShareListed(nextListingId, tokenId, msg.sender, price);
        nextListingId++;
    }

    /// @notice The governor equivalent of listShare(): lists a share the
    /// organization holds in ANOTHER company (acquired via invest()). The
    /// corporate holder address has no private key, so proceeds can't be
    /// sent to it the normal way — instead a sale credits the capital pool
    /// of the SELLING organization directly. This is the actual "exchange
    /// organization balance assets for other assets" mechanic: invest() is
    /// the buy side, this is the sell side, and both move the same
    /// capital figure that distribute()/reinvest already operate on.
    function governorListShare(uint256 ownerCompanyId, uint256 tokenId, uint256 price) external onlyGovernor(ownerCompanyId) {
        require(ownerOf(tokenId) == corporateHolder(ownerCompanyId), "ShareAuction: organization doesn't hold this share");
        require(price > 0, "ShareAuction: price must be > 0");
        Company storage c = companies[shareCompany[tokenId]];
        require(block.timestamp >= c.mintedAt + LOCK_PERIOD, "ShareAuction: still locked");
        listings[nextListingId] = Listing(tokenId, corporateHolder(ownerCompanyId), price, true, true, ownerCompanyId);
        emit ShareListed(nextListingId, tokenId, corporateHolder(ownerCompanyId), price);
        nextListingId++;
    }

    function buyShare(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "ShareAuction: not active");
        l.active = false;
        investToken.transferFrom(msg.sender, address(this), l.price);
        if (l.isCorporateSale) {
            companies[l.creditCompanyId].capital += l.price;
        } else {
            investToken.transfer(l.seller, l.price);
        }
        // Moves the NFT directly, bypassing per-token approval — the
        // corporate holder has no private key to grant one, and the
        // require()s above already established the caller paid correctly.
        // auth = address(0) skips ERC721's normal ownership/approval check;
        // this _update override still enforces the lock period and keeps
        // companyShareCount accurate on both sides of the trade.
        _update(msg.sender, l.tokenId, address(0));
        emit ShareSold(listingId, l.tokenId, l.seller, msg.sender, l.price);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "ShareAuction: not active");
        if (l.isCorporateSale) {
            require(msg.sender == governorOperatingKey[l.creditCompanyId], "ShareAuction: not the current operating key");
        } else {
            require(msg.sender == l.seller, "ShareAuction: not seller");
        }
        l.active = false;
        emit ListingCancelled(listingId);
    }

    /// @dev A synthetic, non-transferable "address" representing a company's
    /// own treasury as a shareholder in another company. Cross-holdings are
    /// tracked the same way any wallet's shares are (companyShareCount,
    /// shareCompany) so the corporate holder can vote in the target
    /// company's governance too, just like a real parent/subsidiary stake.
    function corporateHolder(uint256 companyId) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("SOVEREIGN_LOTS_CORP", companyId)))));
    }

    /// @notice Fully on-chain metadata and artwork — no external server, no
    /// off-chain image host that could go dark and leave a real, owned
    /// asset showing a blank square forever. Company name, which share
    /// number this is, and how many exist in total are all pulled live
    /// from this contract's own storage, base64-encoded straight into the
    /// token's data URI, the same way the wallet-export flow's "no server,
    /// no account recovery" philosophy already runs through the rest of
    /// this project.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "ShareAuction: nonexistent token");
        uint256 companyId = shareCompany[tokenId];
        Company storage c = companies[companyId];
        uint256 ord = shareOrdinal[tokenId];

        string memory svg = string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">',
            '<rect width="400" height="400" fill="#141B18"/>',
            '<circle cx="200" cy="180" r="130" fill="none" stroke="#C98A3E" stroke-width="8"/>',
            '<text x="200" y="140" font-family="serif" font-weight="bold" font-size="22" fill="#EDE6D6" text-anchor="middle">', c.name, '</text>',
            '<text x="200" y="190" font-family="monospace" font-size="18" fill="#C98A3E" text-anchor="middle">SHARE ', Strings.toString(ord), ' OF ', Strings.toString(c.totalShares), '</text>',
            '<text x="200" y="360" font-family="monospace" font-size="10" fill="#EDE6D6" opacity="0.5" text-anchor="middle">FICTIONAL SIMULATION - NOT A REAL FINANCIAL PRODUCT</text>',
            '</svg>'
        ));

        string memory json = string(abi.encodePacked(
            '{"name":"', c.name, ' - Share ', Strings.toString(ord), '/', Strings.toString(c.totalShares), '",',
            '"description":"Sovereign Share NFT from a fictional privatization simulation. Not a real financial product, security, or claim on any real-world asset.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '"}'
        ));

        return string(abi.encodePacked('data:application/json;base64,', Base64.encode(bytes(json))));
    }
}
