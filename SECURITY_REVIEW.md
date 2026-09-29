# Internal Security Review — Sakartvelo Exchange

**This is a self-conducted internal review, not a professional third-party
audit.** It was performed by the project's own author, with AI assistance,
following the mitigation patterns and vulnerability classes documented in
the [SWC Registry](https://swcregistry.io/) (Smart Contract Weakness
Classification) and standard Solidity security practice. It should not be
treated as equivalent to, or a substitute for, a paid external audit by a
specialized security firm — closing that specific gap is an explicit,
ongoing goal (see [our SSRN paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7419018),
Section 6, and our Arbitrum Open House Singapore buildathon submission).

This document exists so that claims like "we did a self-audit" are
checkable, not just asserted — every finding below cites the exact commit
that introduced the fix, and the contracts themselves are independently
verified on [Arbiscan](https://arbiscan.io), Sourcify, and Blockscout, so
anyone can confirm the deployed bytecode matches this source.

Last updated: September 2026, alongside `RoundAuction` v7 / `CompanyTreasury` v5.

---

## Scope

`contracts/RoundAuction.sol` and `contracts/CompanyTreasury.sol` — the two
contracts that carry all real economic and governance logic for live
listings. `InvestToken.sol` and `OpenVerifier.sol` were reviewed at their
original deployment and have had no code changes since; `ShareAuction.sol`
is deployed and verified but currently carries no real listings.

## Methodology

Manual, line-by-line review against specific, named vulnerability classes
— not a general "read-through." Each check below was performed
deliberately and its result recorded, whether the outcome was a real
finding or a clean pass:

- Reentrancy / checks-effects-interactions ordering
- Access control on every state-changing function
- Unbounded-loop gas exhaustion (denial of service)
- Fund-distribution correctness (can value be lost, not just delayed)
- Front-running / timing manipulation on time-boxed processes

---

## Findings

### Finding 1 — Unbounded settlement cost in the original proportional auction (Critical, fixed)

**Where:** `RoundAuction.settleRound()` (and originally, its predecessor
in `ShareAuction.finalize()`)

**Issue:** An earlier version of the settlement logic had no cap on
shares minted per transaction. A company with a large total share count
could produce a settlement call expensive enough to exceed a block's gas
limit. Because a reverted transaction restores all prior state, this
failure would repeat identically on every retry — the listing would
become permanently unfinalizable, with every committed bidder's funds
locked inside it and no recovery path through the contract itself.

**Fix:** `MAX_SHARES_PER_ROUND` and `MAX_BIDS` hard caps, bounding
settlement cost independent of total share supply. This is the same
class of issue registered as
[SWC-128](https://swcregistry.io/docs/SWC-128) (Denial of Service with
Block Gas Limit); the fix applies its standard, documented mitigation —
spreading unbounded work across multiple calls rather than one.

**Formal verification:** This bound is stated and proven as **Proposition
1** in our published mechanism-design paper, not just asserted in code
comments.

**Commit:** [`23424e7`](https://github.com/amiran11/sakartvelo-exchange/commit/23424e7)

---

### Finding 2 — Missing bid cap in ShareAuction's original `invest()` (Medium, fixed proactively)

**Where:** `ShareAuction.invest()` (original), ported to `RoundAuction.invest()`

**Issue:** While porting ShareAuction's corporate cross-holding logic to
RoundAuction, we found the original `invest()` function had no
`MAX_BIDS` check at all — meaning a corporate investment could bypass
the same bid-cap protection every other bidding path enforced.

**Fix:** Added the same `bids[toCompanyId].length < MAX_BIDS` check to
RoundAuction's version before this code was ever deployed as the live
mechanism.

**Commit:** [`4017a70`](https://github.com/amiran11/sakartvelo-exchange/commit/4017a70)

---

### Finding 3 — Unbounded bidder array in treasury auctions (High, fixed)

**Where:** `CompanyTreasury.commitBid()` / `settleTreasuryAuction()`

**Issue:** The commit-reveal treasury auction mechanism had no cap on
the number of bidders per auction. `settleTreasuryAuction()` loops over
every committed bidder twice (once to find the winner, once to
refund/pay everyone) — the same unbounded-gas class as Finding 1, just
present in a different contract and not caught during the original
port.

**Impact if left unfixed:** A treasury auction with enough committed
bidders could become too expensive to ever settle — permanently locking
both the asset being auctioned and every bidder's escrowed deposit and
revealed bid amount, with no recovery path.

**Fix:** `MAX_BIDDERS = 500` cap enforced in `commitBid()`, mirroring
the existing `MAX_BIDS` pattern used elsewhere in the codebase.

**Commit:** [`15d748f`](https://github.com/amiran11/sakartvelo-exchange/commit/15d748f)

---

### Finding 4 — Permanent fund loss from incomplete dividend distribution list (Critical, fixed)

**Where:** `CompanyTreasury.resolvePolicyVote()`

**Issue:** The original dividend-distribution function was permissionless
and took a caller-supplied `address[] holders` array, paying each
address directly in a loop. `policyResolved` locked to `true`
immediately and permanently. The full dividend amount was deducted from
company capital regardless of whether the supplied list was complete.
If any real shareholder was missing from that list — by accident or by
a malicious caller — their portion of the dividend was not delayed, it
was **destroyed**: already deducted from capital, never paid to anyone,
and the resolution could never be re-run for that term.

This is a genuine fund-loss bug, not merely a denial-of-service risk —
the most serious finding in this review.

**Fix:** Distribution changed from a push pattern (one caller pays
everyone) to a pull pattern (each shareholder claims their own share).
`resolvePolicyVote()` now only computes and stores a per-share rate; a
new `claimDividend(companyId, term)` function lets any shareholder claim
their own cut, whenever they choose. This removes the incomplete-list
risk entirely, and as a side effect also removes the last unbounded-loop
gas risk in the contract, since there is no longer a holders loop in
this function at all.

**Stated tradeoff, not hidden:** `claimDividend()` reads *current* share
count at claim time, not a historical snapshot from the moment of
resolution. A shareholder who transfers their shares away before
claiming forfeits that term's dividend to whoever holds the shares when
it is claimed — the same "record date" tradeoff ordinary dividend
systems make explicitly, made implicit here by using live ownership. A
full historical-snapshot system would close this too, and is noted
below as a direction for further work, not swept under the rug. Small
rounding dust from integer division may also go unclaimed in
aggregate — negligible and bounded, not a fund-loss risk like the
pattern this replaced.

**Commit:** [`5e41fa5`](https://github.com/amiran11/sakartvelo-exchange/commit/5e41fa5)

---

## Reviewed and verified safe (not just untested)

Listed explicitly, not just implied by omission — a real review reports
clean passes, not only problems:

- **`withdrawHostFees()`, `buyShare()`, `settleTreasuryAuction()`:**
  correct checks-effects-interactions ordering — state changes (flags,
  balances) are set *before* any external call, not after.
- **`setOperatingKey()`, `onlyGovernor` modifier, `onlyTreasury`
  modifier:** correct access control, checked against the actual
  authorized address in every case, not merely assumed from a variable
  name.
- **All `InvestToken.transfer()` / `transferFrom()` calls:** no
  reentrancy risk, since `InvestToken` is a plain, first-party
  OpenZeppelin-based ERC-20 with no external callback hooks (not an
  ERC-777-style token) — an attacker-supplied malicious token contract
  is not a relevant threat model here, since `InvestToken`'s address is
  fixed and trusted, not user-suppliable.
- **`distribute()` and the mid-term (non-policy) dividend path's
  `holders` loop:** also caller-supplied, but explicitly lower severity
  than Finding 4 — this one is restricted to the sitting governor
  (`onlyGovernor`), is not gated by a permanent one-shot `resolved`
  flag, and can be called again by the same governor to cover any
  addresses missed the first time. Self-limiting, not a public attack
  surface against other users' funds.

---

## Known, disclosed, unresolved limitations

Consistent with the limitations already stated plainly in our academic
paper — not new information, restated here for completeness in one
place:

- **No proof-of-personhood.** Citizen verification (`OpenVerifier`) is
  gated by a minimum wallet ETH balance, which raises the cost of
  trivial wallet farming but does not prevent a well-capitalized actor
  from controlling multiple verified identities.
- **Vote-weight double-counting via share transfer.** `votePolicy()`
  weight is read live at the moment of voting, and "has voted" is
  tracked per-address. Since shares become transferable after their
  7-day lock period, a shareholder could vote, transfer their shares to
  a second wallet they also control, and vote again — double-counting
  the same underlying shares' voting power in a policy (dividend vs.
  reinvest) vote. This is the same class of Sybil-resistance limitation
  already disclosed for citizen verification generally, newly
  identified here as applying specifically to policy voting. Not yet
  fixed; a full fix requires either share-based vote snapshotting or a
  stronger identity layer, both larger changes than this review's scope.
- **Single owner-controlled admin key** — controls which assets are
  listed and which addresses hold verifier privileges. A real,
  unresolved centralization point.
- **No professional, external, paid security audit performed.** Every
  finding in this document was caught by internal review, not a
  systematic third-party process. We do not claim other issues of
  similar severity have been ruled out.
- **No formal game-theoretic / incentive-compatibility proof** for the
  proportional round auction's behavior under strategic bidding.

## What this document is not

It is not a certification that the contracts are free of bugs, not a
substitute for a paid external audit, and not a guarantee against novel
attack vectors not covered by the specific checks performed. It is a
transparent, dated, commit-referenced record of what was actually
checked, what was actually found, and what was actually fixed —
intended to be more useful than an unverifiable claim of "we audited
it," precisely because every line above can be checked against the real
git history and the verified, deployed contract source.
