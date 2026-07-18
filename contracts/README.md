# Sovereign Lots — Contracts

> **⚠️ FICTIONAL SIMULATION.** This is not a real country, government,
> company, or financial product. Any resemblance to real states, state
> assets, or companies (Georgian or otherwise) is fictional and exists
> solely as a gamified rule-set — a setting, not a claim about anything
> real. Nothing here is a security, a real financial instrument, or a
> claim on any real-world asset. All three contracts also carry this as an
> on-chain `DISCLAIMER` constant, readable directly from deployed
> bytecode, not just this file.

Three contracts, split the way it is specifically because of a real
constraint: everything used to live in two contracts, and once governor
elections, treasury guardrails, and an INVEST secondary market were all
added, `ShareAuction` alone compiled to **57,127 bytes** — more than
double Ethereum's 24,576-byte deployment limit (EIP-170). That's not a
style warning, it's a hard rule: a contract that size cannot be deployed
to mainnet or most L2s at all. The split below, plus enabling the
compiler's optimizer, is what actually fixes that — not a cosmetic
reorganization.

**Compiler note, and this one matters:** deploy with the **optimizer
enabled, `runs: 200`**. Without it, both `ShareAuction` and
`CompanyTreasury` are still over the limit even after the split. With it,
all three contracts fit with real headroom (`InvestToken` 4,836 bytes,
`ShareAuction` 19,261, `CompanyTreasury` 19,419 — all under 24,576). In
Remix: Compiler tab → Advanced Configurations → enable optimization, set
runs to `200`.

## The three contracts

- **`InvestToken.sol`** — ERC-20. Only wallets the owner has marked
  `verifiedCitizen` can `claim()` one equal allocation (1000 INVEST). The
  token is closed-loop: a citizen can only send it to the auction house or
  an authorized sink (see below); the auction house or an authorized sink
  can pay funds back out freely (refunds, dividends, proceeds), since
  that's the system returning legitimately collected money, not a citizen
  reselling their free allocation. Emission is capped two ways: a hard
  `maxCitizens` ceiling, and — separately — `claim()` stops entirely once
  `ShareAuction.privatizationConcluded()` is true.

- **`ShareAuction.sol`** — ERC-721. Everything that has to touch a Share
  NFT directly: the primary pay-as-bid auction (`listCompany`,
  `placeBid`, `finalize`), the 7-day post-mint lock, the 99/1 capital/host
  split, the full runoff governor election (candidacy, voting rounds,
  rotating operating keys, 30-day terms), `invest()` (buying into another
  company), and the share secondary market (`listShare`/`buyShare`/
  `governorListShare`).

- **`CompanyTreasury.sol`** — everything a governor can do that *doesn't*
  need to touch an NFT: multi-asset custody, the 5%-free/commit-reveal/
  vendor-vote treasury guardrails, the end-of-term policy vote, and the
  INVEST secondary market. Reads company/governor/share data straight
  from `ShareAuction` (a real import, not just an interface) and calls
  back into `ShareAuction.adjustCapital()` — restricted to only this
  contract's address — whenever a company's INVEST capital needs to move.

## Governor elections — a real runoff, not a single vote

- Once a company is at least half-assigned (`sharesIssued * 2 >=
  totalShares`), any current shareholder can `declareCandidacy(companyId,
  program)` with a short platform (byte-length capped at ~4500 bytes as a
  practical stand-in for "~700 words" — Solidity can't count words
  cheaply, so this is an approximation, not an exact rule).
- `openGovernanceVote(companyId)` starts round 1, a 3-day window.
  Shareholders `vote(companyId, candidate)`, weighted by shares of that
  company currently held.
- Anyone can call `tallyRound(companyId)` after the window closes. A
  candidate with **51% of votes cast that round** wins outright. If
  nobody clears the bar, every candidate except the top two is eliminated
  and a new round opens — repeating until someone wins, or until only two
  remain, at which point the round's plurality leader wins outright (so
  it can't loop forever on an exact tie).
- The winner holds office for **30 days** (`TERM_LENGTH`). Once it
  expires, anyone can call `startNewTerm(companyId)`, wiping the
  candidate list and vote history and reopening the whole cycle.
- **The elected wallet isn't what actually operates the company.**
  Immediately after winning, the governor must call
  `setOperatingKey(companyId, freshAddress)` — generate that address the
  same way a citizen wallet gets generated (a fresh keypair, client-side)
  and register it once from their real identity wallet. Every governor
  action checks *that* key, not the officeholder's personal wallet.
  `startNewTerm()` resets it to `address(0)`, so each new term genuinely
  requires a brand new keypair, distinct from whoever's personal wallet
  won the election. The company's actual held assets never move to a new
  address — only who's authorized to direct them changes; physically
  migrating a whole portfolio every 30 days would be far riskier and more
  expensive than rotating an access-control mapping.

## Treasury guardrails: what closed the actual hole

An earlier version of `withdrawToken` let one signature move an unbounded
amount to any address the governor alone picked — a compromised or
malicious operating key had unlimited, un-vetoable reach for up to 30
days. That's fixed now with a 5%-free / two-gated-paths-beyond design,
all in `CompanyTreasury.sol`:

- **Under 5%** of an asset's balance at the start of the term (snapshotted
  the first time that asset is touched that term, not recomputed live —
  live would be gameable by deposit-drain-deposit cycling): `withdrawToken`
  works directly, no gate. This is deliberately the only function that can
  send funds to an address the governor alone chose.
- **At or above 5%, selling at market:** `openTreasuryAuction` → bidders
  `commitBid` (a sealed hash plus a small forfeitable deposit) →
  `revealBid` (proves the hash and escrows the full bid) →
  `settleTreasuryAuction`, fully permissionless, no governor signature
  anywhere in settlement. The governor never learns who's bidding what
  until after bidding closes — that's the actual fix for "governor picks
  who wins," not just a size cap on the damage.
- **At or above 5%, a fixed payment to a named party** (a real invoice —
  the thing an open auction can't express): `proposeVendorPayment` →
  shareholders `voteVendorPayment` → `executeVendorPayment`, requiring
  51% approval, the same bar as electing a governor.
- **This does NOT apply to `invest()` or `governorListShare()` /
  `governorOfferInvest()`** — those already route through an open market
  instead of an arbitrary-recipient transfer, which is the specific
  danger the 5% cap exists to bound. Applying it there too would be
  redundant, not safer.

**A mandatory shareholder vote also runs at the end of every term,**
separate from anything the sitting governor chose to do:
`openPolicyVote(companyId, term)` → `votePolicy(companyId, term,
wantsDividend)` (simple majority of votes cast, not a runoff — ties
default to reinvest) → `resolvePolicyVote(companyId, term, holders)`. If
dividend wins, 1% of capital pays out pro-rata; if reinvest wins, nothing
moves.

## Citizens vs. everyone who shows up later

"Citizen" means specifically: verified and claimed during the original
privatization window. Not an ongoing status — a one-time historical fact.
Once `privatizationConcluded()` flips true, nobody new gets a free
allocation, ever, citizen or not.

Anyone who shows up later has no free path to INVEST. Their only way in
is the INVEST secondary market, in `CompanyTreasury.sol`:

- `offerInvest(investAmount, paymentToken, paymentAmount)` — a citizen
  with spare INVEST lists some for sale, priced in an approved ERC-20.
- `governorOfferInvest(companyId, ...)` — the governor equivalent: a
  company sells down its own held INVEST capital for an approved ERC-20,
  which becomes part of that company's token treasury.
- `buyInvest(offerId)` — anyone pays in the approved token, receives
  INVEST.
- `cancelInvestOffer(offerId)` — pulls an unfilled offer back.

**Strict rule: no fiat, anywhere.** No bank integration, no card rails, no
fiat on-ramp of any kind — only trading one crypto asset for another.
`setApprovedPaymentToken` (owner-controlled, on `CompanyTreasury`) decides
what's accepted. Real limitation worth being direct about: Solidity can't
inspect what a token economically represents — the whitelist can block
everything except approved addresses, but can't verify an approved token
isn't secretly fiat-pegged. "No fiat" in spirit is a policy choice you
make when approving tokens, not a guarantee the code enforces alone.

## Why sybil resistance is only partially solved here

A smart contract can't tell whether two wallets belong to the same human.
What this repo does:

- Gates `claim()` behind `verifiedCitizen[address]` — stops unverified
  throwaway wallets, not one real person verified under multiple wallets
  (genuinely unsolved; production would need this backed by real
  identity/proof-of-personhood infrastructure, not an admin boolean).
- Governance votes are weighted by shares actually paid for, not wallet
  count — farming voting power costs real capital per extra wallet.
- `maxCitizens` is a hard, on-chain, auditable ceiling independent of how
  verification is run.
- `claim()` also stops once `privatizationConcluded()` is true — see the
  "list everything up front" caveat in the deploy steps below if you plan
  to list companies in waves rather than all at once.

## Deploying to a testnet (Sepolia) with Remix — no local setup needed

1. Open [remix.ethereum.org](https://remix.ethereum.org).
2. Create a new workspace, upload all three `.sol` files.
3. In the File Explorer, right-click → add `@openzeppelin/contracts` via
   the built-in npm resolver (Remix fetches it automatically on first
   compile, from `registry.npmjs.org`).
4. Compiler tab → version `0.8.20+` → **Advanced Configurations → enable
   the optimizer, set runs to `200`** (see the note at the top — this
   isn't optional, both later contracts are oversized without it).
   Compile all three files.
5. Deploy & Run tab → Environment: Injected Provider - MetaMask, network
   Sepolia (get free test ETH from a Sepolia faucet).
6. Deploy `InvestToken` first, passing a `_maxCitizens` value. For a small
   test run, `1000` is plenty; a real deployment would use the actual
   eligible population.
7. Deploy `ShareAuction`, passing the InvestToken address.
8. Deploy `CompanyTreasury`, passing both the InvestToken and ShareAuction
   addresses.
9. Back on `ShareAuction`, call `setTreasury(<CompanyTreasury address>)` —
   the only address ever allowed to call `adjustCapital`.
10. On `InvestToken`: `setAuctionHouse(<ShareAuction address>)`, then
    `setAuthorizedSink(<CompanyTreasury address>, true)` — without this
    second call, citizens can't pay INVEST into `CompanyTreasury` (bids in
    the treasury auction, INVEST-market purchases) and it can't pay
    refunds back out; both directions need it, which is why `_update`
    checks `authorizedSink` on both `to` and `from`.
11. Still on `InvestToken`, call `setVerifiedCitizen(<wallet>, true)` for
    every wallet that should be allowed to claim.
12. **List every company you intend to privatize now, before anyone
    claims or bids** — e.g. `listCompany(0, "Bolnisi Gold Mines", 5,
    600)`. `claim()` checks `privatizationConcluded()`, which flips true
    once every *currently listed* company is finalized — listing in waves
    can pause claiming prematurely between waves.
13. From a verified wallet: `claim()` on InvestToken for 1000 INVEST.
14. `approve()` the ShareAuction address on InvestToken, then
    `placeBid(0, amount)` on ShareAuction.
15. After the deadline, anyone calls `finalize(0)`.
16. Once company 0 is ≥50% assigned, a shareholder calls
    `declareCandidacy(0, "my platform...")` — get at least two candidates
    in to see the runoff logic do anything.
17. `openGovernanceVote(0)` starts round 1. Shareholders `vote(0,
    <candidate>)`. After the window, anyone calls `tallyRound(0)` —
    either someone's elected, or the field narrows and a new round opens;
    call `tallyRound(0)` again after each round's window.
18. The elected governor calls `setOperatingKey(0, freshAddress)` from
    their election-winning wallet first. From that key, on
    `CompanyTreasury`: `invest(0, <toCompanyId>, amount)` (buy — actually
    this one's still on `ShareAuction`), `distribute(0, [holders], amount)`
    (dividend during their term), `withdrawToken(0, <erc20>, <to>,
    amount)` (only within the 5% free tier), `openTreasuryAuction(0,
    <erc20>, amount)` (sell above 5%), `proposeVendorPayment(0, <erc20>,
    <to>, amount)` (fixed payment above 5%), or `governorOfferInvest(0,
    amount, <erc20>, price)` (sell down INVEST capital for outside
    crypto).
19. After 30 days, anyone calls `startNewTerm(0)` on `ShareAuction` to
    reopen the election cycle.
20. Once term 1 is over, anyone calls `openPolicyVote(0, 1)` on
    `CompanyTreasury`. Shareholders `votePolicy(0, 1, true/false)`. After
    the window, anyone calls `resolvePolicyVote(0, 1, [holders])`.
21. For the INVEST market: owner calls `setApprovedPaymentToken(<erc20>,
    true)` on `CompanyTreasury` (e.g. a testnet USDC address). A citizen
    calls `offerInvest(amount, <erc20>, price)`; anyone calls
    `buyInvest(offerId)` to purchase it.

## Local dev with Hardhat (optional)

```bash
npm install --save-dev hardhat @openzeppelin/contracts
npx hardhat init
# copy all three .sol files into contracts/
# in hardhat.config.js, set solidity.settings.optimizer = { enabled: true, runs: 200 }
npx hardhat compile
```

Write a deploy script that deploys `InvestToken`, then `ShareAuction`,
then `CompanyTreasury`, then wires them together with `setTreasury`,
`setAuctionHouse`, and `setAuthorizedSink` as in steps 6–10 above.

## Where this diverges from the playable prototype

The in-browser game in this same delivery simulates the *original*,
simpler mechanics (equal allocation, pay-as-bid auction, lock period,
post-lock trading) client-side with bots — no wallet needed, playable
instantly. It does **not** run the governor election, rotating operating
keys, treasury guardrails, end-of-term policy vote, or INVEST market
described here; only the real contracts do. It also isn't wired to these
contracts at all — connecting a real front end via `ethers.js`/`wagmi` to
a deployed testnet address would be the next step toward an actual
on-chain version, rather than just a deployable one.
