# Sovereign Lots — Contracts

> **⚠️ FICTIONAL SIMULATION.** This is not a real country, government,
> company, or financial product. Any resemblance to real states, state
> assets, or companies (Georgian or otherwise) is fictional and exists
> solely as a gamified rule-set — a setting, not a claim about anything
> real. Nothing here is a security, a real financial instrument, or a
> claim on any real-world asset. Both contracts also carry this as an
> on-chain `DISCLAIMER` constant, so it's readable directly from the
> deployed bytecode, not just this file.

Two contracts that mirror the game's mechanics for real, on a testnet:

- **InvestToken.sol** — ERC-20. Only wallets the owner has marked
  `verifiedCitizen` can `claim()` one equal allocation (1000 INVEST). The
  token can never be transferred wallet-to-wallet — a citizen can only spend
  it into the auction house. The auction house itself can pay funds back out
  freely (refunds, dividends, the host fee), since that's the system
  returning legitimately collected money, not a citizen reselling their
  free allocation.
- **ShareAuction.sol** — ERC-721. The owner lists companies with a share
  count and a deadline. Anyone bids INVEST. When time's up, `finalize()`
  mints one NFT share to each of the top N bidders at their own bid price
  and refunds everyone else. Shares are locked for 7 days after mint before
  they can be transferred. Every winning bid is split 99/1: 99%
  capitalizes the company, 1% accrues to the host.

  **Electing a governor is a real runoff election, not a single vote:**
  - Once a company is at least half-assigned (`sharesIssued * 2 >=
    totalShares`), any current shareholder can `declareCandidacy(companyId,
    program)` with a short platform (byte-length capped at ~700 words —
    see the caveat below).
  - `openGovernanceVote(companyId)` starts round 1, a 3-day window.
    Shareholders `vote(companyId, candidate)`, weighted by shares of that
    company currently held.
  - Anyone can call `tallyRound(companyId)` after the window closes. A
    candidate with **51% of votes cast that round** wins outright. If
    nobody clears the bar, every candidate except the top two is
    eliminated and a new round opens — a runoff, repeating until someone
    wins or only two candidates remain (at which point the round's
    plurality leader wins, so it can't loop forever on a tie).
  - The winner holds office for **30 days** (`TERM_LENGTH`). Once their
    term expires, anyone can call `startNewTerm(companyId)`, which wipes
    the candidate list and vote history and reopens the whole cycle —
    concretely, this is what makes "a new wallet and a new key control
    the company every election" true: `companyGovernor` resets to
    `address(0)`, and whoever wins next is a genuinely different
    real-world wallet with a different private key. The company's actual
    held assets never move to a new address — only who's authorized to
    direct them changes. (Physically migrating a whole portfolio to a
    fresh contract address every 30 days would be far more expensive and
    risky than rotating an access-control mapping — see the code comment
    on `startNewTerm` if you want the full reasoning, or want it done the
    other way instead.)
  - **The elected wallet isn't what actually operates the company.**
    Immediately after winning, the governor must call
    `setOperatingKey(companyId, freshAddress)` — generate that address the
    same way a citizen wallet gets generated (a fresh keypair, client-side),
    and register it once from their real identity wallet. Every governor
    action below checks *that* key, not the officeholder's personal
    wallet. `startNewTerm()` resets it to `address(0)`, so each new term
    genuinely requires a brand new public/private key, distinct from
    whoever's personal wallet won the election.
  - **A mandatory shareholder vote runs at the end of every term.**
    `openPolicyVote(companyId, term)` → shareholders `votePolicy(companyId,
    term, wantsDividend)` (majority of votes cast, not a runoff — ties
    default to reinvest) → `resolvePolicyVote(companyId, term, holders)`.
    If dividend wins, exactly 1% of the company's capital pays out
    pro-rata to the supplied holder list; if reinvest wins, nothing moves,
    the capital just stays in the treasury. This is separate from — and in
    addition to — anything the sitting governor does with `distribute()`
    during their term.

  **The elected governor's toolkit:**
  - `invest(fromCompanyId, toCompanyId, amount)` — **buy**: commit capital
    as a bid into another company's live auction.
  - `governorListShare(ownerCompanyId, tokenId, price)` — **sell**: list a
    share the organization holds in another company (built up via
    `invest()`) on the secondary market; proceeds credit straight back to
    `capital`, since the organization's cross-holding address has no
    private key to receive funds the normal way.
  - `distribute(companyId, holders, amount)` — **dividend**: pay capital
    out to current shareholders, pro-rata to shares held.
  - `withdrawToken(companyId, token, to, amount)` — move any ERC-20 the
    company holds (see below) anywhere: a DEX router, a real-world vendor,
    wherever the governor decides.
  - Any citizen can also `listShare()` / `buyShare()` / `cancelListing()`
    their own (unlocked) shares directly — the secondary market isn't
    governor-only, that part's just the organization's version of it.

  **Holding assets beyond INVEST:** anyone can `depositToken(companyId,
  token, amount)` to put any ERC-20 into a company's treasury (a grant, a
  real-world settlement routed on-chain, whatever). Only the governor can
  move it back out, via `withdrawToken()`.

  **Caveat on the ~700-word cap:** `MAX_PROGRAM_BYTES` is a byte-length
  limit (4500 bytes), not a real word counter — Solidity has no cheap way
  to count words on-chain. It's a practical stand-in, not an exact rule; a
  program written in a very terse or very verbose style will land under or
  over 700 actual words at the same byte count.

## Why sybil resistance is only partially solved here

Spinning up unlimited wallets to farm free allocations is the obvious way to
break "one citizen, one equal share." A smart contract by itself cannot tell
whether two wallets belong to the same human — there's no such thing as
identity on-chain. What this repo does:

- Gates `claim()` behind `verifiedCitizen[address]`, set by the contract
  owner. This stops the *trivial* attack (unverified throwaway wallets
  claiming for free) by moving the check to whoever controls that mapping.
- Leaves the *hard* version of the problem — one real person getting
  verified multiple times under different wallets — genuinely unsolved. In
  production, `setVerifiedCitizen` would be called by an oracle backed by
  something that actually binds one wallet to one human: a national ID
  registry check, or a proof-of-personhood service (Worldcoin, BrightID,
  Gitcoin Passport are the common ones today). None of those are perfect
  either — they just move the trust problem somewhere auditable instead of
  pretending code alone can solve it.
- Governance votes are weighted by shares actually paid for at auction, not
  by wallet count — so farming voting power costs real capital per extra
  wallet, not just a free claim.
- `maxCitizens` is a separate, explicit backstop: total emission can never
  exceed `maxCitizens * CITIZEN_ALLOCATION`, on-chain and auditable, no
  matter how verification is run. It doesn't stop a bad verifier from
  wrongly approving too many addresses — nothing purely on-chain can — but
  it guarantees there's a hard number, set in the open, rather than an
  unbounded mint function trusting the verifier's judgment forever.
- Separately, `claim()` also stops once `ShareAuction.privatizationConcluded()`
  is true — once every listed company is finalized, there's nothing left to
  bid on, so no new allocations get minted either. This ties emission to the
  actual process rather than a population guess, matching the white paper's
  "distributed until the privatization process is concluded" — but see the
  waves caveat on `companiesListed`/`companiesFinalized` in ShareAuction.sol
  if you plan to list companies in stages rather than all at once.

## Citizens vs. everyone who shows up later

"Citizen," in this system, means specifically: verified and claimed during
the original privatization window. That's it — not an ongoing status, a
one-time historical fact. Once `claim()` has been used, that wallet's
allocation is done; once `privatizationConcluded()` flips true, *nobody* new
gets a free allocation, ever, citizen or not.

Anyone who shows up after that point — didn't exist yet, wasn't verified in
time, joined the network later — has no free path to INVEST. Their only way
in is the **INVEST secondary market**:

- `offerInvest(investAmount, paymentToken, paymentAmount)` — a citizen with
  spare INVEST lists some of it for sale, priced in an approved ERC-20. The
  offered INVEST escrows into the contract immediately.
- `governorOfferInvest(companyId, investAmount, paymentToken,
  paymentAmount)` — the governor equivalent: a company sells down some of
  its own held INVEST capital, and the payment becomes part of that
  company's ERC-20 treasury instead of going to an individual.
- `buyInvest(offerId)` — anyone pays the listed amount in the approved
  token and receives the INVEST.
- `cancelInvestOffer(offerId)` — the seller (citizen or governor, via their
  operating key) can pull an unfilled offer and get their escrowed INVEST
  back.

**Strict rule: no fiat, anywhere in this contract.** There is no bank
integration, no card rails, no fiat on-ramp of any kind — the only way to
acquire INVEST is to already hold an approved crypto asset and trade it for
some. What tokens count as "approved" is set by `setApprovedPaymentToken`,
owner-controlled. One real limitation worth being direct about: Solidity
has no way to inspect what a given ERC-20 economically represents. The
contract can refuse everything except a specific whitelist of addresses,
but it can't verify that a whitelisted token isn't, say, a stablecoin
pegged 1:1 to a real government currency — "no fiat" in spirit is a policy
choice you make when deciding what to approve, not a guarantee the code
enforces on its own.

## Deploying to a testnet (Sepolia) with Remix — no local setup needed

1. Open [remix.ethereum.org](https://remix.ethereum.org).
2. Create a new workspace, upload both `.sol` files.
3. In the **File Explorer**, right-click → add `@openzeppelin/contracts` via
   the built-in npm resolver (Remix does this automatically the first time
   you compile — it fetches from `registry.npmjs.org`).
4. Compiler tab → set compiler version to `0.8.20+`, compile both files.
5. Deploy & Run tab → Environment: **Injected Provider - MetaMask**, network
   set to Sepolia (get free test ETH from a Sepolia faucet).
6. Deploy `InvestToken` first, passing a `_maxCitizens` value — the hard
   cap on total allocations that can ever be minted, independent of who
   gets verified. For a small test run, something like `1000` is plenty;
   a real deployment would use the actual eligible population.
7. Deploy `ShareAuction`, passing the InvestToken address to the constructor.
8. Back on `InvestToken`, call `setAuctionHouse(<ShareAuction address>)` —
   this is the only address the token will ever allow a citizen to send it to.
9. Still on `InvestToken`, call `setVerifiedCitizen(<your wallet>, true)` for
   any wallet that should be allowed to claim — without this, `claim()`
   reverts.
10. **List every company you intend to privatize now, before anyone claims
    or bids** — e.g. `listCompany(0, "Bolnisi Gold Mines", 5, 600)`,
    `listCompany(1, "Georgian Railway", 5, 600)`, and so on. This matters
    more than it might look: `claim()` checks
    `ShareAuction.privatizationConcluded()`, which flips true once every
    *currently listed* company is finalized — so if you list companies in
    waves instead of up front, claiming can pause between waves even though
    you meant to add more later.
11. From a verified wallet, call `claim()` on InvestToken to get 1000
    INVEST — this only works while `privatizationConcluded()` is false, i.e.
    while at least one listed company hasn't been finalized yet.
12. Approve the auction house to pull your INVEST (`approve()` on
    InvestToken), then `placeBid(0, amount)` on ShareAuction.
13. After the deadline, anyone can call `finalize(0)` to settle it. Once
    *every* listed company has been finalized, `claim()` stops working —
    the emission ends when the privatization does.
14. Once company 0 is at least 50% assigned (`sharesIssued * 2 >=
    totalShares` — with only 5 shares, that's 3 or more sold), a
    shareholder calls `declareCandidacy(0, "my platform...")`. Get at least
    two candidates in if you want to see the runoff logic do anything.
15. Call `openGovernanceVote(0)` to start round 1 (3-day window).
    Shareholders call `vote(0, <candidate address>)`. After the window,
    anyone calls `tallyRound(0)` — either someone's elected (51% of votes
    cast), or the field narrows to two and a new round opens
    automatically; call `tallyRound(0)` again after each round's window.
16. The elected governor now has 30 days (`TERM_LENGTH`) of access — but
    first they must call `setOperatingKey(0, freshAddress)` from their
    election-winning wallet to register the key that will actually operate
    the company this term. From *that* key, they can call `invest(0,
    <toCompanyId>, amount)` to bid company 0's capital into another
    company's still-open auction, `distribute(0, [holder1, holder2, ...],
    amount)` to pay capital back out as a dividend, `withdrawToken(0,
    <erc20>, <to>, amount)` to move any other asset the company holds
    (deposited via `depositToken`), or `governorOfferInvest(0, amount,
    <erc20>, price)` to sell down company capital for outside crypto.
17. After 30 days, anyone can call `startNewTerm(0)` to wipe the old
    candidate list and reopen the whole election cycle for the next term.
18. Once term 1 is over (either because `startNewTerm` was called, or just
    because `governorTermEnd` has passed), anyone calls
    `openPolicyVote(0, 1)`. Shareholders call `votePolicy(0, 1,
    true)` (dividend) or `votePolicy(0, 1, false)` (reinvest). After the
    window, anyone calls `resolvePolicyVote(0, 1, [holder1, holder2, ...])`
    to execute whichever side won.
19. For the INVEST secondary market: the owner first calls
    `setApprovedPaymentToken(<some ERC-20>, true)` — e.g. a testnet USDC
    address. A citizen with spare INVEST calls `offerInvest(amount,
    <erc20>, price)`; anyone (citizen or not) calls `buyInvest(offerId)`
    to purchase it, paying in that ERC-20. This is the only path INVEST
    ever reaches a wallet that wasn't part of the original `claim()` round.

## Local dev with Hardhat (optional)

```bash
npm install --save-dev hardhat @openzeppelin/contracts
npx hardhat init
# copy the two .sol files into contracts/
npx hardhat compile
```

Write a small deploy script under `scripts/deploy.js` that deploys
`InvestToken`, then `ShareAuction`, then calls `setAuctionHouse`.

## Where this diverges from the playable prototype

The in-browser game in this same delivery simulates the identical mechanics
(equal allocation, pay-as-bid multi-unit auction, lock period, post-lock
trading) client-side with bots, so it's playable instantly with no wallet.
It isn't wired to these contracts — connecting a real front end to them via
`ethers.js`/`wagmi` and a deployed testnet address would be the next step if
you want the *actual* on-chain version to be playable, rather than just
deployable.
