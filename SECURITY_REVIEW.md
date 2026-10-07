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

Last updated: October 2026. Findings 5–8 shipped in the October 3 redeploy. Findings 9–10 were found afterwards, during frontend work on the governance layer, and are scheduled for the next RoundAuction/CompanyTreasury redeploy. No citizens had joined the live contracts when they were found, so no user positions were ever exposed to them.

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

### Finding 9 — An election round that closes with zero votes locks that company's governance permanently (High, fix scheduled)

**Where:** `RoundAuction.tallyRound()`, together with `vote()`, `openGovernanceVote()` and `startNewTerm()`

**Issue:** `openGovernanceVote()` is permissionless: anyone can open a 3-day voting round as soon as a single candidate has declared. If that round closes without a single vote cast, the election can never complete:

- With two or fewer candidates, `tallyRound()` reaches the "install the plurality leader" branch, finds no leader, and reverts (`no votes cast`). Voting is already closed (`vote()` requires the deadline not to have passed), so no vote can ever be added, and every retry reverts identically.
- With three or more candidates, the runoff branch treats the empty top two as `address(0)` and eliminates every real candidate, then opens a new round in which nobody can be voted for. The next tally reverts the same way.

`startNewTerm()` cannot rescue the company, because it requires a sitting governor, and there never was one. No other function resets `governanceRound`. The result is a permanent loss of governance for that company: no governor, so no treasury auctions, vendor payments, withdrawals or reinvestment, ever.

**Severity reasoning:** High rather than Critical, because no funds are lost or locked by this alone, and a single vote from any shareholder (including a candidate voting for themselves) prevents it. But it is cheap to trigger by inattention or griefing (open voting early, then nobody votes), and its effect is irreversible.

**Planned fix:** When a round closes with zero votes cast, `tallyRound()` reopens the same round for a fresh voting window instead of reverting or eliminating anyone.

**Interim mitigation (frontend, commit [`eb734a6`](https://github.com/amiran11/sakartvelo-exchange/commit/eb734a6)):** the site warns before voting is opened and throughout any round with no votes yet, and explains the situation if a round has closed empty. This reduces accidental triggering; it cannot prevent deliberate griefing.

---

### Finding 10 — Unbounded candidate list makes elections vulnerable to gas exhaustion (High, fix scheduled)

**Where:** `RoundAuction.declareCandidacy()`, `tallyRound()`, `startNewTerm()`

**Issue:** `declareCandidacy()` has no cap on the number of candidates per company. The only requirement is holding at least one share. `tallyRound()` loops over the full `candidateList` twice (once to rank, once to eliminate), and `startNewTerm()` loops over it again to clear state. Companies are listed with very large share supplies (millions), so an actor who spreads single shares across many wallets can register enough candidates that tallying exceeds the block gas limit. Every retry then reverts identically: the election is permanently stuck, with the same consequences as Finding 9. If it happens during a later term, `startNewTerm()` can become uncallable too.

This is the same class as Findings 1 and 3, [SWC-128](https://swcregistry.io/docs/SWC-128) (Denial of Service with Block Gas Limit), in a code path that was not covered when those caps were added.

**Planned fix:** a hard `MAX_CANDIDATES` cap, combined with a minimum share holding required to stand, so the capped slots cannot themselves be cheaply filled with junk candidates to keep real ones out.

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
- **Vote-weight double-counting via share transfer.** Every share-weighted
  vote in the system reads weight live at the moment of voting and tracks
  "has voted" per address: `votePolicy()` (dividend vs. reinvest),
  `voteVendorPayment()`, and governor elections via `RoundAuction.vote()`.
  Since shares become transferable after their 7-day lock period, a
  shareholder could vote, transfer their shares to a second wallet they
  also control, and vote again — double-counting the same underlying
  shares. This was first identified for `votePolicy()`; an October 2026
  re-check confirmed the same pattern in the other two votes. It is the
  same class of Sybil-resistance limitation already disclosed for citizen
  verification generally. Not yet fixed; a full fix requires either
  share-based vote snapshotting or a stronger identity layer, both larger
  changes than this review's scope.
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
2. **Automated test suite, including fuzz and invariant testing.** Most
   behaviour has so far been tested by hand on testnet and mainnet. A
   production system needs repeatable tests, especially for the
   capital-custody invariant (Finding 5) and every capped loop
   (Findings 1, 3, 10).
3. **Multisig admin control.** Listing, verifier and wiring privileges
   currently sit with a single owner key (see limitations above).
4. **Real proof-of-personhood.** See limitations above; this also
   underlies the vote double-counting issue.
5. **Legal review.** Tokenised shares in state assets very likely fall
   under securities and privatisation law, in Georgia and in users'
   own jurisdictions.
6. **Operations:** monitoring of live contracts, an incident-response
   plan, and an upgrade path that does not require wiping every user's
   position on redeploy, as every redeploy so far has.

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
