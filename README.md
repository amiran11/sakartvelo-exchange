# Sakartvelo Exchange

> **FICTIONAL SIMULATION.** Not a real country, government, company, or
> financial product. Any resemblance to real states, state assets, or
> companies is fictional and exists solely as a gamified rule-set. All
> three contracts also carry this on-chain as a `DISCLAIMER` constant.

A privatization auction, simulated end to end: equal one-time citizen
allocations, pay-as-bid share auctions, runoff-elected governors with
rotating operating keys, a 5%-free/commit-reveal/vendor-vote treasury
guardrail system, a mandatory end-of-term dividend/reinvest vote,
multi-asset company treasuries, and a real secondary market — both for
shares and for the INVEST currency itself, since anyone who wasn't a
citizen during the original privatization has to buy in rather than claim
for free.

## What's in this folder

- **`sovereign-lots.jsx`** — the playable demo. Single-file React
  component, no wallet or blockchain connection required, everything runs
  client-side against three AI-bot bidders. **Note:** this demo still
  simplifies governance to one instant choice per company — it does not
  run the full candidacy/runoff/operating-key/treasury-guardrail/policy-vote
  system described below. The landing page inside it says so explicitly.
- **`site/`** — the same game wrapped in a real Vite + Tailwind build,
  deployable as an actual website (Vercel/Netlify/GitHub Pages — see
  `site/README.md`). This version also generates a **real** secp256k1
  wallet per visitor via `ethers.js` (the in-chat demo can't — its sandbox
  doesn't have access to that library). The wallet is real; it isn't wired
  to any deployed contract yet.
- **`contracts/InvestToken.sol`** — closed-loop ERC-20. Citizens can only
  spend it into the auction house or an authorized sink; those can pay
  funds out freely (refunds, dividends, fees). Gated behind
  `verifiedCitizen` + `maxCitizens` + tied to
  `ShareAuction.privatizationConcluded()`.
- **`contracts/ShareAuction.sol`** — everything that touches a Share NFT
  directly: pay-as-bid auctions, 7-day lock, 99/1 capital/host split,
  runoff-elected governors (candidacy at 50% assigned, 51% to win or
  elimination-to-top-2, 30-day terms with a separately-registered rotating
  operating key), and the share secondary market.
- **`contracts/CompanyTreasury.sol`** — everything a governor can do that
  doesn't touch an NFT: multi-asset ERC-20 custody with a 5% free tier,
  commit-reveal treasury auctions and a 51%-vote vendor-payment path for
  anything above that tier, the mandatory end-of-term policy vote, and the
  INVEST secondary market (the only way anyone who wasn't an original
  citizen ever acquires INVEST — paid in an approved crypto asset, never
  fiat). Split into its own contract because `ShareAuction` alone
  exceeded Ethereum's 24,576-byte deployment limit once all of this lived
  in one place — see `contracts/README.md` for the full story.
- **`contracts/README.md`** — full mechanism documentation and a complete
  Remix/Sepolia deploy walkthrough, step by step, including the
  three-contract wiring (`setTreasury`, `setAuthorizedSink`, etc.) and the
  compiler optimizer setting required to deploy at all.

## Where the demo and the contracts diverge

The playable game and the real contracts are **not** in sync — called out
explicitly rather than left implicit:

| | Demo (`sovereign-lots.jsx` / `site/`) | Contracts |
|---|---|---|
| Auction | Sequential per-lot rounds | Single-shot `finalize()` for all shares at once |
| Governance | One instant choice (reinvest/dividend/hold) | Full candidacy + runoff election |
| Governor term / keys | Not modeled | 30-day term, separately registered operating key |
| Treasury guardrails | Not modeled | 5% free tier, commit-reveal auction, 51%-vote vendor payments |
| End-of-term policy vote | Not modeled | Mandatory 1% dividend-or-reinvest vote |
| Multi-asset treasury | Not modeled | `depositToken`/`withdrawToken` |
| INVEST secondary market | Not modeled | `offerInvest`/`buyInvest`/`governorOfferInvest` |
| Wallet | Real (site only), not connected to any contract | N/A — this IS the contract |

Closing this gap (making the demo actually run the full contract logic,
or connecting the site's wallet to a deployed instance) is real,
sizeable follow-up work, not a quick fix.

## Quick start

**Play the demo:** open `sovereign-lots.jsx` wherever you render React
artifacts, or `npm install` it into any Vite/CRA app with `lucide-react`.

**Run the site locally:** `cd site && npm install && npm run dev`

**Deploy the site:** see `site/README.md`.

**Deploy the contracts for real:** see `contracts/README.md`. Note the
compiler optimizer requirement (`runs: 200`) — without it, two of the
three contracts are too large to deploy.
