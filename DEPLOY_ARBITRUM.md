# Arbitrum One Deployment Runbook

Real-money deployment. Every mistake here costs actual ETH, and nothing
can be undone. Follow the sequence exactly — every step below encodes a
real lesson, including several relearned the hard way on the same day
this runbook already existed, because the runbook wasn't checked
mid-session. Check it mid-session next time.

## Prerequisites (before touching Remix)

1. Real ETH on Arbitrum One in the deployer wallet (~$15-20 total is a
   comfortable buffer). Simplest path: MetaMask's built-in Buy button,
   selecting ETH + Arbitrum One as the network — lands directly in the
   wallet, no withdrawal-network risk. Card onramps charge a few percent
   and usually require KYC.
2. MetaMask has Arbitrum One added (chain ID 42161). MetaMask usually
   has it pre-listed; otherwise chainlist.org has correct params.
3. Remix open with all FIVE current .sol files present (InvestToken,
   ShareAuction, CompanyTreasury, RoundAuction, OpenVerifier) — ALL FIVE
   must be in the workspace even though only some are being deployed at
   a given moment, because of `import "./InvestToken.sol"` — a missing
   import file makes everything fail to compile at once (learned live,
   more than once).
4. **After pasting any updated .sol file into Remix, explicitly click
   Compile again before deploying** — do not assume a paste triggers a
   fresh compile. A stale/cached compile from before the paste can
   silently deploy old bytecode missing the new code entirely, with no
   error at deploy time. This was caught only by manually checking the
   new deployed contract's function list for the new function — that
   check is not optional, it is how the mistake was caught.

## The checks that prevented/caught real mistakes

- **Environment dropdown must say "Browser Extension" and show
  "Arbitrum One (42161)"** — NOT "Remix VM (...)" (the specific fork
  name in parentheses changes with Remix versions; the tell is the
  environment TYPE, not the fork name). A whole fake deployment happened
  on the simulated VM more than once across sessions; the tells were
  tiny sequential block numbers (1, 2, 3...) and no MetaMask popup. If
  MetaMask does not pop up asking to confirm, STOP — it is not real.
  Also check the "from" address in the receipt: Remix VM's default fake
  account is `0x5B38Da6a701c568545dCfcB03FcB875f56beddC4` — if you see
  that address anywhere in a receipt, the transaction is fake regardless
  of what the block number looks like.
- **After EVERY transaction, check the receipt's "to"/contract address
  against this runbook** before doing the next step. Multiple wrong-
  contract calls happened purely from clicking the wrong entry in
  Remix's "Deployed Contracts" list — old and new versions of the same
  contract sit in that list side by side with no visual distinction
  beyond the address, which is easy to misread at a glance.
- **When a contract dropdown shows an interface (e.g. "IShareAuction")
  instead of the actual contract**, Remix silently offers no useful
  deploy fields — this is the tell that the wrong entry is selected in
  the dropdown, not a bug. Reselect the real contract.
- **Delete orphaned entries from Remix's "Deployed Contracts" list**
  after any redeploy, before continuing — pure UI housekeeping (does
  nothing on-chain), but prevents exactly the wrong-contract mixups
  above.

## Deployment sequence (5 deployments)

Deploy order matters — later contracts take earlier ones' addresses as
immutable constructor args. **Any code change to InvestToken cascades
to all 5** (ShareAuction, CompanyTreasury, RoundAuction, and OpenVerifier
all reference InvestToken's address immutably) — there is no way to
upgrade InvestToken in place; a full redeploy of everything is the only
path, including relisting every company again.

1. **InvestToken** — constructor: `_maxCitizens` (choose deliberately;
   adjustable later downward-blocked, upward-only, via setMaxCitizens,
   owner-only — cannot go below current citizenCount).
   Record address: `INVEST = 0x...`
2. **ShareAuction** — constructor: `_investToken = INVEST`.
   Record: `AUCTION = 0x...`
3. **CompanyTreasury** — constructor: `_investToken = INVEST`,
   `_shareAuction = AUCTION`. Record: `TREASURY = 0x...`
4. **RoundAuction** — constructor: `_investToken = INVEST`.
   Record: `ROUND = 0x...`
5. **OpenVerifier** — constructor: `_investToken = INVEST`.
   Record: `VERIFIER = 0x...`

Record each deployment's BLOCK NUMBER too — the lowest one becomes
`deploymentBlock` in the site config (needed for chunked event queries;
do not guess it, read it off the receipt).

## Wiring (6 calls)

1. On ShareAuction: `setTreasury(TREASURY)`
2. On InvestToken: `setAuctionHouse(AUCTION)`
3. On InvestToken: `setAuthorizedSink(TREASURY, true)`
4. On InvestToken: `setAuthorizedSink(ROUND, true)` — without this,
   every RoundAuction bid reverts with "closed loop".
5. On InvestToken: `setVerifier(VERIFIER, true)` — without this,
   OpenVerifier.verifySelf() reverts; nobody can self-verify.
6. On InvestToken: `setRoundAuctionForTradability(ROUND)` — without
   this, the 51%-sold-out global tradability trigger never engages;
   INVEST stays permanently closed-loop even after real privatization
   progress.

**Double-check every address pasted into a wiring call against this
runbook before hitting Transact** — a `setVerifier` call was sent to
RoundAuction's address instead of OpenVerifier's once, purely from
misreading which address was copied. The mistake was harmless in that
specific case (RoundAuction never calls the gated function), but is not
guaranteed to be harmless in general — treat every wiring call as if a
wrong address could matter.

## Gas-safety constants worth knowing (not owner-adjustable — baked into
## the contract code, only changeable via a full redeploy)

- `MAX_BIDS = 500` (ShareAuction, RoundAuction) — caps bid count per
  company, bounding the O(n^2) sort cost in finalize()/settleRound() so
  neither can ever exceed a block's gas limit and become permanently
  stuck with funds locked inside.
- `MAX_SHARES_PER_ROUND = 1000` (RoundAuction only) — caps shares minted
  per settleRound() call, independent of a company's total totalShares.
  This is what makes an arbitrarily large totalShares (millions) safe:
  issuance simply spreads across more rounds rather than risking an
  unbounded mint loop in one transaction.
- `TRADABILITY_THRESHOLD_BPS = 5100` (RoundAuction) — the 51% figure
  that fires globalTradabilityUnlocked once any single company crosses
  it. Deliberately "any one company," not "all companies" or a global
  percentage — requiring every company to individually clear 51% could
  realistically never happen or take years, given how large totalShares
  can get.

## Verification (free reads — NEVER skip; "I remember doing it" was
## wrong more than once)

On InvestToken:
- `auctionHouse()` must return AUCTION
- `authorizedSink(TREASURY)` must return true
- `authorizedSink(ROUND)` must return true
- `verifier(VERIFIER)` must return true
- `roundAuctionForTradability()` must return ROUND

On ShareAuction:
- `treasury()` must return TREASURY

Functional proof (the strongest check): verify a citizen wallet via
`setVerifiedCitizen` (or, in production, via OpenVerifier.verifySelf()
from that wallet), then `claim()` — claim() internally calls through to
ShareAuction, so a clean claim proves the wiring end-to-end by behavior,
not just by getter.

## Contract verification on explorers

Do NOT use the "Verify Contract on Explorers" toggle in the Deploy panel
— it causes a silent UI crash on otherwise-successful deploys (an error
that looks like the deploy failed, when it actually succeeded). Keep it
off during every deploy.

Instead, verify AFTER deployment using Remix's separate **Contract
Verification** plugin (Plugin Manager -> search "Contract Verification"
-> activate -> its own icon appears in the left sidebar). This plugin
handles Sourcify, Etherscan (which covers Arbiscan via the unified v2
API), and Blockscout in one submission per contract:

1. Get an API key at etherscan.io/apidashboard (works across 50+ chains
   including Arbitrum, since Arbiscan now uses Etherscan's v2 API).
2. In the plugin's Settings tab, paste the key under "Etherscan -
   Arbitrum One", enable it.
3. In the Verify tab: select chain (Arbitrum One), paste the exact
   contract address (NOT the placeholder text left in the field from a
   prior run — clear it fully first), select the matching contract name
   from the dropdown (watch for it defaulting to an unrelated contract
   like an OpenZeppelin import), fill in constructor args exactly as
   deployed, check all three services, click Verify.
4. Repeat once per contract — there is no batch/multi-contract mode.

Confirm exact compiler version and optimizer settings first (Solidity
Compiler panel version string, e.g. `0.8.34+commit.80d5c536`; optimizer
enabled/runs from `remix.config.json`'s `solidity-compiler.settings` if
"Use configuration file" is selected rather than the manual toggle) —
though in practice the Contract Verification plugin auto-detects these
correctly from the workspace, so this is a sanity check, not usually
something to manually re-enter.

## Site flip (after all of the above)

In `site/src/web3.js`:
1. Fill `NETWORKS.arbitrum.addresses` with all FIVE real addresses
   (InvestToken, ShareAuction, CompanyTreasury, RoundAuction,
   OpenVerifier).
2. Set `NETWORKS.arbitrum.deploymentBlock` from the earliest deploy
   receipt in this round.
3. Confirm `ACTIVE_NETWORK` is `NETWORKS.arbitrum`.
Build, verify, push. **This step was forgotten entirely once** after a
full redeploy — the live site kept pointing at the previous round's
addresses until explicitly caught and fixed. Treat updating this file
as part of the deployment sequence itself, not an optional afterthought
done "whenever" — do it in the same sitting, immediately after wiring
verification passes.
