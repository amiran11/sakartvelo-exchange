// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The parts of RoundAuction (v8) that Governance reads.
interface IShareRegistry {
    function companies(uint256 companyId) external view returns (
        string memory name, uint256 totalShares, uint256 sharesIssued, uint256 currentRound,
        uint256 roundEnd, uint256 roundDuration, bool finalized, uint256 firstMintedAt, uint256 capital
    );
    function companyShareCount(uint256 companyId, address holder) external view returns (uint256);
    function shareCountAt(uint256 companyId, address holder, uint256 ts) external view returns (uint256);
    function corporateHolder(uint256 companyId) external pure returns (address);
}

/// @title Governance
/// @notice Per-company elections, governor terms and operating keys for
/// Sakartvelo Exchange. Split out of RoundAuction in v8 (it was the same
/// logic, ported from ShareAuction) to keep RoundAuction under the
/// contract size limit.
///
/// Rules, unchanged from v7 except where marked:
///   - Governance opens once at least 50% of a company's shares are issued.
///   - Shareholders declare candidacy with a written program; voting runs
///     in 3-day rounds. 51% of votes cast wins outright; otherwise the top
///     two go to a runoff. With two or fewer candidates left, the leader wins.
///   - The winner governs for 30 days, acting through an operating key
///     they register (a separate wallet), never their own wallet.
///   - CHANGED (Finding 9): a round that closes with zero votes reopens
///     for another 3 days instead of locking the company forever.
///   - CHANGED (Finding 10): at most 20 candidates per election, each
///     holding at least 0.1% of the shares issued so far; candidacy closes
///     once voting opens.
///   - CHANGED (Finding 20): round ids keep counting up across terms, so a
///     new term's election never inherits the previous term's votes.
///   - CHANGED (vote double-counting limitation): every vote is weighted by
///     the voter's shares one second BEFORE that round opened, so moving
///     shares to a second wallet mid-vote gains nothing.
///
/// FICTIONAL SIMULATION. Not a real financial product, security, or claim
/// on any real-world asset.
contract Governance {
    string public constant DISCLAIMER = "FICTIONAL SIMULATION. Not a real financial product, security, or claim on any real-world asset. Any resemblance to real entities is a gamified rule-set only.";

    IShareRegistry public immutable shares;

    uint256 public constant GOVERNANCE_VOTE_WINDOW = 3 days;
    uint256 public constant TERM_LENGTH = 30 days;
    uint256 public constant MAX_PROGRAM_BYTES = 4500; // ~700 words
    uint256 public constant ELECTION_THRESHOLD_BPS = 5100; // 51%
    uint256 public constant MAX_CANDIDATES = 20;
    uint256 public constant MIN_CANDIDATE_STAKE_BPS = 10; // 0.1% of shares issued so far

    struct Candidate {
        string program;
        bool registered;
    }
    mapping(uint256 => mapping(address => Candidate)) public candidates;
    mapping(uint256 => address[]) public candidateList;
    mapping(uint256 => mapping(address => bool)) public eliminated;

    mapping(uint256 => uint256) public governanceRound; // active round id, 0 = candidacy phase
    // Round ids never repeat for a company, across all terms (Finding 20:
    // v7 restarted at round 1 every term, so the previous term's votes and
    // "already voted" flags carried into the new election).
    mapping(uint256 => uint256) public lastRoundId;
    mapping(uint256 => uint256) public governanceVoteEnd;
    mapping(uint256 => mapping(uint256 => uint256)) public roundSnapshot; // companyId => round => balance timestamp
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public roundVotes;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public roundHasVoted;
    mapping(uint256 => mapping(uint256 => uint256)) public roundTotalVotesCast;

    mapping(uint256 => address) public companyGovernor;
    mapping(uint256 => uint256) public governorTermEnd;
    mapping(uint256 => uint256) public termNumber;
    mapping(uint256 => address) public governorOperatingKey;
    mapping(uint256 => mapping(uint256 => uint256)) public termEndedAt;

    event GovernanceOpened(uint256 indexed companyId, uint256 voteEnd);
    event VotingReopened(uint256 indexed companyId, uint256 round, uint256 newVoteEnd);
    event CandidateDeclared(uint256 indexed companyId, address indexed candidate, string program);
    event Voted(uint256 indexed companyId, uint256 indexed round, address indexed voter, address candidate, uint256 weight);
    event RoundAdvanced(uint256 indexed companyId, uint256 newRound, address firstPlace, address secondPlace);
    event GovernorElected(uint256 indexed companyId, address indexed governor, uint256 winningVotes, uint256 termEnd);
    event NewTermStarted(uint256 indexed companyId);
    event OperatingKeySet(uint256 indexed companyId, address indexed governor, address indexed operatingKey);

    constructor(address _shares) {
        require(_shares != address(0), "GOV: zero address");
        shares = IShareRegistry(_shares);
    }

    function _issued(uint256 companyId) internal view returns (uint256 totalShares, uint256 sharesIssued) {
        (, totalShares, sharesIssued, , , , , , ) = shares.companies(companyId);
    }

    function _requireEligible(uint256 companyId) internal view returns (uint256 sharesIssued) {
        uint256 totalShares;
        (totalShares, sharesIssued) = _issued(companyId);
        require(totalShares > 0, "GOV: unknown company");
        require(sharesIssued * 2 >= totalShares, "GOV: under 50% assigned");
    }

    function candidateCount(uint256 companyId) external view returns (uint256) {
        return candidateList[companyId].length;
    }

    function declareCandidacy(uint256 companyId, string calldata program) external {
        uint256 sharesIssued = _requireEligible(companyId);
        require(governanceRound[companyId] == 0, "GOV: candidacy closed");
        require(candidateList[companyId].length < MAX_CANDIDATES, "GOV: candidates full");
        require(!candidates[companyId][msg.sender].registered, "GOV: already candidate");
        require(bytes(program).length <= MAX_PROGRAM_BYTES, "GOV: program too long");
        uint256 held = shares.companyShareCount(companyId, msg.sender);
        require(held > 0, "GOV: not a shareholder");
        require(held * 10_000 >= sharesIssued * MIN_CANDIDATE_STAKE_BPS, "GOV: stake below 0.1%");
        candidates[companyId][msg.sender] = Candidate(program, true);
        candidateList[companyId].push(msg.sender);
        emit CandidateDeclared(companyId, msg.sender, program);
    }

    /// @notice Anyone can open voting once at least one candidate exists.
    function openGovernanceVote(uint256 companyId) external {
        _requireEligible(companyId);
        require(governanceRound[companyId] == 0, "GOV: already open");
        require(candidateList[companyId].length > 0, "GOV: no candidates yet");
        _startRound(companyId);
        emit GovernanceOpened(companyId, governanceVoteEnd[companyId]);
    }

    function _startRound(uint256 companyId) internal returns (uint256 round) {
        round = ++lastRoundId[companyId];
        governanceRound[companyId] = round;
        governanceVoteEnd[companyId] = block.timestamp + GOVERNANCE_VOTE_WINDOW;
        roundSnapshot[companyId][round] = block.timestamp - 1;
    }

    function vote(uint256 companyId, address candidate) external {
        _castVote(companyId, msg.sender, candidate);
    }

    /// @notice A company's governor votes the shares that company holds in
    /// another company (cross-holdings built through RoundAuction.invest()).
    function voteAsCorporation(uint256 fromCompanyId, uint256 toCompanyId, address candidate) external {
        require(msg.sender == governorOperatingKey[fromCompanyId], "GOV: not operating key");
        require(block.timestamp < governorTermEnd[fromCompanyId], "GOV: term expired");
        _castVote(toCompanyId, shares.corporateHolder(fromCompanyId), candidate);
    }

    function _castVote(uint256 companyId, address voter, address candidate) internal {
        uint256 round = governanceRound[companyId];
        require(round > 0 && companyGovernor[companyId] == address(0), "GOV: voting not open");
        require(block.timestamp < governanceVoteEnd[companyId], "GOV: voting closed");
        require(candidates[companyId][candidate].registered, "GOV: not a candidate");
        require(!eliminated[companyId][candidate], "GOV: eliminated");
        require(!roundHasVoted[companyId][round][voter], "GOV: already voted");
        uint256 weight = shares.shareCountAt(companyId, voter, roundSnapshot[companyId][round]);
        require(weight > 0, "GOV: no shares at snapshot");
        roundHasVoted[companyId][round][voter] = true;
        roundVotes[companyId][round][candidate] += weight;
        roundTotalVotesCast[companyId][round] += weight;
        emit Voted(companyId, round, voter, candidate, weight);
    }

    /// @notice Permissionless once a round's voting window has closed.
    function tallyRound(uint256 companyId) external {
        uint256 round = governanceRound[companyId];
        require(round > 0, "GOV: voting not open");
        require(block.timestamp >= governanceVoteEnd[companyId], "GOV: voting still open");
        require(companyGovernor[companyId] == address(0), "GOV: governor set");

        uint256 totalCast = roundTotalVotesCast[companyId][round];
        if (totalCast == 0) {
            // Finding 9: reopen instead of locking. Same round, same
            // candidates, same snapshot; nobody eliminated.
            governanceVoteEnd[companyId] = block.timestamp + GOVERNANCE_VOTE_WINDOW;
            emit VotingReopened(companyId, round, governanceVoteEnd[companyId]);
            return;
        }

        address[] storage list = candidateList[companyId];
        address first;
        address second;
        uint256 firstVotes;
        uint256 secondVotes;
        uint256 remaining;
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

        // totalCast > 0 guarantees `first` is a real candidate here.
        if (firstVotes * 10_000 >= totalCast * ELECTION_THRESHOLD_BPS || remaining <= 2) {
            _installGovernor(companyId, first, firstVotes);
            return;
        }

        for (uint256 i = 0; i < list.length; i++) {
            address cand = list[i];
            if (!eliminated[companyId][cand] && cand != first && cand != second) {
                eliminated[companyId][cand] = true;
            }
        }
        uint256 next = _startRound(companyId);
        emit RoundAdvanced(companyId, next, first, second);
    }

    function _installGovernor(uint256 companyId, address winner, uint256 winningVotes) internal {
        if (termNumber[companyId] > 0) {
            termEndedAt[companyId][termNumber[companyId]] = governorTermEnd[companyId];
        }
        termNumber[companyId] += 1;
        companyGovernor[companyId] = winner;
        governorTermEnd[companyId] = block.timestamp + TERM_LENGTH;
        governorOperatingKey[companyId] = address(0); // the new governor must register one
        emit GovernorElected(companyId, winner, winningVotes, governorTermEnd[companyId]);
    }

    /// @notice The elected governor registers (or replaces) the separate
    /// wallet that signs every governor action this term.
    function setOperatingKey(uint256 companyId, address operatingKey) external {
        require(msg.sender == companyGovernor[companyId], "GOV: not governor");
        require(block.timestamp < governorTermEnd[companyId], "GOV: term expired");
        require(operatingKey != address(0), "GOV: zero address");
        governorOperatingKey[companyId] = operatingKey;
        emit OperatingKeySet(companyId, msg.sender, operatingKey);
    }

    /// @notice Once a term has expired, anyone can reset the company for a
    /// fresh election. At most MAX_CANDIDATES entries to clear.
    function startNewTerm(uint256 companyId) external {
        require(companyGovernor[companyId] != address(0), "GOV: no governor");
        require(block.timestamp >= governorTermEnd[companyId], "GOV: term not over");
        address[] storage list = candidateList[companyId];
        for (uint256 i = 0; i < list.length; i++) {
            delete candidates[companyId][list[i]];
            delete eliminated[companyId][list[i]];
        }
        delete candidateList[companyId];
        // Record when this term ended now, so dividends for it can resolve
        // even if no later governor is ever elected.
        termEndedAt[companyId][termNumber[companyId]] = governorTermEnd[companyId];
        companyGovernor[companyId] = address(0);
        governorOperatingKey[companyId] = address(0);
        governorTermEnd[companyId] = 0;
        governanceRound[companyId] = 0;
        governanceVoteEnd[companyId] = 0;
        emit NewTermStarted(companyId);
    }
}
