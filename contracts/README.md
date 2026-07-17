# Sovereign Lots — Contracts

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
  capitalizes the company, 1% accrues to the host. Once a company sells out,
  its shareholders elect a governor (`openGovernanceVote` →
  `vote` → `finalizeGovernance`, one vote per wallet weighted by shares of
  that company), and that governor can then `invest()` the company's
  capital into another company's live auction (buy) or `distribute()` it
  back to current shareholders as a dividend (sell/liquidate).

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

## Deploying to a testnet (Sepolia) with Remix — no local setup needed

1. Open [remix.ethereum.org](https://remix.ethereum.org).
2. Create a new workspace, upload both `.sol` files.
3. In the **File Explorer**, right-click → add `@openzeppelin/contracts` via
   the built-in npm resolver (Remix does this automatically the first time
   you compile — it fetches from `registry.npmjs.org`).
4. Compiler tab → set compiler version to `0.8.20+`, compile both files.
5. Deploy & Run tab → Environment: **Injected Provider - MetaMask**, network
   set to Sepolia (get free test ETH from a Sepolia faucet).
6. Deploy `InvestToken` first.
7. Deploy `ShareAuction`, passing the InvestToken address to the constructor.
8. Back on `InvestToken`, call `setAuctionHouse(<ShareAuction address>)` —
   this is the only address the token will ever allow a citizen to send it to.
9. Still on `InvestToken`, call `setVerifiedCitizen(<your wallet>, true)` for
   any wallet that should be allowed to claim — without this, `claim()`
   reverts.
10. From a verified wallet, call `claim()` on InvestToken to get 1000 INVEST.
11. On `ShareAuction`, `listCompany(0, "Bolnisi Gold Mines", 5, 600)` lists a
    company with 5 shares and a 10-minute auction window.
12. Approve the auction house to pull your INVEST (`approve()` on
    InvestToken), then `placeBid(0, amount)` on ShareAuction.
13. After the deadline, anyone can call `finalize(0)` to settle it.
14. Once finalized, anyone can call `openGovernanceVote(0)`; shareholders of
    company 0 call `vote(0, <candidate address>)`; after the 3-day window,
    anyone calls `finalizeGovernance(0)`.
15. The elected governor can now call `invest(0, <toCompanyId>, amount)` to
    bid company 0's capital into another company's still-open auction, or
    `distribute(0, [holder1, holder2, ...], amount)` to pay capital back out
    as a dividend.

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
