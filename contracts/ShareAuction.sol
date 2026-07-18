// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
    /// is over: distribute 1% of the company's capital as a dividend, or
    /// leave it in the treasury ("reinvest" — capital simply stays put for
    /// the next governor to actively deploy, rather than this vote
    /// triggering any specific purchase itself). Indexed by term number so
    /// history survives startNewTerm() resetting the election state.
    uint256 public constant POLICY_VOTE_WINDOW = 3 days;
    uint256 public constant TERM_END_DIVIDEND_BPS = 100; // 1%
    mapping(uint256 => mapping(uint256 => uint256)) public termEndedAt; // companyId => term => when that term's governorTermEnd was
    mapping(uint256 => mapping(uint256 => uint256)) public policyVoteEnd; // companyId => term => deadline, 0 = not opened
    mapping(uint256 => mapping(uint256 => bool)) public policyResolved;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public policyHasVoted;
    mapping(uint256 => mapping(uint256 => uint256)) public policyDividendWeight;
    mapping(uint256 => mapping(uint256 => uint256)) public policyReinvestWeight;

    /// @notice What a company holds beyond INVEST — deposited ERC-20s the
    /// governor can move, the "hold other crypto asset wallets" piece.
    mapping(uint256 => mapping(address => uint256)) public companyTokenBalance; // companyId => ERC20 token => balance

    /// @notice Tokens accepted as payment for INVEST itself on the secondary
    /// market below — this is how anyone who wasn't a citizen during the
    /// original privatization acquires INVEST at all, since claim() is
    /// closed to them. Deliberately never the INVEST token, and never a
    /// direct fiat rail (there's no bank/card path anywhere in this
    /// contract). What counts as "not secretly fiat-pegged" in spirit is a
    /// judgment call the owner makes when approving a token address —
    /// Solidity has no way to inspect what a given ERC-20 economically
    /// represents, so this whitelist is a policy decision, not a guarantee
    /// the code can enforce on its own.
    mapping(address => bool) public approvedPaymentTokens;

    /// @notice A citizen or a company treasury offering some of its INVEST
    /// for sale, priced in an approved ERC-20.
    struct InvestOffer {
        address seller; // citizen wallet, or corporateHolder(companyId) if isCorporateOffer
        uint256 investAmount;
        address paymentToken;
        uint256 paymentAmount;
        bool active;
        bool isCorporateOffer;
        uint256 creditCompanyId; // meaningful only when isCorporateOffer is true
    }
    mapping(uint256 => InvestOffer) public investOffers;
    uint256 public nextInvestOfferId;

    /// @notice Post-lock secondary market. A citizen who owns a share can
    /// list it; anyone can buy it for INVEST. This is the "sell" side that
    /// was missing entirely — invest() lets a governor buy into another
    /// company, but until now there was no way to sell out of a position at
    /// all, by a citizen or by an organization.
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
    event PolicyVoteOpened(uint256 indexed companyId, uint256 indexed term, uint256 voteEnd);
    event PolicyVoted(uint256 indexed companyId, uint256 indexed term, address indexed voter, bool wantsDividend, uint256 weight);
    event PolicyResolved(uint256 indexed companyId, uint256 indexed term, bool distributedDividend, uint256 amount);
    event InvestOffered(uint256 indexed offerId, address indexed seller, uint256 investAmount, address paymentToken, uint256 paymentAmount);
    event InvestSold(uint256 indexed offerId, address seller, address indexed buyer, uint256 investAmount, address paymentToken, uint256 paymentAmount);
    event InvestOfferCancelled(uint256 indexed offerId);
    event PaymentTokenApprovalSet(address indexed token, bool approved);
    event CorporateInvestment(uint256 indexed fromCompanyId, uint256 indexed toCompanyId, uint256 amount);
    event DividendDistributed(uint256 indexed companyId, uint256 totalAmount);
    event ShareListed(uint256 indexed listingId, uint256 indexed tokenId, address indexed seller, uint256 price);
    event ShareSold(uint256 indexed listingId, uint256 indexed tokenId, address seller, address buyer, uint256 price);
    event ListingCancelled(uint256 indexed listingId);
    event TokenDeposited(uint256 indexed companyId, address indexed token, address indexed from, uint256 amount);
    event TokenWithdrawn(uint256 indexed companyId, address indexed token, address indexed to, uint256 amount);

    constructor(address _investToken) ERC721("Sovereign Share", "SHARE") Ownable(msg.sender) {
        investToken = InvestToken(_investToken);
        host = msg.sender;
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

    /// @notice Opens the mandatory post-term policy vote for a given term
    /// number. Works whether or not startNewTerm() has already reset the
    /// live governorTermEnd for a newer term — termEndedAt archives the
    /// timestamp automatically the moment the NEXT governor is installed,
    /// so this stays callable long after the fact.
    function openPolicyVote(uint256 companyId, uint256 term) external {
        require(term > 0 && term <= termNumber[companyId], "ShareAuction: invalid term");
        uint256 endedAt = termEndedAt[companyId][term];
        if (endedAt == 0 && term == termNumber[companyId]) {
            require(block.timestamp >= governorTermEnd[companyId], "ShareAuction: term not over yet");
            endedAt = governorTermEnd[companyId];
        }
        require(endedAt != 0, "ShareAuction: term not concluded");
        require(policyVoteEnd[companyId][term] == 0, "ShareAuction: already opened");
        require(companies[companyId].sharesIssued > 0, "ShareAuction: no shares issued");
        policyVoteEnd[companyId][term] = block.timestamp + POLICY_VOTE_WINDOW;
        emit PolicyVoteOpened(companyId, term, policyVoteEnd[companyId][term]);
    }

    /// @notice Every shareholder gets one vote per term, weighted by shares
    /// held, choosing dividend or reinvest. Simple majority of votes cast —
    /// unlike the governor election, this isn't a runoff, just a binary
    /// choice. A tie (including nobody voting at all) defaults to reinvest.
    function votePolicy(uint256 companyId, uint256 term, bool wantsDividend) external {
        require(policyVoteEnd[companyId][term] != 0 && block.timestamp < policyVoteEnd[companyId][term], "ShareAuction: voting not open");
        require(!policyHasVoted[companyId][term][msg.sender], "ShareAuction: already voted");
        uint256 weight = companyShareCount[companyId][msg.sender];
        require(weight > 0, "ShareAuction: not a shareholder");
        policyHasVoted[companyId][term][msg.sender] = true;
        if (wantsDividend) {
            policyDividendWeight[companyId][term] += weight;
        } else {
            policyReinvestWeight[companyId][term] += weight;
        }
        emit PolicyVoted(companyId, term, msg.sender, wantsDividend, weight);
    }

    /// @notice Executes the outcome. If "dividend" wins, exactly 1% of the
    /// company's current capital is distributed pro-rata to the supplied
    /// holder list (see distribute() for why the caller has to supply the
    /// list — Solidity can't enumerate "everyone who holds a share" on its
    /// own). If "reinvest" wins or it's a tie, nothing moves — the capital
    /// stays in the treasury for the next governor to actively deploy.
    function resolvePolicyVote(uint256 companyId, uint256 term, address[] calldata holders) external {
        require(policyVoteEnd[companyId][term] != 0, "ShareAuction: not opened");
        require(block.timestamp >= policyVoteEnd[companyId][term], "ShareAuction: voting still open");
        require(!policyResolved[companyId][term], "ShareAuction: already resolved");
        policyResolved[companyId][term] = true;

        if (policyDividendWeight[companyId][term] > policyReinvestWeight[companyId][term]) {
            Company storage c = companies[companyId];
            uint256 amount = (c.capital * TERM_END_DIVIDEND_BPS) / 10_000;
            if (amount > 0 && c.sharesIssued > 0) {
                c.capital -= amount;
                for (uint256 i = 0; i < holders.length; i++) {
                    uint256 held = companyShareCount[companyId][holders[i]];
                    if (held == 0) continue;
                    uint256 cut = (amount * held) / c.sharesIssued;
                    if (cut > 0) investToken.transfer(holders[i], cut);
                }
                emit DividendDistributed(companyId, amount);
            }
            emit PolicyResolved(companyId, term, true, amount);
        } else {
            emit PolicyResolved(companyId, term, false, 0);
        }
    }


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

    // ---------------------------------------------------------------------
    // Beyond INVEST: a company can hold other ERC-20 assets too — a grant,
    // a real-world settlement, proceeds routed in from off-chain. The
    // governor decides what leaves and where it goes, same "exchange
    // organization balance assets for other assets" principle as
    // invest()/governorListShare(), just generalized past INVEST itself.
    // ---------------------------------------------------------------------

    /// @notice Anyone can deposit any ERC-20 into a company's treasury.
    /// Requires this contract to already be approved for `amount`.
    function depositToken(uint256 companyId, address token, uint256 amount) external {
        require(companies[companyId].totalShares > 0, "ShareAuction: unknown company");
        require(amount > 0, "ShareAuction: amount must be > 0");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        companyTokenBalance[companyId][token] += amount;
        emit TokenDeposited(companyId, token, msg.sender, amount);
    }

    /// @notice Governor-only: move any ERC-20 the company holds to any
    /// address — a DEX router for a real swap, a vendor for a real-world
    /// purchase, or anywhere else the elected governor decides.
    function withdrawToken(uint256 companyId, address token, address to, uint256 amount) external onlyGovernor(companyId) {
        require(companyTokenBalance[companyId][token] >= amount, "ShareAuction: insufficient balance");
        companyTokenBalance[companyId][token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit TokenWithdrawn(companyId, token, to, amount);
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

    // ---------------------------------------------------------------------
    // INVEST secondary market. Citizenship — the free 1000 INVEST allocation
    // — belongs only to whoever was verified and claimed during the original
    // privatization. Anyone joining later has no path to claim() and no way
    // to receive INVEST as a gift (the closed-loop rule blocks that too).
    // This is their actual on-ramp: buy leftover INVEST from a citizen who
    // has some spare, or from a company's own treasury, paid for in an
    // approved crypto asset — never fiat, and never a fresh free allocation.
    // ---------------------------------------------------------------------

    function setApprovedPaymentToken(address token, bool approved) external onlyOwner {
        require(token != address(investToken), "ShareAuction: INVEST itself can't be a payment token");
        approvedPaymentTokens[token] = approved;
        emit PaymentTokenApprovalSet(token, approved);
    }

    /// @notice A citizen offers some of their own INVEST for sale. The
    /// offered amount is escrowed into this contract immediately (a normal
    /// citizen-to-auction-house transfer, already allowed by InvestToken's
    /// closed-loop rule) so a buyer can trust the offer is real.
    function offerInvest(uint256 investAmount, address paymentToken, uint256 paymentAmount) external {
        require(approvedPaymentTokens[paymentToken], "ShareAuction: payment token not approved");
        require(investAmount > 0 && paymentAmount > 0, "ShareAuction: amounts must be > 0");
        investToken.transferFrom(msg.sender, address(this), investAmount);
        investOffers[nextInvestOfferId] = InvestOffer(msg.sender, investAmount, paymentToken, paymentAmount, true, false, 0);
        emit InvestOffered(nextInvestOfferId, msg.sender, investAmount, paymentToken, paymentAmount);
        nextInvestOfferId++;
    }

    /// @notice The governor equivalent: sells some of the COMPANY's held
    /// INVEST capital for an approved ERC-20, which then becomes part of
    /// the company's token treasury (companyTokenBalance) instead of going
    /// to any individual — this is a company literally raising outside
    /// crypto capital by selling down its own INVEST position.
    function governorOfferInvest(uint256 companyId, uint256 investAmount, address paymentToken, uint256 paymentAmount) external onlyGovernor(companyId) {
        require(approvedPaymentTokens[paymentToken], "ShareAuction: payment token not approved");
        require(investAmount > 0 && paymentAmount > 0, "ShareAuction: amounts must be > 0");
        Company storage c = companies[companyId];
        require(c.capital >= investAmount, "ShareAuction: insufficient capital");
        c.capital -= investAmount;
        address corp = corporateHolder(companyId);
        investOffers[nextInvestOfferId] = InvestOffer(corp, investAmount, paymentToken, paymentAmount, true, true, companyId);
        emit InvestOffered(nextInvestOfferId, corp, investAmount, paymentToken, paymentAmount);
        nextInvestOfferId++;
    }

    function buyInvest(uint256 offerId) external {
        InvestOffer storage o = investOffers[offerId];
        require(o.active, "ShareAuction: not active");
        o.active = false;
        if (o.isCorporateOffer) {
            IERC20(o.paymentToken).safeTransferFrom(msg.sender, address(this), o.paymentAmount);
            companyTokenBalance[o.creditCompanyId][o.paymentToken] += o.paymentAmount;
        } else {
            IERC20(o.paymentToken).safeTransferFrom(msg.sender, o.seller, o.paymentAmount);
        }
        investToken.transfer(msg.sender, o.investAmount);
        emit InvestSold(offerId, o.seller, msg.sender, o.investAmount, o.paymentToken, o.paymentAmount);
    }

    function cancelInvestOffer(uint256 offerId) external {
        InvestOffer storage o = investOffers[offerId];
        require(o.active, "ShareAuction: not active");
        o.active = false;
        if (o.isCorporateOffer) {
            require(msg.sender == governorOperatingKey[o.creditCompanyId], "ShareAuction: not the current operating key");
            companies[o.creditCompanyId].capital += o.investAmount;
        } else {
            require(msg.sender == o.seller, "ShareAuction: not seller");
            investToken.transfer(o.seller, o.investAmount);
        }
        emit InvestOfferCancelled(offerId);
    }
}
