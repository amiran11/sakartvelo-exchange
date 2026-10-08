# Tests

All tests run against a local chain ([anvil](https://book.getfoundry.sh/anvil/))
configured with Arbitrum One's real limits: 32,000,000 gas per
transaction and the 24,576-byte contract size cap. Contracts are
compiled with Solidity 0.8.34, optimizer 200 runs, viaIR, OpenZeppelin 5.x
(the same settings as the mainnet deploy).

| File | What it covers | Result (Oct 2026) |
|---|---|---|
| `roundauction.test.mjs` | RoundAuction v8 on its own: allocation, bid limits, carry-forward, refunds, corporate bids, share market, balance history | 35 passed |
| `roundauction.gas.mjs` | Worst-case settlement gas | 22.1M of 32M |
| `system.test.mjs` | All three contracts together, incl. the full corporate chain (asset sale → invest → corporate shares → corporate vote → corporate dividend) | 57 passed |
| `site-web3.test.mjs` | The website's own `site/src/web3.js` functions against freshly deployed contracts | 38 passed |
| `rehearse-fresh-deploy.mjs` | `REDEPLOY_V8.md` performed step by step with the same read-back checks, then a new citizen verifies, claims, bids and receives shares | all checks passed |
| `ui/` | The built website in Chromium: a new wallet verifying and claiming, bidding, reading candidate programs and voting, sealed bids, payment votes, the INVEST market, governor withdrawals; every click checked on chain | 25 passed |

Contract tests expect compiled artifacts in `art8/art_<Name>.json`; the
site tests set `ART` to a folder of `<Name>.art.json` files. `ui/run-ui.sh`
starts the chain, deploys a test scenario, builds the site in local mode
(`VITE_NETWORK=local`) and serves it; then run `ui/ui.mjs`. Paths at the
top of the scripts point at the machine they were last run on.
