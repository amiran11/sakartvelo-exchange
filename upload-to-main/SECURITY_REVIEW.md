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

Last updated: October 2026, for the v8 rebuild (RoundAuction v8, the new Governance contract, CompanyTreasury v6). Findings 5–8 shipped in the October 3 redeploy. Findings 9–22 were found afterwards, while building the governance frontend and then while writing an automated test suite that runs every scenario against Arbitrum's real limits. All of them are fixed in the v8 contracts on the `rebuild-v8` branch, which are pending redeploy. **No citizens had joined the live contracts when any of them were found, so no user funds or positions were ever exposed.**

---

## Scope

`contracts/RoundAuction.sol` (v8), `contracts/Governance.sol` (new in v8,
split out of RoundAuction) and `contracts/CompanyTreasury.sol` (v6) — the
three contracts that carry all real economic and governance logic for
live listings. `InvestToken.sol` and `OpenVerifier.sol` were reviewed at their
original deployment and have had no code changes since; the v8 deploy
redeploys them fresh alongside the rest (see `REDEPLOY_V8.md`).
`ShareAuction.sol` never carried a real listing and is retired in v8: it
is not redeployed and the site no longer uses it.

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

**Automated testing (added for v8).** Every fix from Finding 9 onward is
covered by a scripted test in `test/`, run on a local chain configured
with Arbitrum One's real limits: 32,000,000 gas per transaction and the
24,576-byte contract size cap. 92 tests in total (35 for RoundAuction,
57 for the three contracts working together), including worst-case gas
scenarios and a check, after every scenario, that each contract holds
exactly the INVEST it owes. Several findings below (11, 20, 21) were
found by these tests, not by reading the code, which is itself an
argument for the test suite over manual review alone.

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

**Later correction:** the "record date tradeoff" described above was
understated. Reading live share counts at claim time let one holder
claim, move the shares to a second wallet, and claim again, paid out of
other users' escrowed funds. See Finding 16; fixed in v6 with a real
record date.

---

### Finding 5 — Capital ledger and real token custody were split across two contracts (Critical, fixed)

**Where:** `RoundAuction.adjustCapital()`, and every `CompanyTreasury` function that called it

**Issue:** `adjustCapital()` only ever updated an internal `uint256 capital` number in RoundAuction — it never moved any real INVEST tokens. Meanwhile, `CompanyTreasury`'s payout functions (`distribute()`, `claimDividend()`, the INVEST secondary market) assumed they already held the underlying tokens and simply called `investToken.transfer()` from their own balance. They didn't hold them: the real tokens backing a company's `capital` field sat entirely in RoundAuction, since that's where citizen bids land at `placeBid()` time. Any real attempt to pay a dividend, or complete an INVEST-market sale funded from company capital, would have reverted on an insufficient-balance error — not a theoretical risk, a guaranteed failure the first time either path was actually used.

**Fix:** `adjustCapital()` now enforces a real invariant: RoundAuction always physically holds INVEST tokens equal to the sum of every company's `capital` field. A negative delta (capital being spent) now pays the real tokens out to the treasury at the same moment the ledger updates. A positive delta (capital being credited, e.g. treasury-auction proceeds) requires the treasury to transfer the matching real tokens to RoundAuction earlier in the same transaction — every call site in `CompanyTreasury` that credits capital was updated to do this forwarding explicitly (`settleTreasuryAuction()`, `cancelInvestOffer()`).

**Commit:** [`4756f41`](https://github.com/amiran11/sakartvelo-exchange/commit/4756f41)

---

### Finding 6 — Governor's `invest()` had no restriction to income vs. original capital (Medium, fixed)

**Where:** `RoundAuction.invest()`

**Issue:** A sitting governor could commit up to 100% of a company's capital — including the original citizen-funded privatization proceeds, not just income earned since — into a single cross-company investment, with no additional safeguard beyond simply holding office. This was a materially larger unilateral-authority gap than either the 5%-capped `withdrawToken()` or the vote-gated vendor payments already in place for other spending paths.

**Fix:** Added a separate `reinvestableIncome` pool per company, entirely distinct from `capital`. `invest()` now draws exclusively from this pool. It is credited only when a company actually receives real income — currently, only via the new `claimDividendAsCorporation()` (Finding 7) — never from the original privatization capital.

**Commit:** [`4756f41`](https://github.com/amiran11/sakartvelo-exchange/commit/4756f41)

---

### Finding 7 — Corporate holdings could accumulate shares and vote, but could never claim their own dividends (Medium, fixed)

**Where:** `CompanyTreasury.claimDividend()`

**Issue:** A company's corporate cross-holding (built up via `invest()`) is a synthetic address with no private key — `voteAsCorporation()` already existed to let a governor vote on its behalf, but no equivalent existed for claiming a dividend. `claimDividend()` checks `msg.sender` directly, which a synthetic address can never satisfy. Corporate holdings could hold real voting power in a company they'd invested in, but could never actually realize any income from that position.

**Fix:** Added `claimDividendAsCorporation(fromCompanyId, dividendCompanyId, term)`, restricted to the origin company's governor, mirroring `voteAsCorporation()`'s pattern. Proceeds are credited directly into the origin company's `reinvestableIncome` pool (Finding 6) — never sent to any individual wallet.

**Commit:** [`4756f41`](https://github.com/amiran11/sakartvelo-exchange/commit/4756f41)

---

### Finding 8 — Governor compensation for successful reinvestment (new feature, not a vulnerability fix)

**Decision:** Governors who successfully grow a company's holdings through reinvestment now receive 1% of the shares acquired, in-kind (i.e. in the actual acquired shares, not INVEST currency), locked for 2 terms of the origin company's own governance cycle. This is a deliberate incentive-alignment choice, not a bug fix — included here because it touches the same minting logic as Findings 5–7 and shipped in the same redeploy.

**Implementation:** Carved out inside `settleRound()`'s existing minting logic (now centralized in a new internal `_mintShares()` helper, used by both the main proportional pass and the stall-breaker fallback, so the rule can't silently apply in one path and not the other). The 1% is rounded down and applies only when the winning bid came from a recognized corporate holder address — ordinary citizen bids are completely unaffected.

**Commit:** [`4756f41`](https://github.com/amiran11/sakartvelo-exchange/commit/4756f41)

---

### Finding 9 — An election round that closes with zero votes locks that company's governance permanently (High, fixed)

**Where:** `RoundAuction.tallyRound()`, together with `vote()`, `openGovernanceVote()` and `startNewTerm()`

**Issue:** `openGovernanceVote()` is permissionless: anyone can open a 3-day voting round as soon as a single candidate has declared. If that round closes without a single vote cast, the election can never complete:

- With two or fewer candidates, `tallyRound()` reaches the "install the plurality leader" branch, finds no leader, and reverts (`no votes cast`). Voting is already closed (`vote()` requires the deadline not to have passed), so no vote can ever be added, and every retry reverts identically.
- With three or more candidates, the runoff branch treats the empty top two as `address(0)` and eliminates every real candidate, then opens a new round in which nobody can be voted for. The next tally reverts the same way.

`startNewTerm()` cannot rescue the company, because it requires a sitting governor, and there never was one. No other function resets `governanceRound`. The result is a permanent loss of governance for that company: no governor, so no treasury auctions, vendor payments, withdrawals or reinvestment, ever.

**Severity reasoning:** High rather than Critical, because no funds are lost or locked by this alone, and a single vote from any shareholder (including a candidate voting for themselves) prevents it. But it is cheap to trigger by inattention or griefing (open voting early, then nobody votes), and its effect is irreversible.

**Fix:** When a round closes with zero votes cast, `tallyRound()` reopens the same round for a fresh voting window instead of reverting or eliminating anyone. Now in `Governance.sol`. Tested with two and with three candidates.

**Commit:** [`96b44a7`](https://github.com/amiran11/sakartvelo-exchange/commit/96b44a7)

**Interim mitigation (frontend, commit [`eb734a6`](https://github.com/amiran11/sakartvelo-exchange/commit/eb734a6)):** the site warns before voting is opened and throughout any round with no votes yet, and explains the situation if a round has closed empty. This reduces accidental triggering; it cannot prevent deliberate griefing.

---

### Finding 10 — Unbounded candidate list makes elections vulnerable to gas exhaustion (High, fixed)

**Where:** `RoundAuction.declareCandidacy()`, `tallyRound()`, `startNewTerm()`

**Issue:** `declareCandidacy()` has no cap on the number of candidates per company. The only requirement is holding at least one share. `tallyRound()` loops over the full `candidateList` twice (once to rank, once to eliminate), and `startNewTerm()` loops over it again to clear state. Companies are listed with very large share supplies (millions), so an actor who spreads single shares across many wallets can register enough candidates that tallying exceeds the block gas limit. Every retry then reverts identically: the election is permanently stuck, with the same consequences as Finding 9. If it happens during a later term, `startNewTerm()` can become uncallable too.

This is the same class as Findings 1 and 3, [SWC-128](https://swcregistry.io/docs/SWC-128) (Denial of Service with Block Gas Limit), in a code path that was not covered when those caps were added.

**Fix:** `MAX_CANDIDATES` = 20 per election, and a candidate must hold at least 0.1% of the shares issued so far, so the capped slots cannot be cheaply filled with junk candidates. Candidacy also closes once voting opens, so a late entrant can't skip into a runoff. Tallying at the cap measured at 0.59M gas.

**Commit:** [`96b44a7`](https://github.com/amiran11/sakartvelo-exchange/commit/96b44a7)

---

### Finding 11 — Settlement could exceed Arbitrum's per-transaction gas limit, locking a company permanently (Critical, fixed)

**Where:** `RoundAuction.settleRound()`

**Issue:** Finding 1's caps (`MAX_SHARES_PER_ROUND` = 1,000, `MAX_BIDS` =
500) bounded settlement cost, but at values too high for Arbitrum One's
32,000,000 gas per-transaction limit. Measured on a local chain with
that exact limit:

- Minting cost about 71,000 gas per share, so at most ~450 shares fit
  in one settlement. One bid of 500 INVEST next to one of 1 INVEST
  already required 501 shares.
- The bid sort read storage on every comparison. With bids in the worst
  order, ~150 bids was the most that fit.

Either way the outcome matched Finding 1: settlement reverts on every
retry, the closed round accepts no new bids, and every bid in that
company is locked forever. Because amounts are in wei and one citizen
could place many bids, **a single citizen with a few hundred INVEST
could do this deliberately to any company.**

**Fix (v8):** at most 100 *active* bids per company and 300 shares per
round; bids copied to memory once and sorted there; share data packed
into one storage slot (cheaper mints). Worst case measured: **22.1M of
32M gas** (300 shares to 100 distinct new holders), with 31% headroom.

**Commit:** [`0a17f6c`](https://github.com/amiran11/sakartvelo-exchange/commit/0a17f6c)

---

### Finding 12 — The bid cap counted every bid ever placed, so a company could stop accepting bids forever (High, fixed)

**Where:** `RoundAuction.placeBid()`, `invest()`

**Issue:** `MAX_BIDS` compared against the length of an array that never
shrank. After 500 bids in a company's lifetime it could never take
another, which for a company with millions of shares meant it could
never sell out. One citizen could also burn all 500 slots with 1-INVEST
bids.

**Fix (v8):** one active bid per wallet; filled and refunded bids are
removed; the cap counts active bids only. A test places 701 bids over
one company's lifetime.

**Commit:** [`0a17f6c`](https://github.com/amiran11/sakartvelo-exchange/commit/0a17f6c)

---

### Finding 13 — Stale or duplicate share-market listings let a buyer take a share from its new owner (Critical, fixed)

**Where:** `RoundAuction.buyShare()`

**Issue:** `buyShare()` moved the share with ERC-721's ownership check
switched off (needed so keyless corporate holders can sell), but never
checked the seller still owned it. A seller could list a share, then
transfer it; a buyer could then take it from the new owner. Listing the
same share twice let a second buyer take it from the first.

**Fix (v8):** `buyShare()` requires the listing's seller to still own the
share. Both attacks are reproduced in the tests and now fail.

**Commit:** [`0a17f6c`](https://github.com/amiran11/sakartvelo-exchange/commit/0a17f6c)

---

### Finding 14 — Corporate bids refunded at sellout were sent to a keyless address (High, fixed)

**Where:** `RoundAuction.settleRound()` sellout refunds

**Issue:** When a company sold out, every still-active bid was refunded
to its bidder. For a corporate bid (from `invest()`), the bidder is a
synthetic address with no private key, so those INVEST were lost for good.

**Fix (v8):** corporate refunds are credited back to the origin company's
reinvestable income; the tokens never leave RoundAuction.

**Commit:** [`0a17f6c`](https://github.com/amiran11/sakartvelo-exchange/commit/0a17f6c)

---

### Finding 15 — A contract wallet could make settlement revert by rejecting minted shares (Medium, fixed)

**Where:** `RoundAuction._mintShares()`

**Issue:** Shares were minted with `_safeMint`, which calls the recipient
if it is a contract. A bidder using a contract that refuses that call
would make every settlement of that company revert.

**Fix (v8):** `_mint` (no receiver callback).

**Commit:** [`0a17f6c`](https://github.com/amiran11/sakartvelo-exchange/commit/0a17f6c)

---

### Finding 16 — Dividends could be claimed twice by moving shares between wallets (Critical, fixed)

**Where:** `CompanyTreasury.claimDividend()`

**Issue:** Entitlement was read from live share counts and "already
claimed" was tracked per address. Claim, move the shares to a second
wallet, claim again. The extra payout came from other users' INVEST
held by the treasury (auction deposits, open INVEST offers).

**Fix (v6):** RoundAuction now keeps a timestamped history of every
holder's share count. Dividends use a record date, the moment the term
ended: entitlement is the shares held then, whatever happens afterwards.
Tested: shares moved after the record date still pay the original
holder, and total claims never exceed the pool.

**Commit:** [`96b44a7`](https://github.com/amiran11/sakartvelo-exchange/commit/96b44a7)

---

### Finding 17 — The governor's mid-term `distribute()` could pay the same holder several times (Critical, removed)

**Where:** `CompanyTreasury.distribute()`

**Issue:** The governor supplied the holder list and nothing prevented
the same address appearing repeatedly. Each repeat was paid again, out
of other users' escrowed funds. The earlier entry under "Reviewed and
verified safe" assessed only the missing-holder case and missed this.

**Fix (v6):** removed entirely, by design decision. The end-of-term
shareholder vote (Finding 16's record-date mechanism) is now the only
dividend path.

**Commit:** [`96b44a7`](https://github.com/amiran11/sakartvelo-exchange/commit/96b44a7)

---

### Finding 18 — Vendor payments had no quorum, so a governor could approve a payment alone (High, fixed)

**Where:** `CompanyTreasury.executeVendorPayment()`

**Issue:** A payment passed if 51% of the votes *cast* were yes. If only
the governor voted, it passed, so a governor could propose paying any
address (including their own) and approve it single-handedly.

**Fix (v6):** at least 20% of issued shares must vote (quorum), weighted
by shares held when the payment was proposed. Tested: the governor
alone (10% turnout) fails and the funds return to the company.

**Commit:** [`96b44a7`](https://github.com/amiran11/sakartvelo-exchange/commit/96b44a7)

---

### Finding 19 — Treasury-auction settlement refunded every bidder in one loop (Medium, fixed)

**Where:** `CompanyTreasury.settleTreasuryAuction()`

**Issue:** Up to 500 bidders were refunded in one transaction, close to
the gas limit, and one failing transfer blocked every refund.

**Fix (v6):** the leading bid is tracked as reveals arrive; settlement
is constant-cost; each bidder claims their own refund or winnings.
Commit hashes are now bound to the auction id, so a commit can't be
reused across auctions.

**Commit:** [`96b44a7`](https://github.com/amiran11/sakartvelo-exchange/commit/96b44a7)

---

### Finding 20 — Every election after a company's first was corrupted by the previous term's votes (High, fixed)

**Where:** `RoundAuction.startNewTerm()` (v7), now `Governance.sol`

**Issue:** Votes were recorded per company and round number, and round
numbers restarted at 1 each term without clearing the old records. In
term 2, everyone who voted in term 1 was rejected as "already voted",
and term 1's vote totals still counted. Found by an end-to-end test that
re-elected a governor.

**Fix:** round ids keep counting up across all terms (`lastRoundId`).

**Commit:** [`bbda6e6`](https://github.com/amiran11/sakartvelo-exchange/commit/bbda6e6)

---

### Finding 21 — Corporate investment could never start (design gap, Medium, fixed)

**Where:** `RoundAuction.invest()`, `CompanyTreasury`

**Issue:** `invest()` spends only reinvestable income (Finding 6). The
only source of that income was dividends on shares bought through
`invest()`. That's circular: corporate investment, governor compensation
(Finding 8) and corporate voting could never actually happen.

**Fix (v6):** proceeds from selling a company asset at a treasury
auction become reinvestable income; original capital is still never
reinvested. An end-to-end test now runs the whole chain: asset sale,
investment, corporate shares with the governor's 1%, corporate vote,
corporate dividend.

**Commit:** [`bbda6e6`](https://github.com/amiran11/sakartvelo-exchange/commit/bbda6e6)

---

### Finding 22 — The end-of-term dividend vote couldn't open between terms (Low, fixed)

**Where:** `startNewTerm()`, `CompanyTreasury.openPolicyVote()`

**Issue:** Resetting a term cleared its end time without recording it,
so that term's dividend vote couldn't open until a new governor was
elected, possibly never.

**Fix:** the term's end time is recorded when it is reset.

**Commit:** [`96b44a7`](https://github.com/amiran11/sakartvelo-exchange/commit/96b44a7)

---

### Correction: the v7 "stall breaker" leftover issue was not a real finding

During the v8 work it was briefly reported that RoundAuction v7's
stall-breaker fallback stranded the unused part of oversized bids. The
code did do that, but it could never run: the lowest bid sets the
baseline, so its own entitlement is always exactly 1 share and always
fits if nothing else did. No funds were ever at risk. v8 removes the
unreachable code. Recorded here because a review that reports its own
false alarms is easier to trust.

### Note for the SSRN paper (Proposition 1)

The paper's bound on settlement cost remains correct in form. Finding 11
shows the original constants did not fit Arbitrum's per-transaction
gas limit; the paper should note the v8 values (100 active bids, 300
shares per round) and the measured 22.1M-gas worst case.

---

## Reviewed and verified safe (not just untested)

Listed explicitly, not just implied by omission — a real review reports
clean passes, not only problems:

- **`withdrawHostFees()`, `buyShare()`, `settleTreasuryAuction()`:**
  correct checks-effects-interactions ordering — state changes (flags,
  balances) are set *before* any external call, not after.
  **Correction:** ordering was correct, but `buyShare()` had a separate,
  serious flaw this check didn't cover (Finding 13).
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
  **Correction:** this assessment was wrong. Duplicate addresses in the
  list let a governor overpay from other users' funds (Finding 17).
  `distribute()` has been removed.

---

## Known, disclosed, unresolved limitations

Consistent with the limitations already stated plainly in our academic
paper — not new information, restated here for completeness in one
place:

- **No proof-of-personhood.** Citizen verification (`OpenVerifier`) is
  gated by a minimum wallet ETH balance, which raises the cost of
  trivial wallet farming but does not prevent a well-capitalized actor
  from controlling multiple verified identities.
- **~~Vote-weight double-counting via share transfer~~ — resolved in v8.**
  Every share-weighted vote (governor elections, vendor payments, the
  dividend vote) now uses balances from a fixed earlier moment: one
  second before an election round opened, one second before a vendor
  payment was proposed, or the end of the term for dividends. Moving
  shares to a second wallet mid-vote no longer adds weight (tested).
  Consequence worth stating: someone who receives shares in the same
  second an election round opens can vote only in later rounds.
- **Single owner-controlled admin key** — controls which assets are
  listed and which addresses hold verifier privileges. A real,
  unresolved centralization point.
- **No professional, external, paid security audit performed.** Every
  finding in this document was caught by internal review, not a
  systematic third-party process. We do not claim other issues of
  similar severity have been ruled out.
- **No formal game-theoretic / incentive-compatibility proof** for the
  proportional round auction's behavior under strategic bidding.

## Current status: pilot, not production

After Findings 9–10 are fixed and redeployed, the contracts are intended
for a **public pilot**: real people using real tokens in small amounts,
clearly presented as experimental. They are **not** production-ready for
anything representing real state assets. The gap to production, stated
plainly:

1. **Independent external audit.** Every finding in this document came
   from the author's own review with AI assistance. An external audit is
   the single most important missing step, and is the purpose of our
   Arbitrum security-audit grant application.
2. **Automated test suite, including fuzz and invariant testing.**
   *Partly done in v8:* 92 scripted tests at Arbitrum's real limits,
   with a custody check after every scenario. Still missing: randomized
   fuzz/invariant testing, which tries thousands of random inputs.
3. **Multisig admin control.** Listing, verifier and wiring privileges
   currently sit with a single owner key (see limitations above).
4. **Real proof-of-personhood.** See limitations above; this also
   underlies the vote double-counting issue.
5. **Legal review.** Tokenised shares in state assets very likely fall
   under securities and privatisation law, in Georgia and in users'
   own jurisdictions.
6. **Operations:** monitoring of live contracts, an incident-response
   plan, and an upgrade path that does not require wiping every user's
   position on redeploy, as every redeploy so far has. This happened for
   real on the October 3 partial redeploy: the author's own wallet stayed
   a verified citizen who had already claimed (InvestToken was kept), while
   its shares and spent INVEST were left in the retired RoundAuction, with
   no way to claim again. v8 avoids it only by redeploying everything
   while there are no other citizens; it would not be acceptable once
   there are.

Items 1–3 are engineering work. Items 4–5 are policy decisions about
what the project is meant to be, as much as they are code.

## What this document is not

It is not a certification that the contracts are free of bugs, not a
substitute for a paid external audit, and not a guarantee against novel
attack vectors not covered by the specific checks performed. It is a
transparent, dated, commit-referenced record of what was actually
checked, what was actually found, and what was actually fixed —
intended to be more useful than an unverifiable claim of "we audited
it," precisely because every line above can be checked against the real
git history and the verified, deployed contract source.
