# Arbitrum One Deployment Runbook

Real-money deployment. Every mistake here costs actual ETH, and nothing
can be undone. Follow the sequence exactly — every step below encodes a
real lesson from the Sepolia phase, including the ones that cost hours.

## Prerequisites (before touching Remix)

1. Real ETH on Arbitrum One in the deployer wallet (~$15-20 total is a
   comfortable buffer). Simplest path: MetaMask's built-in Buy button,
   selecting ETH + Arbitrum One as the network — lands directly in the
   wallet, no withdrawal-network risk. Card onramps charge a few percent
   and usually require KYC.
2. MetaMask has Arbitrum One added (chain ID 42161). MetaMask usually
   has it pre-listed; otherwise chainlist.org has correct params.
3. Remix open with all four current .sol files present (InvestToken,
   ShareAuction, CompanyTreasury, RoundAuction) — ALL FOUR must be in
   the workspace even though only some are being deployed, because of
   `import "./InvestToken.sol"` — a missing import file makes everything
   fail to compile at once (learned live).

## The two checks that prevented/caught real mistakes on Sepolia

- **Environment dropdown must say "Browser Extension" and show
  "Arbitrum One (42161)"** — NOT "Remix VM (Prague)". A whole fake
  deployment happened on the simulated VM once; the tells were tiny
  block numbers (1, 2, 3...) and no MetaMask popups. If MetaMask does
  not pop up asking to confirm, STOP — it is not real.
- **After EVERY transaction, check the receipt's "to"/contract address
  against this runbook** before doing the next step. Multiple wrong-
  contract calls happened on Sepolia purely from clicking the wrong
  entry in Remix's "Deployed Contracts" list.

## Deployment sequence (4 deployments)

Deploy order matters — later contracts take earlier ones' addresses as
immutable constructor args.

1. **InvestToken** — constructor: `_maxCitizens` (choose deliberately;
   adjustable later via setMaxCitizens, owner-only).
   Record address: `INVEST = 0x...`
2. **ShareAuction** — constructor: `_investToken = INVEST`.
   Record: `AUCTION = 0x...`
3. **CompanyTreasury** — constructor: `_investToken = INVEST`,
   `_shareAuction = AUCTION`. Record: `TREASURY = 0x...`
4. **RoundAuction** — constructor: `_investToken = INVEST`.
   Record: `ROUND = 0x...`

Record each deployment's BLOCK NUMBER too — the lowest one becomes
`deploymentBlock` in the site config (needed for chunked event queries;
do not guess it, read it off the receipt).

## Wiring (4 calls — the step that silently failed once on Sepolia)

1. On ShareAuction: `setTreasury(TREASURY)`
2. On InvestToken: `setAuctionHouse(AUCTION)`
3. On InvestToken: `setAuthorizedSink(TREASURY, true)`
4. On InvestToken: `setAuthorizedSink(ROUND, true)` — without this,
   every RoundAuction bid reverts with "closed loop" (caught in design
   review before it happened live, unlike the first time).

## Verification (free reads — NEVER skip; "I remember doing it" was
wrong at least once on Sepolia)

On InvestToken:
- `auctionHouse()` must return AUCTION
- `authorizedSink(TREASURY)` must return true
- `authorizedSink(ROUND)` must return true

On ShareAuction:
- `treasury()` must return TREASURY

Functional proof (the strongest check): verify a citizen wallet via
`setVerifiedCitizen`, then `claim()` — claim() internally calls through
to ShareAuction, so a clean claim proves the wiring end-to-end by
behavior, not just by getter.

## Contract verification on explorers

Remix auto-submits to Sourcify/Blockscout (works without keys).
Etherscan-family (Arbiscan) needs an API key configured in Remix
settings — without it, Arbiscan shows raw bytecode only, and its
Read/Write tabs are unavailable (hit this live; Blockscout's
equivalent tabs were the workaround).

## Site flip (after all of the above)

In `site/src/web3.js`:
1. Fill `NETWORKS.arbitrum.addresses` with the four real addresses.
2. Set `NETWORKS.arbitrum.deploymentBlock` from the earliest deploy
   receipt.
3. Change `ACTIVE_NETWORK` to `NETWORKS.arbitrum`.
Build, verify, push. The warning banner flips to the real-money
version automatically via `isTestnet: false`.
