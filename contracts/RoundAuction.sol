// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
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
/// @dev This contract now also carries the full governance/treasury/fee
/// system originally built for ShareAuction, ported here because
/// RoundAuction -- not ShareAuction -- is the mechanic actually used for
/// real listings. Every governance function below is the SAME logic as
/// ShareAuction's (candidacy, runoff voting, term-limited operating keys,
/// corporate cross-holdings, the secondary market), with exactly one
/// deliberate adaptation: governance eligibility here uses ONLY the
/// 50%-of-shares-issued threshold, never a "fully finalized" requirement.
/// ShareAuction settles a company in one shot, so "finalized" and
/// "50%+ assigned" are close in time there. RoundAuction sells
/// incrementally across many rounds, possibly thousands for a
/// large-supply company (see MAX_SHARES_PER_ROUND below) -- requiring
/// full sellout before governance could ever open would mean governance
/// might never realistically start at all.
///
/// FICTIONAL SIMULATION. Not a real financial product, security, or claim
/// on any real-world asset. Any resemblance to real entities is a
/// gamified rule-set only.
///
/// Worth being explicit about a real tradeoff, not hidden: this mechanic
/// has no reserve/floor price, unlike standard auction theory (English,
/// Dutch, sealed-bid) which assumes a seller protected by a minimum
/// acceptable price. A thinly-bid round here still sells shares at
/// whatever the lowest active bid happens to be -- pure competition-based
/// pricing, deliberately, per how this was designed.
contract RoundAuction is ERC721, Ownable {
    string public constant DISCLAIMER = "FICTIONAL SIMULATION. Not a real financial product, security, or claim on any real-world asset. Any resemblance to real entities is a gamified rule-set only.";

    InvestToken public immutable investToken;
    uint256 public nextTokenId;
    uint256 public constant ROUND_COOLDOWN = 5 minutes;
    uint256 public constant LOCK_PERIOD = 7 days;

    /// @notice Every winning entitlement minted at settlement is split:
    /// 99% capitalizes the company (stays locked in this contract,
    /// spendable only by whatever governance takes over later), 1%
    /// accrues to the host -- same split ShareAuction already uses.
    uint256 public constant HOST_FEE_BPS = 100; // 100 / 10000 = 1%
    address public host;
    uint256 public hostFeeAccrued;

    struct Company {
        string name;
        uint256 totalShares;
        uint256 sharesIssued;
        uint256 currentRound;
        uint256 roundEnd;
        uint256 roundDuration; // reused for every round after the first
        bool finalized; // true only once totalShares are fully issued
        uint256 firstMintedAt; // set on this company's very first mint, starts the transfer lock
        uint256 capital; // the 99% pool raised for this company so far
    }

    struct RoundBid {
        address bidder;
        uint256 amount;
        bool active; // false once won (spent) or refunded -- never removed, just flagged
    }

    mapping(uint256 => Company) public companies;
    mapping(uint256 => RoundBid[]) public bids; // companyId => every bid ever placed, active or not
    mapping(uint256 => uint256) public shareCompany; // tokenId => companyId
    mapping(uint256 => uint256) public shareOrdinal; // tokenId => which share # of its company
    mapping(uint256 => mapping(address => uint256)) public companyShareCount; // companyId => holder => shares currently held

    /// @notice Mirrors ShareAuction's companiesListed/companiesFinalized --
    /// kept here for consistency even though InvestToken's
    /// privatizationConcluded() check currently points at ShareAuction,
    /// not this contract. "Finalized" here means fully sold out (see
    /// Company.finalized above), which for a large-supply company may
    /// take a very long time or never happen -- this counter reflects
    /// that honestly, it does not mean "governance-eligible."
    uint256 public companiesListed;
    uint256 public companiesFinalized;

    event CompanyListed(uint256 indexed companyId, string name, uint256 totalShares, uint256 roundEnd);
    event BidPlaced(uint256 indexed companyId, address indexed bidder, uint256 amount, uint256 bidIndex);
    event RoundSettled(uint256 indexed companyId, uint256 indexed round, uint256 sharesIssuedThisRound, uint256 baselineAmount);
    event RoundReopened(uint256 indexed companyId, uint256 indexed newRound, uint256 roundEnd);
    event CompanySoldOut(uint256 indexed companyId, uint256 refundedBidders);
    event HostFeesWithdrawn(address indexed host, uint256 amount);
    event HostSet(address indexed host);
    event TreasurySet(address indexed treasury);

    constructor(address _investToken) ERC721("Sovereign Share (Round Auction)", "RSHARE") Ownable(msg.sender) {
        investToken = InvestToken(_investToken);
        host = msg.sender;
    }

    function setHost(address _host) external onlyOwner {
        require(_host != address(0), "RoundAuction: zero address");
        host = _host;
        emit HostSet(_host);
    }

    /// @notice Pulls the accrued 1% host fee out to `host`. Works directly --
    /// InvestToken lets this contract pay funds out freely, it only
    /// restricts citizens spending their own balance elsewhere.
    function withdrawHostFees() external {
        require(msg.sender == host, "RoundAuction: not host");
        uint256 amount = hostFeeAccrued;
        require(amount > 0, "RoundAuction: nothing to withdraw");
        hostFeeAccrued = 0;
        investToken.transfer(host, amount);
        emit HostFeesWithdrawn(host, amount);
    }

    /// @notice The only contract allowed to move a company's INVEST capital
    /// on CompanyTreasury's behalf (dividends, treasury auction proceeds,
    /// vendor payments, the INVEST market) -- set once after deploying
    /// CompanyTreasury. Everything else that touches `capital` (invest(),
    /// governorListShare(), settlement's 99% split) still does so
    /// directly, since it never left this contract.
    address public treasury;

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "RoundAuction: zero address");
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    modifier onlyTreasury() {
        require(msg.sender == treasury, "RoundAuction: not treasury");
        _;
    }

    /// @notice The only way a company's INVEST capital changes from outside
    /// this contract -- restricted to the registered CompanyTreasury address.
    /// A positive delta credits capital (auction/vendor-payment proceeds); a
    /// negative one debits it (dividends, buying INVEST market offers).
    function adjustCapital(uint256 companyId, int256 delta) external onlyTreasury {
        if (delta >= 0) {
            companies[companyId].capital += uint256(delta);
        } else {
            uint256 dec = uint256(-delta);
            require(companies[companyId].capital >= dec, "RoundAuction: capital underflow");
            companies[companyId].capital -= dec;
        }
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
            firstMintedAt: 0,
            capital: 0
        });
        companiesListed++;
        emit CompanyListed(companyId, name, totalShares, companies[companyId].roundEnd);
    }

    /// @notice Same real gap closed as ShareAuction's MIN_BID: "> 0" alone
    /// permits a bid as small as one wei-unit. Matters even more here --
    /// beyond the same bid-count gas-spam risk, an extreme low bid also
    /// distorts settleRound()'s baseline (the LOWEST active bid sets
    /// everyone else's proportional entitlement), so a near-zero bid could
    /// inflate other bidders' entitlements to absurd multiples.
    uint256 public constant MIN_BID = 1 * 10 ** 18; // 1 whole INVEST

    /// @notice Same protection as ShareAuction's MAX_BIDS, and arguably more
    /// necessary here: unwon bids carry forward round after round rather
    /// than clearing, so total bid count only ever grows across a company's
    /// lifetime -- and settleRound()'s opening scan walks every bid ever
    /// placed (won or not) to find active ones, every single round. Without
    /// a ceiling, a company could accumulate enough historical bids over
    /// many rounds to eventually make its own settlement gas-unaffordable,
    /// even if no single round looked dangerous on its own.
    uint256 public constant MAX_BIDS = 500;

    /// @notice Hard ceiling on shares minted in a single settleRound()
    /// call. This is what actually makes a large totalShares (e.g. a
    /// company meant to sell millions of shares over its lifetime) safe:
    /// MAX_BIDS bounds the sort/scan cost, this bounds the mint-loop cost.
    /// A company simply takes more rounds to fully sell out once its
    /// totalShares exceeds this -- rounds already carry unfilled bids
    /// forward automatically, so nothing is lost by spreading issuance
    /// out, only time.
    uint256 public constant MAX_SHARES_PER_ROUND = 1000;

    /// @notice Once ANY single company's shares crossed this threshold
    /// (51%, matching the same governance-eligibility figure used
    /// elsewhere in this project), INVEST's closed-loop transfer
    /// restriction lifts globally -- for every wallet, not just that
    /// company's shareholders. Deliberately a single company's progress,
    /// not "all companies" or a global percentage: with the current
    /// per-round issuance cap and share counts, requiring every company to
    /// individually clear 51% could realistically never happen, or take
    /// years. One company clearing the bar is treated as sufficient
    /// real-world evidence that privatization is genuinely underway.
    uint256 public constant TRADABILITY_THRESHOLD_BPS = 5100; // 51%
    bool public globalTradabilityUnlocked;
    event GlobalTradabilityUnlocked(uint256 indexed companyId, uint256 sharesIssued, uint256 totalShares);

    function placeBid(uint256 companyId, uint256 amount) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "RoundAuction: unknown company");
        require(!c.finalized, "RoundAuction: sold out");
        require(block.timestamp < c.roundEnd, "RoundAuction: round closed, awaiting settlement");
        require(amount >= MIN_BID, "RoundAuction: bid below minimum (1 INVEST)");
        require(bids[companyId].length < MAX_BIDS, "RoundAuction: bid cap reached for this company");
        investToken.transferFrom(msg.sender, address(this), amount);
        bids[companyId].push(RoundBid(msg.sender, amount, true));
        emit BidPlaced(companyId, msg.sender, amount, bids[companyId].length - 1);
    }

    /// @notice Permissionless -- anyone can trigger settlement once a round
    /// closes. Does the actual proportional, highest-first allocation.
    function settleRound(uint256 companyId) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "RoundAuction: unknown company");
        require(!c.finalized, "RoundAuction: already sold out");
        require(block.timestamp >= c.roundEnd, "RoundAuction: round still open");

        RoundBid[] storage b = bids[companyId];

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

        uint256 trueRemaining = c.totalShares - c.sharesIssued;
        // Hard ceiling on mints in this single call, independent of how
        // large totalShares is. Without this, a company with a large
        // totalShares (meant to be sold across many rounds over time)
        // could still see one round's entitlements add up to thousands
        // of mints in one transaction -- the same permanently-stuck-forever
        // risk as an unbounded finalize(), just reachable through a
        // different door. Capping issuance per round instead of per
        // company lets totalShares be arbitrarily large and safe at the
        // same time: it just takes more rounds to sell out, which this
        // contract already handles natively via automatic carry-forward.
        // Kept separate from `trueRemaining` deliberately -- the finalized
        // check below must compare against the company's real total, not
        // this round's capped allowance, or a company would wrongly be
        // marked sold out (and everyone else's bids refunded away) the
        // moment the FIRST round's cap was hit, not when shares actually
        // ran out.
        uint256 sharesRemaining = trueRemaining > MAX_SHARES_PER_ROUND ? MAX_SHARES_PER_ROUND : trueRemaining;
        uint256 issuedThisRound = 0;
        uint256 roundHostFee = 0;
        uint256 roundCapital = 0;

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
                companyShareCount[companyId][bid.bidder] += entitlement;
                sharesRemaining -= entitlement;
                issuedThisRound += entitlement;

                // Same 1%/99% split as ShareAuction: 1% accrues to the
                // host, 99% capitalizes the company itself. bid.amount is
                // the FULL amount this bidder locked in -- already
                // transferred into this contract at placeBid() time --
                // so nothing further moves here, just accounting for
                // whose INVEST balance this now represents.
                uint256 fee = (bid.amount * HOST_FEE_BPS) / 10_000;
                roundHostFee += fee;
                roundCapital += (bid.amount - fee);

                bid.active = false; // won -- spent, does not carry forward
            }
            // else: leave active = true -- automatically carries into next round
        }

        // Stall breaker: if every active bidder's full entitlement exceeded
        // what remained, the proportional pass above issues nothing, and
        // with an unchanged baseline/entitlements, the exact same stall
        // would repeat every future round forever unless a smaller new bid
        // happens to arrive. Rather than risk that, fall back -- same
        // transaction, no extra round or cooldown needed -- to 1 share per
        // bidder, same highest-first/earliest-tiebreak order, until shares
        // or bidders run out. Guarantees real progress on every single
        // settleRound() call whenever at least one active bid and one
        // share exist.
        //
        // Note the fee/capital split below is proportional to ONE share's
        // worth of the bidder's amount (minAmount), not their full bid --
        // consistent with only one share actually being minted to them in
        // this fallback pass; the rest of their locked INVEST remains
        // exactly where the proportional pass would have left it: still
        // inside this contract, credited toward their same still-active
        // bid amount if any of it carries forward, or already fully
        // accounted for if this was their last unit.
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
                companyShareCount[companyId][bid.bidder] += 1;
                sharesRemaining -= 1;
                issuedThisRound += 1;

                uint256 fee = (minAmount * HOST_FEE_BPS) / 10_000;
                roundHostFee += fee;
                roundCapital += (minAmount - fee);

                bid.active = false;
            }
        }

        c.capital += roundCapital;
        hostFeeAccrued += roundHostFee;

        if (!globalTradabilityUnlocked && c.sharesIssued * 10_000 >= c.totalShares * TRADABILITY_THRESHOLD_BPS) {
            globalTradabilityUnlocked = true;
            emit GlobalTradabilityUnlocked(companyId, c.sharesIssued, c.totalShares);
        }

        emit RoundSettled(companyId, c.currentRound, issuedThisRound, minAmount);

        if (trueRemaining - issuedThisRound == 0) {
            c.finalized = true;
            companiesFinalized++;
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

    // ---------------------------------------------------------------------
    // Governance: declare candidacy, run a runoff election, install a
    // time-limited governor, then buy/sell/hold assets through them.
    // Same logic as ShareAuction's governance system, ported here since
    // this is the contract real listings actually use. The ONE deliberate
    // adaptation: eligibility below checks only the 50%-issued threshold,
    // never "fully finalized" -- see the contract-level comment at top for
    // why that specific condition could not transfer directly.
    // ---------------------------------------------------------------------

    uint256 public constant GOVERNANCE_VOTE_WINDOW = 3 days;
    uint256 public constant TERM_LENGTH = 30 days;
    uint256 public constant MAX_PROGRAM_BYTES = 4500; // ~700 words, practical proxy -- see declareCandidacy()
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
    mapping(uint256 => address) public governorOperatingKey;
    mapping(uint256 => mapping(uint256 => uint256)) public termEndedAt; // companyId => term => when that term's governorTermEnd was

    event GovernanceOpened(uint256 indexed companyId, uint256 voteEnd);
    event CandidateDeclared(uint256 indexed companyId, address indexed candidate, string program);
    event Voted(uint256 indexed companyId, uint256 indexed round, address indexed voter, address candidate, uint256 weight);
    event RoundAdvanced(uint256 indexed companyId, uint256 newRound, address firstPlace, address secondPlace);
    event GovernorElected(uint256 indexed companyId, address indexed governor, uint256 winningVotes, uint256 termEnd);
    event NewTermStarted(uint256 indexed companyId);
    event OperatingKeySet(uint256 indexed companyId, address indexed governor, address indexed operatingKey);
    event CorporateInvestment(uint256 indexed fromCompanyId, uint256 indexed toCompanyId, uint256 amount);

    /// @notice Opens candidacy + voting once at least half the company's
    /// shares issued so far have real owners (c.sharesIssued * 2 >=
    /// c.totalShares) -- deliberately NOT gated on c.finalized (fully sold
    /// out), which could take thousands of rounds for a large-supply
    /// company and would make governance unreachable in practice.
    function openGovernanceVote(uint256 companyId) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "RoundAuction: unknown company");
        require(c.sharesIssued * 2 >= c.totalShares, "RoundAuction: fewer than 50% of shares assigned");
        require(governanceRound[companyId] == 0, "RoundAuction: already open");
        require(candidateList[companyId].length > 0, "RoundAuction: no candidates yet");
        governanceRound[companyId] = 1;
        governanceVoteEnd[companyId] = block.timestamp + GOVERNANCE_VOTE_WINDOW;
        emit GovernanceOpened(companyId, governanceVoteEnd[companyId]);
    }

    /// @notice Any current shareholder of this company can put themselves
    /// forward, once the 50% threshold is met, with a short program.
    function declareCandidacy(uint256 companyId, string calldata program) external {
        Company storage c = companies[companyId];
        require(c.totalShares > 0, "RoundAuction: unknown company");
        require(c.sharesIssued * 2 >= c.totalShares, "RoundAuction: fewer than 50% of shares assigned");
        require(companyShareCount[companyId][msg.sender] > 0, "RoundAuction: not a shareholder");
        require(bytes(program).length <= MAX_PROGRAM_BYTES, "RoundAuction: program too long (~700 words max)");
        require(!candidates[companyId][msg.sender].registered, "RoundAuction: already a candidate");
        candidates[companyId][msg.sender] = Candidate(program, true);
        candidateList[companyId].push(msg.sender);
        emit CandidateDeclared(companyId, msg.sender, program);
    }

    /// @notice One vote per shareholder wallet per round, weighted by shares
    /// of THIS company currently held.
    function vote(uint256 companyId, address candidate) external {
        uint256 round = governanceRound[companyId];
        require(round > 0, "RoundAuction: voting not open");
        require(block.timestamp < governanceVoteEnd[companyId], "RoundAuction: voting closed");
        require(candidates[companyId][candidate].registered, "RoundAuction: not a candidate");
        require(!eliminated[companyId][candidate], "RoundAuction: candidate eliminated");
        require(!roundHasVoted[companyId][round][msg.sender], "RoundAuction: already voted this round");
        uint256 weight = companyShareCount[companyId][msg.sender];
        require(weight > 0, "RoundAuction: not a shareholder");
        roundHasVoted[companyId][round][msg.sender] = true;
        roundVotes[companyId][round][candidate] += weight;
        roundTotalVotesCast[companyId][round] += weight;
        emit Voted(companyId, round, msg.sender, candidate, weight);
    }

    /// @notice Lets a company that holds a cross-holding stake (via
    /// invest() below) cast that stake's vote through its own governor's
    /// real operating key, since the synthetic corporateHolder address has
    /// no private key of its own to sign anything directly.
    function voteAsCorporation(uint256 fromCompanyId, uint256 toCompanyId, address candidate) external onlyGovernor(fromCompanyId) {
        uint256 round = governanceRound[toCompanyId];
        require(round > 0, "RoundAuction: voting not open");
        require(block.timestamp < governanceVoteEnd[toCompanyId], "RoundAuction: voting closed");
        require(candidates[toCompanyId][candidate].registered, "RoundAuction: not a candidate");
        require(!eliminated[toCompanyId][candidate], "RoundAuction: candidate eliminated");
        address corp = corporateHolder(fromCompanyId);
        require(!roundHasVoted[toCompanyId][round][corp], "RoundAuction: already voted this round");
        uint256 weight = companyShareCount[toCompanyId][corp];
        require(weight > 0, "RoundAuction: no shares held there");
        roundHasVoted[toCompanyId][round][corp] = true;
        roundVotes[toCompanyId][round][candidate] += weight;
        roundTotalVotesCast[toCompanyId][round] += weight;
        emit Voted(toCompanyId, round, corp, candidate, weight);
    }

    /// @notice Callable by anyone once the round's window has closed. Elects
    /// the governor if someone cleared 51% of votes cast this round.
    /// Otherwise this is a runoff: every candidate except the current top
    /// two gets eliminated and a fresh round opens -- repeat until someone
    /// clears the bar. Once only two (or fewer) candidates remain and
    /// there's still no 51% majority, the round's plurality leader wins
    /// outright rather than looping on a possible exact tie forever.
    function tallyRound(uint256 companyId) external {
        uint256 round = governanceRound[companyId];
        require(round > 0, "RoundAuction: voting not open");
        require(block.timestamp >= governanceVoteEnd[companyId], "RoundAuction: voting still open");
        require(companyGovernor[companyId] == address(0), "RoundAuction: governor already set");

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
            require(first != address(0), "RoundAuction: no votes cast");
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
    /// actually operate with this term -- generate it client-side, then
    /// call this once from your real identity wallet to authorize it.
    /// Every governor action below checks this key, not the officeholder's
    /// personal wallet directly.
    function setOperatingKey(uint256 companyId, address operatingKey) external {
        require(msg.sender == companyGovernor[companyId], "RoundAuction: not governor");
        require(block.timestamp < governorTermEnd[companyId], "RoundAuction: term expired");
        require(operatingKey != address(0), "RoundAuction: zero address");
        governorOperatingKey[companyId] = operatingKey;
        emit OperatingKeySet(companyId, msg.sender, operatingKey);
    }

    /// @notice Once a governor's term expires, anyone can reset the company
    /// for a new election -- clears the old candidate list, vote history,
    /// and governor, so a genuinely fresh cycle runs.
    function startNewTerm(uint256 companyId) external {
        require(companyGovernor[companyId] != address(0), "RoundAuction: no sitting governor");
        require(block.timestamp >= governorTermEnd[companyId], "RoundAuction: current term not over");
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
    /// officeholder's personal wallet -- that's the whole point of
    /// setOperatingKey(). Before a governor has set one, operatingKey is
    /// address(0) and every governor-only action simply reverts until
    /// they do.
    modifier onlyGovernor(uint256 companyId) {
        require(msg.sender == governorOperatingKey[companyId], "RoundAuction: not the current operating key");
        require(block.timestamp < governorTermEnd[companyId], "RoundAuction: term expired");
        _;
    }

    /// @notice BUY: the governor commits this company's capital as a bid
    /// into another company's still-open round -- one company taking a
    /// stake in another, the way a real conglomerate would. The corporate
    /// bid is pushed in as an ordinary active RoundBid, and participates
    /// in that target company's next settlement exactly like any other bid.
    function invest(uint256 fromCompanyId, uint256 toCompanyId, uint256 amount) external onlyGovernor(fromCompanyId) {
        Company storage from = companies[fromCompanyId];
        require(from.capital >= amount, "RoundAuction: insufficient capital");
        Company storage to = companies[toCompanyId];
        require(to.totalShares > 0, "RoundAuction: unknown target company");
        require(!to.finalized, "RoundAuction: target sold out");
        require(block.timestamp < to.roundEnd, "RoundAuction: target round closed, awaiting settlement");
        require(bids[toCompanyId].length < MAX_BIDS, "RoundAuction: bid cap reached for target company");
        from.capital -= amount;
        address corpBidder = corporateHolder(fromCompanyId);
        bids[toCompanyId].push(RoundBid(corpBidder, amount, true));
        emit CorporateInvestment(fromCompanyId, toCompanyId, amount);
    }

    // ---------------------------------------------------------------------
    // Secondary market: the "sell" side. A citizen can list any share they
    // own once it's past its lock period; a governor can list a share their
    // organization holds in another company (a cross-holding built up via
    // invest()) and route the proceeds back into that organization's
    // capital pool instead of to a wallet nobody controls.
    // ---------------------------------------------------------------------

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

    event ShareListed(uint256 indexed listingId, uint256 indexed tokenId, address indexed seller, uint256 price);
    event ShareSold(uint256 indexed listingId, uint256 indexed tokenId, address seller, address buyer, uint256 price);
    event ListingCancelled(uint256 indexed listingId);

    function listShare(uint256 tokenId, uint256 price) external {
        require(ownerOf(tokenId) == msg.sender, "RoundAuction: not the owner");
        require(price > 0, "RoundAuction: price must be > 0");
        Company storage c = companies[shareCompany[tokenId]];
        require(block.timestamp >= c.firstMintedAt + LOCK_PERIOD, "RoundAuction: still locked");
        listings[nextListingId] = Listing(tokenId, msg.sender, price, true, false, 0);
        emit ShareListed(nextListingId, tokenId, msg.sender, price);
        nextListingId++;
    }

    /// @notice The governor equivalent of listShare(): lists a share the
    /// organization holds in ANOTHER company (acquired via invest()). The
    /// corporate holder address has no private key, so proceeds can't be
    /// sent to it the normal way -- instead a sale credits the capital pool
    /// of the SELLING organization directly.
    function governorListShare(uint256 ownerCompanyId, uint256 tokenId, uint256 price) external onlyGovernor(ownerCompanyId) {
        require(ownerOf(tokenId) == corporateHolder(ownerCompanyId), "RoundAuction: organization doesn't hold this share");
        require(price > 0, "RoundAuction: price must be > 0");
        Company storage c = companies[shareCompany[tokenId]];
        require(block.timestamp >= c.firstMintedAt + LOCK_PERIOD, "RoundAuction: still locked");
        listings[nextListingId] = Listing(tokenId, corporateHolder(ownerCompanyId), price, true, true, ownerCompanyId);
        emit ShareListed(nextListingId, tokenId, corporateHolder(ownerCompanyId), price);
        nextListingId++;
    }

    function buyShare(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "RoundAuction: not active");
        l.active = false;
        investToken.transferFrom(msg.sender, address(this), l.price);
        if (l.isCorporateSale) {
            companies[l.creditCompanyId].capital += l.price;
        } else {
            investToken.transfer(l.seller, l.price);
        }
        // Moves the NFT directly, bypassing per-token approval -- the
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
        require(l.active, "RoundAuction: not active");
        if (l.isCorporateSale) {
            require(msg.sender == governorOperatingKey[l.creditCompanyId], "RoundAuction: not the current operating key");
        } else {
            require(msg.sender == l.seller, "RoundAuction: not seller");
        }
        l.active = false;
        emit ListingCancelled(listingId);
    }

    /// @dev A synthetic, non-transferable "address" representing a company's
    /// own treasury as a shareholder in another company. Cross-holdings are
    /// tracked the same way any wallet's shares are (companyShareCount,
    /// shareCompany) so the corporate holder can vote in the target
    /// company's governance too, just like a real parent/subsidiary stake.
    /// Deliberately namespaced differently from ShareAuction's version
    /// ("SOVEREIGN_LOTS_CORP_ROUND" vs "SOVEREIGN_LOTS_CORP") so the two
    /// contracts never accidentally compute the same synthetic address for
    /// the same companyId.
    function corporateHolder(uint256 companyId) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked("SOVEREIGN_LOTS_CORP_ROUND", companyId)))));
    }

    /// @dev Same transfer lock as ShareAuction -- nothing moves until
    /// LOCK_PERIOD has passed since this company's first-ever mint. Also
    /// keeps companyShareCount accurate so governance votes always reflect
    /// who currently holds shares, not just who originally won them.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        uint256 companyId = shareCompany[tokenId];
        if (from != address(0) && to != address(0)) {
            Company storage c = companies[companyId];
            require(block.timestamp >= c.firstMintedAt + LOCK_PERIOD, "RoundAuction: shares still locked");
            companyShareCount[companyId][from]--;
            companyShareCount[companyId][to]++;
        }
        return super._update(to, tokenId, auth);
    }

    /// @notice Same fully on-chain metadata/artwork pattern as ShareAuction
    /// -- no external server, so a real minted share never shows up as a
    /// blank or broken image in a wallet or marketplace, regardless of
    /// whether any off-chain host is still running. Company name, which
    /// share number this specific token is, and the company's total share
    /// count are all read live from this contract's own storage.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "RoundAuction: nonexistent token");
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
            '"description":"Sovereign Share NFT from a fictional privatization simulation (Round Auction). Not a real financial product, security, or claim on any real-world asset.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '"}'
        ));

        return string(abi.encodePacked('data:application/json;base64,', Base64.encode(bytes(json))));
    }
}
