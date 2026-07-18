# Sakartvelo Exchange — site

The playable game, wrapped in a real Vite build so it can be deployed as an
actual website.

## Wallets: what's real now, what isn't yet

Every visitor gets a **real secp256k1 wallet**, generated in their own
browser with `ethers.js` and persisted in `localStorage` (so the same
browser keeps the same wallet across visits). This replaced the earlier
fake placeholder hash.

Be clear-eyed about what this does and doesn't solve:

- **What it fixes:** the wallet is real and unique per browser, not a
  cosmetic string. It's the actual identity primitive the real contracts
  (`InvestToken.sol`) expect.
- **What it doesn't fix:** "one wallet per browser" is not "one wallet per
  human." Clear site data or open a private window, and you get a fresh
  wallet with a fresh 1000 INVEST — sybil resistance hasn't moved. That's
  still `verifiedCitizen[address]` in `InvestToken.sol`, gated by whoever
  runs identity checks off-chain (see the main repo's `contracts/README.md`).
- **This wallet doesn't touch the contracts yet.** The game's economy is
  still simulated client-side (React state, bots, no real transactions).
  The wallet exists and is real; it's not yet calling `claim()` or
  `placeBid()` on anything deployed.

## Run it locally

```bash
npm install
npm run dev
```

## Deploy it (pick one — all have free tiers, all auto-redeploy on push)

**Vercel** — vercel.com -> "New Project" -> import this repo -> it
auto-detects Vite -> Deploy.

**Netlify** — netlify.com -> "Add new site" -> import this repo -> build
command `npm run build`, publish directory `dist` -> Deploy.

**GitHub Pages** — needs one extra step since it serves from a subpath:
1. `npm install --save-dev gh-pages`
2. In `vite.config.js`, add `base: '/sakartvelo-exchange/'` (your repo name)
3. Add to `package.json` scripts: `"deploy": "vite build && gh-pages -d dist"`
4. `npm run deploy`

## What's needed to wire the real wallet to the real contracts

Three things, none of which can be provisioned from a sandbox — all
require you to hold funded keys/accounts:

1. **Deployed contracts.** `InvestToken.sol` and `ShareAuction.sol` need to
   actually exist on a chain. See the main repo's `contracts/README.md` for
   the Remix/Sepolia walkthrough.
2. **An RPC endpoint** the browser can talk to (a public Sepolia RPC, or a
   free-tier Alchemy/Infura endpoint). The frontend would connect via
   `ethers.JsonRpcProvider(rpcUrl)` and attach the visitor's wallet to it.
3. **A gas-funding strategy.** Every `claim()` and `placeBid()` costs gas.
   On testnet that's free faucet ETH, but a visitor manually fetching
   faucet funds before they can claim a "free" allocation recreates the
   purchasing-power barrier this whole design exists to remove. A
   paymaster/relayer (account abstraction, ERC-4337) that sponsors gas for
   verified citizens is the real fix — that's a bigger build than swapping
   in a wallet was, and worth treating as its own step rather than bundling
   it in casually.
