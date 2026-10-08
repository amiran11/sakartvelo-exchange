// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./InvestToken.sol";

/// @notice The parts of RoundAuction (v8) the treasury uses.
interface ICapitalLedger {
    function companies(uint256 companyId) external view returns (
        string memory name, uint256 totalShares, uint256 sharesIssued, uint256 currentRound,
        uint256 roundEnd, uint256 roundDuration, bool finalized, uint256 firstMintedAt, uint256 capital
    );
    function shareCountAt(uint256 companyId, address holder, uint256 ts) external view returns (uint256);
    function sharesIssuedAt(uint256 companyId, uint256 ts) external view returns (uint256);
    function corporateHolder(uint256 companyId) external pure returns (address);
    function adjustCapital(uint256 companyId, int256 delta) external;
    function addReinvestableIncome(uint256 companyId, uint256 amount) external;
}

/// @notice The parts of Governance the treasury uses.
interface IGovernanceView {
    function governorOperatingKey(uint256 companyId) external view returns (address);
    function governorTermEnd(uint256 companyId) external view returns (uint256);
    function termNumber(uint256 companyId) external view returns (uint256);
    function termEndedAt(uint256 companyId, uint256 term) external view returns (uint256);
}

/// @title CompanyTreasury (v6)
/// @notice What a company does with its money once it has a governor:
/// custody of any ERC-20, a 5%-per-term free withdrawal allowance, sealed-
/// bid treasury auctions and shareholder-approved vendor payments above
/// that, the end-of-term dividend vote, and the INVEST secondary market.
///
/// v6 changes (SECURITY_REVIEW.md Findings 16-19):
///   - Dividends use a record date: entitlement is the shares held when
///     the term ended, read from RoundAuction's balance history. Moving
///     shares to a second wallet can no longer claim twice.
///   - The governor's discretionary mid-term distribute() is removed;
///     the end-of-term shareholder vote is the only dividend path.
///   - Vendor payments need a 20% quorum of issued shares, with votes
///     weighted by shares held when the proposal was made.
///   - Treasury auctions track the leading bid as reveals arrive and let
///     every bidder claim their own refund: no loop over bidders, and one
///     failing transfer can't block anyone else.
///   - Deposits credit what actually arrived (fee-on-transfer safe).
///   - Governor checks read the separate Governance contract.
///
/// FICTIONAL SIMULATION. Not a real financial product, security, or claim
/// on any real-world asset.
contract CompanyTreasury is Ownable {
    using SafeERC20 for IERC20;

    string public constant DISCLAIMER = "FICTIONAL SIMULATION. Not a real financial product, security, or claim on any real-world asset. Any resemblance to real entities is a gamified rule-set only.";

    InvestToken public immutable investToken;
    ICapitalLedger public immutable roundAuction;
    IGovernanceView public immutable governance;

    constructor(address _investToken, address _roundAuction, address _governance) Ownable(msg.sender) {
        require(_investToken != address(0) && _roundAuction != address(0) && _governance != address(0), "CT: zero address");
        investToken = InvestToken(_investToken);
        roundAuction = ICapitalLedger(_roundAuction);
        governance = IGovernanceView(_governance);
    }

    modifier onlyGovernor(uint256 companyId) {
        require(msg.sender == governance.governorOperatingKey(companyId), "CT: not operating key");
        require(block.timestamp < governance.governorTermEnd(companyId), "CT: term expired");
        _;
    }

    function _company(uint256 companyId) internal view returns (uint256 totalShares, uint256 capital) {
        (, totalShares, , , , , , , capital) = roundAuction.companies(companyId);
    }

    /// @dev Moves INVEST this contract holds back into RoundAuction and
    /// credits it to a company's capital, in one step.
    function _creditCapital(uint256 companyId, uint256 amount) internal {
        investToken.transfer(address(roundAuction), amount);
        roundAuction.adjustCapital(companyId, int256(amount));
    }

    // ---------------------------------------------------------------------
    // Custody of any ERC-20, and the 5%-per-term free allowance
    // ---------------------------------------------------------------------

    mapping(uint256 => mapping(address => uint256)) public companyTokenBalance;

    event TokenDeposited(uint256 indexed companyId, address indexed token, address indexed from, uint256 amount);
    event TokenWithdrawn(uint256 indexed companyId, address indexed token, address indexed to, uint256 amount);

    function depositToken(uint256 companyId, address token, uint256 amount) external {
        (uint256 totalShares, ) = _company(companyId);
        require(totalShares > 0, "CT: unknown company");
        require(amount > 0, "CT: amount must be > 0");
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        companyTokenBalance[companyId][token] += received;
        emit TokenDeposited(companyId, token, msg.sender, received);
    }

    uint256 public constant FREE_TIER_BPS = 500; // 5%
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public termTokenSnapshot;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public termTokenSnapshotTaken;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public termTokenFreeSpent;

    /// @notice How much of `token` the governor can still withdraw freely this term.
    function freeAllowanceLeft(uint256 companyId, address token) external view returns (uint256) {
        uint256 term = governance.termNumber(companyId);
        uint256 base = termTokenSnapshotTaken[companyId][term][token] ? termTokenSnapshot[companyId][term][token] : companyTokenBalance[companyId][token];
        uint256 cap = (base * FREE_TIER_BPS) / 10_000;
        uint256 spent = termTokenFreeSpent[companyId][term][token];
        return spent >= cap ? 0 : cap - spent;
    }

    function withdrawToken(uint256 companyId, address token, address to, uint256 amount) external onlyGovernor(companyId) {
        require(companyTokenBalance[companyId][token] >= amount, "CT: insufficient balance");
        uint256 term = governance.termNumber(companyId);
        if (!termTokenSnapshotTaken[companyId][term][token]) {
            termTokenSnapshot[companyId][term][token] = companyTokenBalance[companyId][token];
            termTokenSnapshotTaken[companyId][term][token] = true;
        }
        uint256 cap = (termTokenSnapshot[companyId][term][token] * FREE_TIER_BPS) / 10_000;
        uint256 spent = termTokenFreeSpent[companyId][term][token];
        require(spent + amount <= cap, "CT: over 5% free allowance");
        termTokenFreeSpent[companyId][term][token] = spent + amount;
        companyTokenBalance[companyId][token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit TokenWithdrawn(companyId, token, to, amount);
    }

    // ---------------------------------------------------------------------
    // Above 5%, path 1: sealed-bid treasury auction (commit, reveal, settle)
    // ---------------------------------------------------------------------

    uint256 public bidDepositAmount = 10 * 10 ** 18;
    uint256 public constant COMMIT_WINDOW = 2 days;
    uint256 public constant REVEAL_WINDOW = 1 days;

    struct TreasuryAuction {
        uint256 companyId;
        address token;
        uint256 amount;
        uint256 commitEnd;
        uint256 revealEnd;
        uint256 deposit;         // fixed per auction when it opens
        uint256 committed;       // number of commits
        uint256 revealed;        // number of valid reveals
        address leader;          // highest revealed bid so far (earliest wins ties)
        uint256 leadingAmount;
        bool settled;
    }
    struct SealedBid {
        bytes32 commitHash;
        bool revealed;
        uint256 revealedAmount;
        bool claimed;
    }
    mapping(uint256 => TreasuryAuction) public treasuryAuctions;
    mapping(uint256 => mapping(address => SealedBid)) public treasuryBids;
    uint256 public nextTreasuryAuctionId;

    event TreasuryAuctionOpened(uint256 indexed auctionId, uint256 indexed companyId, address token, uint256 amount, uint256 commitEnd, uint256 revealEnd);
    event BidCommitted(uint256 indexed auctionId, address indexed bidder);
    event BidRevealed(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event TreasuryAuctionSettled(uint256 indexed auctionId, address winner, uint256 winningAmount);
    event TreasuryAuctionClaimed(uint256 indexed auctionId, address indexed bidder, uint256 investReturned, bool wonTokens);

    /// @notice The hash a bidder commits to. The site computes this; it is
    /// bound to the auction and the bidder so a commit can't be reused.
    function commitHashFor(uint256 auctionId, uint256 amount, bytes32 salt, address bidder) public pure returns (bytes32) {
        return keccak256(abi.encode(auctionId, amount, salt, bidder));
    }

    function openTreasuryAuction(uint256 companyId, address token, uint256 amount) external onlyGovernor(companyId) returns (uint256 auctionId) {
        require(amount > 0, "CT: amount must be > 0");
        require(companyTokenBalance[companyId][token] >= amount, "CT: insufficient balance");
        companyTokenBalance[companyId][token] -= amount; // reserved until settled
        auctionId = nextTreasuryAuctionId++;
        uint256 commitEnd = block.timestamp + COMMIT_WINDOW;
        TreasuryAuction storage a = treasuryAuctions[auctionId];
        a.companyId = companyId;
        a.token = token;
        a.amount = amount;
        a.commitEnd = commitEnd;
        a.revealEnd = commitEnd + REVEAL_WINDOW;
        a.deposit = bidDepositAmount;
        emit TreasuryAuctionOpened(auctionId, companyId, token, amount, commitEnd, a.revealEnd);
    }

    function commitBid(uint256 auctionId, bytes32 commitHash) external {
        TreasuryAuction storage a = treasuryAuctions[auctionId];
        require(block.timestamp < a.commitEnd, "CT: commit window closed");
        require(commitHash != bytes32(0), "CT: empty commit");
        require(treasuryBids[auctionId][msg.sender].commitHash == bytes32(0), "CT: already committed");
        investToken.transferFrom(msg.sender, address(this), a.deposit);
        treasuryBids[auctionId][msg.sender].commitHash = commitHash;
        a.committed++;
        emit BidCommitted(auctionId, msg.sender);
    }

    function revealBid(uint256 auctionId, uint256 amount, bytes32 salt) external {
        TreasuryAuction storage a = treasuryAuctions[auctionId];
        require(block.timestamp >= a.commitEnd && block.timestamp < a.revealEnd, "CT: not reveal window");
        SealedBid storage b = treasuryBids[auctionId][msg.sender];
        require(b.commitHash != bytes32(0), "CT: no commit found");
        require(!b.revealed, "CT: already revealed");
        require(amount > 0, "CT: zero bid");
        require(commitHashFor(auctionId, amount, salt, msg.sender) == b.commitHash, "CT: hash mismatch");
        investToken.transferFrom(msg.sender, address(this), amount);
        b.revealed = true;
        b.revealedAmount = amount;
        a.revealed++;
        if (amount > a.leadingAmount) {
            a.leader = msg.sender;
            a.leadingAmount = amount;
        }
        emit BidRevealed(auctionId, msg.sender, amount);
    }

    /// @notice Permissionless after the reveal window. Constant cost: pays
    /// the winning bid and every forfeited deposit (commits never revealed)
    /// into the company's capital. Bidders then claim individually.
    function settleTreasuryAuction(uint256 auctionId) external {
        TreasuryAuction storage a = treasuryAuctions[auctionId];
        require(a.revealEnd > 0, "CT: unknown auction");
        require(block.timestamp >= a.revealEnd, "CT: reveal window still open");
        require(!a.settled, "CT: already settled");
        a.settled = true;
        uint256 toCapital = (a.committed - a.revealed) * a.deposit + a.leadingAmount;
        if (toCapital > 0) _creditCapital(a.companyId, toCapital);
        if (a.leader == address(0)) {
            companyTokenBalance[a.companyId][a.token] += a.amount; // unsold: back to the company
        }
        emit TreasuryAuctionSettled(auctionId, a.leader, a.leadingAmount);
    }

    /// @notice After settlement: the winner gets the auctioned tokens and
    /// their deposit back; every other revealed bidder gets deposit + bid.
    function claimTreasuryAuction(uint256 auctionId) external {
        TreasuryAuction storage a = treasuryAuctions[auctionId];
        require(a.settled, "CT: not settled");
        SealedBid storage b = treasuryBids[auctionId][msg.sender];
        require(b.revealed, "CT: nothing to claim");
        require(!b.claimed, "CT: already claimed");
        b.claimed = true;
        bool won = msg.sender == a.leader;
        uint256 back = won ? a.deposit : a.deposit + b.revealedAmount;
        investToken.transfer(msg.sender, back);
        if (won) IERC20(a.token).safeTransfer(msg.sender, a.amount);
        emit TreasuryAuctionClaimed(auctionId, msg.sender, back, won);
    }

    function setBidDepositAmount(uint256 amount) external onlyOwner {
        bidDepositAmount = amount; // applies to auctions opened afterwards
    }

    // ---------------------------------------------------------------------
    // Above 5%, path 2: vendor payment approved by shareholders
    // ---------------------------------------------------------------------

    uint256 public constant VENDOR_VOTE_WINDOW = 3 days;
    uint256 public constant APPROVAL_THRESHOLD_BPS = 5100; // 51% of votes cast
    uint256 public constant VENDOR_QUORUM_BPS = 2000;      // 20% of issued shares must vote

    struct VendorPayment {
        uint256 companyId;
        address token;
        address to;
        uint256 amount;
        uint256 voteEnd;
        uint256 snapshot;
        uint256 yesWeight;
        uint256 noWeight;
        bool executed;
    }
    mapping(uint256 => VendorPayment) public vendorPayments;
    mapping(uint256 => mapping(address => bool)) public vendorPaymentVoted;
    uint256 public nextVendorPaymentId;

    event VendorPaymentProposed(uint256 indexed paymentId, uint256 indexed companyId, address token, address to, uint256 amount);
    event VendorPaymentVoted(uint256 indexed paymentId, address indexed voter, bool approve, uint256 weight);
    event VendorPaymentExecuted(uint256 indexed paymentId, bool approved);

    function proposeVendorPayment(uint256 companyId, address token, address to, uint256 amount) external onlyGovernor(companyId) returns (uint256 paymentId) {
        require(amount > 0, "CT: amount must be > 0");
        require(to != address(0), "CT: zero address");
        require(companyTokenBalance[companyId][token] >= amount, "CT: insufficient balance");
        companyTokenBalance[companyId][token] -= amount; // reserved until the vote resolves
        paymentId = nextVendorPaymentId++;
        vendorPayments[paymentId] = VendorPayment(companyId, token, to, amount, block.timestamp + VENDOR_VOTE_WINDOW, block.timestamp - 1, 0, 0, false);
        emit VendorPaymentProposed(paymentId, companyId, token, to, amount);
    }

    function voteVendorPayment(uint256 paymentId, bool approve) external {
        VendorPayment storage p = vendorPayments[paymentId];
        require(block.timestamp < p.voteEnd, "CT: voting closed");
        require(!vendorPaymentVoted[paymentId][msg.sender], "CT: already voted");
        uint256 weight = roundAuction.shareCountAt(p.companyId, msg.sender, p.snapshot);
        require(weight > 0, "CT: no shares at snapshot");
        vendorPaymentVoted[paymentId][msg.sender] = true;
        if (approve) p.yesWeight += weight; else p.noWeight += weight;
        emit VendorPaymentVoted(paymentId, msg.sender, approve, weight);
    }

    /// @notice True if, right now, the vote would pass (quorum met and 51% yes).
    function vendorPaymentPasses(uint256 paymentId) public view returns (bool) {
        VendorPayment storage p = vendorPayments[paymentId];
        uint256 total = p.yesWeight + p.noWeight;
        uint256 issued = roundAuction.sharesIssuedAt(p.companyId, p.snapshot);
        return total > 0
            && total * 10_000 >= issued * VENDOR_QUORUM_BPS
            && p.yesWeight * 10_000 >= total * APPROVAL_THRESHOLD_BPS;
    }

    function executeVendorPayment(uint256 paymentId) external {
        VendorPayment storage p = vendorPayments[paymentId];
        require(p.voteEnd > 0, "CT: unknown payment");
        require(block.timestamp >= p.voteEnd, "CT: voting still open");
        require(!p.executed, "CT: already executed");
        p.executed = true;
        bool approved = vendorPaymentPasses(paymentId);
        if (approved) {
            IERC20(p.token).safeTransfer(p.to, p.amount);
        } else {
            companyTokenBalance[p.companyId][p.token] += p.amount;
        }
        emit VendorPaymentExecuted(paymentId, approved);
    }

    // ---------------------------------------------------------------------
    // End-of-term dividend vote (the only dividend path since v6)
    // Record date = the moment the term ended.
    // ---------------------------------------------------------------------

    uint256 public constant POLICY_VOTE_WINDOW = 3 days;
    uint256 public constant TERM_END_DIVIDEND_BPS = 100; // 1% of capital
    mapping(uint256 => mapping(uint256 => uint256)) public policyVoteEnd;
    mapping(uint256 => mapping(uint256 => uint256)) public policyRecordDate;
    mapping(uint256 => mapping(uint256 => bool)) public policyResolved;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public policyHasVoted;
    mapping(uint256 => mapping(uint256 => uint256)) public policyDividendWeight;
    mapping(uint256 => mapping(uint256 => uint256)) public policyReinvestWeight;
    mapping(uint256 => mapping(uint256 => uint256)) public dividendPerShare; // scaled by 1e18
    mapping(uint256 => mapping(uint256 => uint256)) public dividendRemaining; // INVEST not yet claimed
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public claimedDividend;

    event PolicyVoteOpened(uint256 indexed companyId, uint256 indexed term, uint256 voteEnd, uint256 recordDate);
    event PolicyVoted(uint256 indexed companyId, uint256 indexed term, address indexed voter, bool wantsDividend, uint256 weight);
    event PolicyResolved(uint256 indexed companyId, uint256 indexed term, bool distributedDividend, uint256 amount);
    event DividendClaimed(uint256 indexed companyId, uint256 indexed term, address indexed holder, uint256 amount);

    /// @notice When `term` ended: from Governance's record, or the live
    /// term's end time if it has passed but no reset has happened yet.
    function termEndTime(uint256 companyId, uint256 term) public view returns (uint256) {
        uint256 current = governance.termNumber(companyId);
        if (term == 0 || term > current) return 0;
        uint256 endedAt = governance.termEndedAt(companyId, term);
        if (endedAt == 0 && term == current) {
            uint256 liveEnd = governance.governorTermEnd(companyId);
            if (liveEnd != 0 && block.timestamp >= liveEnd) endedAt = liveEnd;
        }
        return endedAt;
    }

    function openPolicyVote(uint256 companyId, uint256 term) external {
        uint256 endedAt = termEndTime(companyId, term);
        require(endedAt != 0, "CT: term not concluded");
        require(policyVoteEnd[companyId][term] == 0, "CT: already opened");
        require(roundAuction.sharesIssuedAt(companyId, endedAt) > 0, "CT: no shares issued");
        policyRecordDate[companyId][term] = endedAt;
        policyVoteEnd[companyId][term] = block.timestamp + POLICY_VOTE_WINDOW;
        emit PolicyVoteOpened(companyId, term, policyVoteEnd[companyId][term], endedAt);
    }

    function votePolicy(uint256 companyId, uint256 term, bool wantsDividend) external {
        uint256 voteEnd = policyVoteEnd[companyId][term];
        require(voteEnd != 0 && block.timestamp < voteEnd, "CT: voting not open");
        require(!policyHasVoted[companyId][term][msg.sender], "CT: already voted");
        uint256 weight = roundAuction.shareCountAt(companyId, msg.sender, policyRecordDate[companyId][term]);
        require(weight > 0, "CT: no shares at record date");
        policyHasVoted[companyId][term][msg.sender] = true;
        if (wantsDividend) policyDividendWeight[companyId][term] += weight;
        else policyReinvestWeight[companyId][term] += weight;
        emit PolicyVoted(companyId, term, msg.sender, wantsDividend, weight);
    }

    function resolvePolicyVote(uint256 companyId, uint256 term) external {
        uint256 voteEnd = policyVoteEnd[companyId][term];
        require(voteEnd != 0, "CT: not opened");
        require(block.timestamp >= voteEnd, "CT: voting still open");
        require(!policyResolved[companyId][term], "CT: already resolved");
        policyResolved[companyId][term] = true;
        if (policyDividendWeight[companyId][term] > policyReinvestWeight[companyId][term]) {
            (, uint256 capital) = _company(companyId);
            uint256 amount = (capital * TERM_END_DIVIDEND_BPS) / 10_000;
            uint256 issued = roundAuction.sharesIssuedAt(companyId, policyRecordDate[companyId][term]);
            uint256 perShare = (amount * 1e18) / issued;
            if (perShare > 0) {
                roundAuction.adjustCapital(companyId, -int256(amount)); // real tokens arrive here
                dividendPerShare[companyId][term] = perShare;
                dividendRemaining[companyId][term] = amount;
                emit PolicyResolved(companyId, term, true, amount);
                return;
            }
        }
        emit PolicyResolved(companyId, term, false, 0);
    }

    /// @notice What `holder` can claim for a term (0 if already claimed).
    function dividendOwed(uint256 companyId, uint256 term, address holder) public view returns (uint256) {
        if (!policyResolved[companyId][term] || claimedDividend[companyId][term][holder]) return 0;
        uint256 held = roundAuction.shareCountAt(companyId, holder, policyRecordDate[companyId][term]);
        return (held * dividendPerShare[companyId][term]) / 1e18;
    }

    function claimDividend(uint256 companyId, uint256 term) external {
        uint256 amount = _takeDividend(companyId, term, msg.sender);
        investToken.transfer(msg.sender, amount);
    }

    /// @notice A governor claims the dividend owed to shares their company
    /// holds in another company; it becomes that company's reinvestable income.
    function claimDividendAsCorporation(uint256 fromCompanyId, uint256 dividendCompanyId, uint256 term) external onlyGovernor(fromCompanyId) {
        uint256 amount = _takeDividend(dividendCompanyId, term, roundAuction.corporateHolder(fromCompanyId));
        investToken.transfer(address(roundAuction), amount);
        roundAuction.addReinvestableIncome(fromCompanyId, amount);
    }

    function _takeDividend(uint256 companyId, uint256 term, address holder) internal returns (uint256 amount) {
        require(policyResolved[companyId][term], "CT: not resolved");
        require(!claimedDividend[companyId][term][holder], "CT: already claimed");
        amount = dividendOwed(companyId, term, holder);
        require(amount > 0, "CT: nothing to claim");
        claimedDividend[companyId][term][holder] = true;
        dividendRemaining[companyId][term] -= amount; // can't underflow: entitlements sum to <= amount
        emit DividendClaimed(companyId, term, holder, amount);
    }

    // ---------------------------------------------------------------------
    // INVEST secondary market (on-ramp for non-citizens)
    // ---------------------------------------------------------------------

    mapping(address => bool) public approvedPaymentTokens;

    struct InvestOffer {
        address seller;
        uint256 investAmount;
        address paymentToken;
        uint256 paymentAmount;
        bool active;
        bool isCorporateOffer;
        uint256 creditCompanyId;
    }
    mapping(uint256 => InvestOffer) public investOffers;
    uint256 public nextInvestOfferId;

    event InvestOffered(uint256 indexed offerId, address indexed seller, uint256 investAmount, address paymentToken, uint256 paymentAmount);
    event InvestSold(uint256 indexed offerId, address seller, address indexed buyer, uint256 investAmount, address paymentToken, uint256 paymentAmount);
    event InvestOfferCancelled(uint256 indexed offerId);
    event PaymentTokenApprovalSet(address indexed token, bool approved);

    function setApprovedPaymentToken(address token, bool approved) external onlyOwner {
        require(token != address(investToken), "CT: INVEST can't be a payment token");
        approvedPaymentTokens[token] = approved;
        emit PaymentTokenApprovalSet(token, approved);
    }

    function offerInvest(uint256 investAmount, address paymentToken, uint256 paymentAmount) external {
        require(approvedPaymentTokens[paymentToken], "CT: payment token not approved");
        require(investAmount > 0 && paymentAmount > 0, "CT: amounts must be > 0");
        investToken.transferFrom(msg.sender, address(this), investAmount);
        _offer(msg.sender, investAmount, paymentToken, paymentAmount, false, 0);
    }

    /// @notice A governor sells some of the company's INVEST capital for an
    /// approved payment token, credited to the company's custody balance.
    function governorOfferInvest(uint256 companyId, uint256 investAmount, address paymentToken, uint256 paymentAmount) external onlyGovernor(companyId) {
        require(approvedPaymentTokens[paymentToken], "CT: payment token not approved");
        require(investAmount > 0 && paymentAmount > 0, "CT: amounts must be > 0");
        roundAuction.adjustCapital(companyId, -int256(investAmount)); // reverts if capital is short
        _offer(roundAuction.corporateHolder(companyId), investAmount, paymentToken, paymentAmount, true, companyId);
    }

    function _offer(address seller, uint256 investAmount, address paymentToken, uint256 paymentAmount, bool corp, uint256 creditId) internal {
        investOffers[nextInvestOfferId] = InvestOffer(seller, investAmount, paymentToken, paymentAmount, true, corp, creditId);
        emit InvestOffered(nextInvestOfferId, seller, investAmount, paymentToken, paymentAmount);
        nextInvestOfferId++;
    }

    function buyInvest(uint256 offerId) external {
        InvestOffer storage o = investOffers[offerId];
        require(o.active, "CT: not active");
        o.active = false;
        if (o.isCorporateOffer) {
            uint256 before = IERC20(o.paymentToken).balanceOf(address(this));
            IERC20(o.paymentToken).safeTransferFrom(msg.sender, address(this), o.paymentAmount);
            companyTokenBalance[o.creditCompanyId][o.paymentToken] += IERC20(o.paymentToken).balanceOf(address(this)) - before;
        } else {
            IERC20(o.paymentToken).safeTransferFrom(msg.sender, o.seller, o.paymentAmount);
        }
        investToken.transfer(msg.sender, o.investAmount);
        emit InvestSold(offerId, o.seller, msg.sender, o.investAmount, o.paymentToken, o.paymentAmount);
    }

    function cancelInvestOffer(uint256 offerId) external {
        InvestOffer storage o = investOffers[offerId];
        require(o.active, "CT: not active");
        o.active = false;
        if (o.isCorporateOffer) {
            require(msg.sender == governance.governorOperatingKey(o.creditCompanyId), "CT: not operating key");
            _creditCapital(o.creditCompanyId, o.investAmount);
        } else {
            require(msg.sender == o.seller, "CT: not seller");
            investToken.transfer(o.seller, o.investAmount);
        }
        emit InvestOfferCancelled(offerId);
    }
}
