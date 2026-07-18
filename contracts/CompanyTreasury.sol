// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./InvestToken.sol";
import "./ShareAuction.sol";

/// @title CompanyTreasury
/// @notice Everything a company's governor can do that doesn't require
/// touching a Share NFT directly lives here instead of in ShareAuction —
/// split into its own contract purely because ShareAuction's deployed
/// bytecode exceeded Ethereum's 24,576-byte limit (EIP-170) once this much
/// functionality was added. This contract reads company/governor/share
/// state from ShareAuction directly (it's a real import, not just an
/// interface) and calls back into ShareAuction.adjustCapital() — a
/// function restricted to only this contract's address — whenever a
/// company's INVEST capital needs to move.
///
/// FICTIONAL SIMULATION. Not a real financial product, security, or claim
/// on any real-world asset. Any resemblance to real entities is a
/// gamified rule-set only.
contract CompanyTreasury is Ownable {
    using SafeERC20 for IERC20;

    string public constant DISCLAIMER = "FICTIONAL SIMULATION. Not a real financial product, security, or claim on any real-world asset. Any resemblance to real entities is a gamified rule-set only.";

    InvestToken public immutable investToken;
    ShareAuction public immutable shareAuction;

    constructor(address _investToken, address _shareAuction) Ownable(msg.sender) {
        investToken = InvestToken(_investToken);
        shareAuction = ShareAuction(_shareAuction);
    }

    /// @dev Mirrors ShareAuction's onlyGovernor: checks the term's
    /// registered OPERATING KEY (not the elected officeholder's personal
    /// wallet) and that the term hasn't expired.
    modifier onlyGovernor(uint256 companyId) {
        require(msg.sender == shareAuction.governorOperatingKey(companyId), "CompanyTreasury: not the current operating key");
        require(block.timestamp < shareAuction.governorTermEnd(companyId), "CompanyTreasury: term expired");
        _;
    }

    function _companyShares(uint256 companyId, address holder) internal view returns (uint256) {
        return shareAuction.companyShareCount(companyId, holder);
    }

    // ---------------------------------------------------------------------
    // Dividend during a governor's own term (distinct from the mandatory
    // end-of-term vote below — this is the sitting governor's own choice).
    // ---------------------------------------------------------------------

    event DividendDistributed(uint256 indexed companyId, uint256 totalAmount);

    /// @notice Governor-only: pays INVEST capital out to the supplied
    /// holder list, pro-rata to shares held. The caller supplies the list
    /// because Solidity can't enumerate "everyone who holds a share" on
    /// its own — see ShareAuction's companyShareCount for the source data.
    function distribute(uint256 companyId, address[] calldata holders, uint256 amount) external onlyGovernor(companyId) {
        (, , uint256 sharesIssued, , , , uint256 capital) = shareAuction.companies(companyId);
        require(capital >= amount, "CompanyTreasury: insufficient capital");
        require(sharesIssued > 0, "CompanyTreasury: no shares issued");
        shareAuction.adjustCapital(companyId, -int256(amount));
        for (uint256 i = 0; i < holders.length; i++) {
            uint256 held = _companyShares(companyId, holders[i]);
            if (held == 0) continue;
            uint256 cut = (amount * held) / sharesIssued;
            if (cut > 0) investToken.transfer(holders[i], cut);
        }
        emit DividendDistributed(companyId, amount);
    }

    // ---------------------------------------------------------------------
    // Multi-asset custody: what a company holds beyond INVEST.
    // ---------------------------------------------------------------------

    mapping(uint256 => mapping(address => uint256)) public companyTokenBalance;

    event TokenDeposited(uint256 indexed companyId, address indexed token, address indexed from, uint256 amount);
    event TokenWithdrawn(uint256 indexed companyId, address indexed token, address indexed to, uint256 amount);

    function depositToken(uint256 companyId, address token, uint256 amount) external {
        (string memory name, , , , , , ) = shareAuction.companies(companyId);
        require(bytes(name).length > 0, "CompanyTreasury: unknown company");
        require(amount > 0, "CompanyTreasury: amount must be > 0");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        companyTokenBalance[companyId][token] += amount;
        emit TokenDeposited(companyId, token, msg.sender, amount);
    }

    /// @notice The governor's UNILATERAL reach into any single ERC-20 a
    /// company holds is capped at 5% of that asset's balance at the start
    /// of their term — snapshotted the first time that asset is touched
    /// this term, not recomputed live (a live cap is gameable by
    /// deposit-drain-deposit cycling). Anything beyond 5% cannot move via
    /// withdrawToken() at all; it has to go through openTreasuryAuction()
    /// (sell at market, commit-reveal) or proposeVendorPayment() (a fixed
    /// payment to a named party, requiring a 51% shareholder vote).
    uint256 public constant FREE_TIER_BPS = 500; // 5%
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public termTokenSnapshot;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public termTokenSnapshotTaken;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public termTokenFreeSpent;

    function _spendFreeAllowance(uint256 companyId, address token, uint256 amount) internal returns (bool ok) {
        uint256 term = shareAuction.termNumber(companyId);
        if (!termTokenSnapshotTaken[companyId][term][token]) {
            termTokenSnapshot[companyId][term][token] = companyTokenBalance[companyId][token];
            termTokenSnapshotTaken[companyId][term][token] = true;
        }
        uint256 freeCap = (termTokenSnapshot[companyId][term][token] * FREE_TIER_BPS) / 10_000;
        uint256 spent = termTokenFreeSpent[companyId][term][token];
        if (spent + amount > freeCap) return false;
        termTokenFreeSpent[companyId][term][token] = spent + amount;
        return true;
    }

    /// @notice Governor-only, and ONLY within the 5% free tier for this
    /// asset this term. This is deliberately the one function that can
    /// send company funds to an address the governor alone picked — which
    /// is why it's capped instead of open-ended the way the original
    /// version of this function was.
    function withdrawToken(uint256 companyId, address token, address to, uint256 amount) external onlyGovernor(companyId) {
        require(companyTokenBalance[companyId][token] >= amount, "CompanyTreasury: insufficient balance");
        require(_spendFreeAllowance(companyId, token, amount), "CompanyTreasury: exceeds 5% free allowance this term - use openTreasuryAuction or proposeVendorPayment");
        companyTokenBalance[companyId][token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit TokenWithdrawn(companyId, token, to, amount);
    }

    // ---------------------------------------------------------------------
    // Path 1 above 5%: sell at market via commit-reveal. The governor
    // never learns who's bidding what until after bidding closes, and
    // settlement is fully permissionless — no governor signature is
    // involved anywhere in settlement, which is the actual fix for
    // "governor picks who wins."
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
        bool settled;
    }
    struct SealedBid {
        bytes32 commitHash;
        uint256 deposit;
        bool revealed;
        uint256 revealedAmount;
    }
    mapping(uint256 => TreasuryAuction) public treasuryAuctions;
    mapping(uint256 => mapping(address => SealedBid)) public treasuryBids;
    mapping(uint256 => address[]) public treasuryBidders;
    uint256 public nextTreasuryAuctionId;

    event TreasuryAuctionOpened(uint256 indexed auctionId, uint256 indexed companyId, address token, uint256 amount, uint256 commitEnd, uint256 revealEnd);
    event BidCommitted(uint256 indexed auctionId, address indexed bidder);
    event BidRevealed(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event TreasuryAuctionSettled(uint256 indexed auctionId, address winner, uint256 winningAmount);

    function openTreasuryAuction(uint256 companyId, address token, uint256 amount) external onlyGovernor(companyId) returns (uint256 auctionId) {
        require(amount > 0, "CompanyTreasury: amount must be > 0");
        require(companyTokenBalance[companyId][token] >= amount, "CompanyTreasury: insufficient balance");
        companyTokenBalance[companyId][token] -= amount; // reserved until settled
        auctionId = nextTreasuryAuctionId++;
        uint256 commitEnd = block.timestamp + COMMIT_WINDOW;
        uint256 revealEnd = commitEnd + REVEAL_WINDOW;
        treasuryAuctions[auctionId] = TreasuryAuction(companyId, token, amount, commitEnd, revealEnd, false);
        emit TreasuryAuctionOpened(auctionId, companyId, token, amount, commitEnd, revealEnd);
    }

    /// @notice Locks a small refundable-if-honest deposit against a sealed
    /// bid. The bid amount itself stays hidden until revealBid().
    function commitBid(uint256 auctionId, bytes32 commitHash) external {
        TreasuryAuction storage a = treasuryAuctions[auctionId];
        require(block.timestamp < a.commitEnd, "CompanyTreasury: commit window closed");
        require(treasuryBids[auctionId][msg.sender].commitHash == bytes32(0), "CompanyTreasury: already committed");
        investToken.transferFrom(msg.sender, address(this), bidDepositAmount);
        treasuryBids[auctionId][msg.sender] = SealedBid(commitHash, bidDepositAmount, false, 0);
        treasuryBidders[auctionId].push(msg.sender);
        emit BidCommitted(auctionId, msg.sender);
    }

    /// @notice Reveals a bid by proving the pre-image of the committed hash
    /// (recommended: keccak256(abi.encodePacked(amount, salt, msg.sender)))
    /// and simultaneously escrows the full revealed amount, so settlement
    /// never depends on a revealed bidder still having funds later.
    function revealBid(uint256 auctionId, uint256 amount, bytes32 salt) external {
        TreasuryAuction storage a = treasuryAuctions[auctionId];
        require(block.timestamp >= a.commitEnd && block.timestamp < a.revealEnd, "CompanyTreasury: not reveal window");
        SealedBid storage b = treasuryBids[auctionId][msg.sender];
        require(b.commitHash != bytes32(0), "CompanyTreasury: no commit found");
        require(!b.revealed, "CompanyTreasury: already revealed");
        require(keccak256(abi.encodePacked(amount, salt, msg.sender)) == b.commitHash, "CompanyTreasury: hash mismatch");
        b.revealed = true;
        b.revealedAmount = amount;
        investToken.transferFrom(msg.sender, address(this), amount);
        emit BidRevealed(auctionId, msg.sender, amount);
    }

    /// @notice Fully permissionless — anyone can trigger settlement, no
    /// governor signature involved. Highest revealed bid wins;
    /// non-revealers forfeit their deposit to the company; losing revealed
    /// bidders get a full refund; if nobody reveals validly, the asset
    /// simply returns to the company's spendable balance, unsold.
    function settleTreasuryAuction(uint256 auctionId) external {
        TreasuryAuction storage a = treasuryAuctions[auctionId];
        require(block.timestamp >= a.revealEnd, "CompanyTreasury: reveal window still open");
        require(!a.settled, "CompanyTreasury: already settled");
        a.settled = true;

        address[] storage bidders = treasuryBidders[auctionId];
        address winner = address(0);
        uint256 winningAmount = 0;
        for (uint256 i = 0; i < bidders.length; i++) {
            SealedBid storage b = treasuryBids[auctionId][bidders[i]];
            if (b.revealed && b.revealedAmount > winningAmount) {
                winner = bidders[i];
                winningAmount = b.revealedAmount;
            }
        }

        for (uint256 i = 0; i < bidders.length; i++) {
            address bidder = bidders[i];
            SealedBid storage b = treasuryBids[auctionId][bidder];
            if (!b.revealed) {
                shareAuction.adjustCapital(a.companyId, int256(b.deposit)); // forfeited
            } else if (bidder == winner) {
                investToken.transfer(bidder, b.deposit); // deposit returned; bid amount is the payment
            } else {
                investToken.transfer(bidder, b.deposit + b.revealedAmount); // full refund
            }
        }

        if (winner != address(0)) {
            shareAuction.adjustCapital(a.companyId, int256(winningAmount));
            IERC20(a.token).safeTransfer(winner, a.amount);
        } else {
            companyTokenBalance[a.companyId][a.token] += a.amount; // unsold, return the reservation
        }
        emit TreasuryAuctionSettled(auctionId, winner, winningAmount);
    }

    // ---------------------------------------------------------------------
    // Path 2 above 5%: a fixed payment to a named party, requiring 51%
    // shareholder approval instead of a market mechanism — for real-world
    // invoices an auction can't express.
    // ---------------------------------------------------------------------

    uint256 public constant VENDOR_VOTE_WINDOW = 3 days;
    uint256 public constant ELECTION_THRESHOLD_BPS = 5100; // 51%, same bar as electing a governor

    struct VendorPayment {
        uint256 companyId;
        address token;
        address to;
        uint256 amount;
        uint256 voteEnd;
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
        require(amount > 0, "CompanyTreasury: amount must be > 0");
        require(companyTokenBalance[companyId][token] >= amount, "CompanyTreasury: insufficient balance");
        companyTokenBalance[companyId][token] -= amount; // reserved until the vote resolves
        paymentId = nextVendorPaymentId++;
        uint256 voteEnd = block.timestamp + VENDOR_VOTE_WINDOW;
        vendorPayments[paymentId] = VendorPayment(companyId, token, to, amount, voteEnd, 0, 0, false);
        emit VendorPaymentProposed(paymentId, companyId, token, to, amount);
    }

    function voteVendorPayment(uint256 paymentId, bool approve) external {
        VendorPayment storage p = vendorPayments[paymentId];
        require(block.timestamp < p.voteEnd, "CompanyTreasury: voting closed");
        require(!vendorPaymentVoted[paymentId][msg.sender], "CompanyTreasury: already voted");
        uint256 weight = _companyShares(p.companyId, msg.sender);
        require(weight > 0, "CompanyTreasury: not a shareholder");
        vendorPaymentVoted[paymentId][msg.sender] = true;
        if (approve) {
            p.yesWeight += weight;
        } else {
            p.noWeight += weight;
        }
        emit VendorPaymentVoted(paymentId, msg.sender, approve, weight);
    }

    function executeVendorPayment(uint256 paymentId) external {
        VendorPayment storage p = vendorPayments[paymentId];
        require(block.timestamp >= p.voteEnd, "CompanyTreasury: voting still open");
        require(!p.executed, "CompanyTreasury: already executed");
        p.executed = true;
        uint256 total = p.yesWeight + p.noWeight;
        bool approved = total > 0 && p.yesWeight * 10_000 >= total * ELECTION_THRESHOLD_BPS;
        if (approved) {
            IERC20(p.token).safeTransfer(p.to, p.amount);
        } else {
            companyTokenBalance[p.companyId][p.token] += p.amount; // rejected, return the reservation
        }
        emit VendorPaymentExecuted(paymentId, approved);
    }

    function setBidDepositAmount(uint256 amount) external onlyOwner {
        bidDepositAmount = amount;
    }

    // ---------------------------------------------------------------------
    // Mandatory end-of-term policy vote: 1% dividend, or reinvest.
    // Separate from — and in addition to — anything the sitting governor
    // chose to do with distribute() during their own term.
    // ---------------------------------------------------------------------

    uint256 public constant POLICY_VOTE_WINDOW = 3 days;
    uint256 public constant TERM_END_DIVIDEND_BPS = 100; // 1%
    mapping(uint256 => mapping(uint256 => uint256)) public policyVoteEnd;
    mapping(uint256 => mapping(uint256 => bool)) public policyResolved;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public policyHasVoted;
    mapping(uint256 => mapping(uint256 => uint256)) public policyDividendWeight;
    mapping(uint256 => mapping(uint256 => uint256)) public policyReinvestWeight;

    event PolicyVoteOpened(uint256 indexed companyId, uint256 indexed term, uint256 voteEnd);
    event PolicyVoted(uint256 indexed companyId, uint256 indexed term, address indexed voter, bool wantsDividend, uint256 weight);
    event PolicyResolved(uint256 indexed companyId, uint256 indexed term, bool distributedDividend, uint256 amount);

    /// @notice Works whether or not ShareAuction.startNewTerm() has already
    /// reset the live governorTermEnd for a newer term — ShareAuction
    /// archives each outgoing term's end time in termEndedAt automatically
    /// the moment the next governor is installed.
    function openPolicyVote(uint256 companyId, uint256 term) external {
        uint256 currentTerm = shareAuction.termNumber(companyId);
        require(term > 0 && term <= currentTerm, "CompanyTreasury: invalid term");
        uint256 endedAt = shareAuction.termEndedAt(companyId, term);
        if (endedAt == 0 && term == currentTerm) {
            uint256 liveEnd = shareAuction.governorTermEnd(companyId);
            require(block.timestamp >= liveEnd, "CompanyTreasury: term not over yet");
            endedAt = liveEnd;
        }
        require(endedAt != 0, "CompanyTreasury: term not concluded");
        require(policyVoteEnd[companyId][term] == 0, "CompanyTreasury: already opened");
        (, , uint256 sharesIssued, , , , ) = shareAuction.companies(companyId);
        require(sharesIssued > 0, "CompanyTreasury: no shares issued");
        policyVoteEnd[companyId][term] = block.timestamp + POLICY_VOTE_WINDOW;
        emit PolicyVoteOpened(companyId, term, policyVoteEnd[companyId][term]);
    }

    function votePolicy(uint256 companyId, uint256 term, bool wantsDividend) external {
        require(policyVoteEnd[companyId][term] != 0 && block.timestamp < policyVoteEnd[companyId][term], "CompanyTreasury: voting not open");
        require(!policyHasVoted[companyId][term][msg.sender], "CompanyTreasury: already voted");
        uint256 weight = _companyShares(companyId, msg.sender);
        require(weight > 0, "CompanyTreasury: not a shareholder");
        policyHasVoted[companyId][term][msg.sender] = true;
        if (wantsDividend) {
            policyDividendWeight[companyId][term] += weight;
        } else {
            policyReinvestWeight[companyId][term] += weight;
        }
        emit PolicyVoted(companyId, term, msg.sender, wantsDividend, weight);
    }

    function resolvePolicyVote(uint256 companyId, uint256 term, address[] calldata holders) external {
        require(policyVoteEnd[companyId][term] != 0, "CompanyTreasury: not opened");
        require(block.timestamp >= policyVoteEnd[companyId][term], "CompanyTreasury: voting still open");
        require(!policyResolved[companyId][term], "CompanyTreasury: already resolved");
        policyResolved[companyId][term] = true;

        if (policyDividendWeight[companyId][term] > policyReinvestWeight[companyId][term]) {
            (, , uint256 sharesIssued, , , , uint256 capital) = shareAuction.companies(companyId);
            uint256 amount = (capital * TERM_END_DIVIDEND_BPS) / 10_000;
            if (amount > 0 && sharesIssued > 0) {
                shareAuction.adjustCapital(companyId, -int256(amount));
                for (uint256 i = 0; i < holders.length; i++) {
                    uint256 held = _companyShares(companyId, holders[i]);
                    if (held == 0) continue;
                    uint256 cut = (amount * held) / sharesIssued;
                    if (cut > 0) investToken.transfer(holders[i], cut);
                }
                emit PolicyResolved(companyId, term, true, amount);
                return;
            }
        }
        emit PolicyResolved(companyId, term, false, 0);
    }

    // ---------------------------------------------------------------------
    // INVEST secondary market — the on-ramp for anyone who wasn't an
    // original citizen. See InvestToken.sol / README for the full picture.
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
        require(token != address(investToken), "CompanyTreasury: INVEST itself can't be a payment token");
        approvedPaymentTokens[token] = approved;
        emit PaymentTokenApprovalSet(token, approved);
    }

    /// @notice A citizen offers some of their own INVEST for sale, escrowed
    /// here immediately so a buyer can trust the offer is real.
    function offerInvest(uint256 investAmount, address paymentToken, uint256 paymentAmount) external {
        require(approvedPaymentTokens[paymentToken], "CompanyTreasury: payment token not approved");
        require(investAmount > 0 && paymentAmount > 0, "CompanyTreasury: amounts must be > 0");
        investToken.transferFrom(msg.sender, address(this), investAmount);
        investOffers[nextInvestOfferId] = InvestOffer(msg.sender, investAmount, paymentToken, paymentAmount, true, false, 0);
        emit InvestOffered(nextInvestOfferId, msg.sender, investAmount, paymentToken, paymentAmount);
        nextInvestOfferId++;
    }

    /// @notice Governor equivalent: sells down the COMPANY's own held
    /// INVEST capital for an approved ERC-20, which becomes part of that
    /// company's token treasury instead of going to any individual.
    function governorOfferInvest(uint256 companyId, uint256 investAmount, address paymentToken, uint256 paymentAmount) external onlyGovernor(companyId) {
        require(approvedPaymentTokens[paymentToken], "CompanyTreasury: payment token not approved");
        require(investAmount > 0 && paymentAmount > 0, "CompanyTreasury: amounts must be > 0");
        (, , , , , , uint256 capital) = shareAuction.companies(companyId);
        require(capital >= investAmount, "CompanyTreasury: insufficient capital");
        shareAuction.adjustCapital(companyId, -int256(investAmount));
        address corp = shareAuction.corporateHolder(companyId);
        investOffers[nextInvestOfferId] = InvestOffer(corp, investAmount, paymentToken, paymentAmount, true, true, companyId);
        emit InvestOffered(nextInvestOfferId, corp, investAmount, paymentToken, paymentAmount);
        nextInvestOfferId++;
    }

    function buyInvest(uint256 offerId) external {
        InvestOffer storage o = investOffers[offerId];
        require(o.active, "CompanyTreasury: not active");
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
        require(o.active, "CompanyTreasury: not active");
        o.active = false;
        if (o.isCorporateOffer) {
            require(msg.sender == shareAuction.governorOperatingKey(o.creditCompanyId), "CompanyTreasury: not the current operating key");
            shareAuction.adjustCapital(o.creditCompanyId, int256(o.investAmount));
        } else {
            require(msg.sender == o.seller, "CompanyTreasury: not seller");
            investToken.transfer(o.seller, o.investAmount);
        }
        emit InvestOfferCancelled(offerId);
    }
}
