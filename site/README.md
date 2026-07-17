# Sakartvelo Exchange — site

The playable game (`sovereign-lots.jsx` from the main repo, renamed
`src/App.jsx` here) wrapped in a real Vite build so it can be deployed as an
actual website. No backend, no database, no wallet — it's a self-contained
simulation that runs entirely in the visitor's browser.

## Run it locally

```bash
npm install
npm run dev
```

## Deploy it (pick one — all have free tiers, all auto-redeploy on push)

**Vercel** — vercel.com -> "New Project" -> import this repo -> it
auto-detects Vite -> Deploy. Done, you get a URL immediately.

**Netlify** — netlify.com -> "Add new site" -> import this repo -> build
command `npm run build`, publish directory `dist` -> Deploy.

**GitHub Pages** — needs one extra step since it serves from a subpath:
1. `npm install --save-dev gh-pages`
2. In `vite.config.js`, add `base: '/sakartvelo-exchange/'` (your repo name)
3. Add to `package.json` scripts: `"deploy": "vite build && gh-pages -d dist"`
4. `npm run deploy`

Any of these gives you one shareable link — nobody needs to install
anything, clone a repo, or set up a wallet to play. That's the whole point:
this version needs zero onboarding.

## If you eventually want this backed by a real chain

The `contracts/` folder in the main repo (`InvestToken.sol`,
`ShareAuction.sol`) is the real, deployable version. Wiring this front end
to it for real citizens is a materially bigger step — see the "real chain"
notes below before treating it as the same kind of one-click deploy as this
site is.

### Why "real citizens, real wallets" is the hard part

The game as built needs nothing from a visitor. The moment you wire it to
`InvestToken`/`ShareAuction` on a real chain, every visitor needs a wallet
before they can do anything — and that's exactly the "chasing citizens one
by one" problem. The standard fixes, roughly in order of how much friction
they remove:

- **Embedded / social-login wallets** (Privy, thirdweb, Dynamic, Coinbase
  Smart Wallet) — a visitor signs in with email or Google, a wallet is
  created for them behind the scenes. No browser extension, no seed phrase.
  This is the realistic path if the goal is "anyone can show up and claim."
- **WalletConnect / injected wallet button** — the traditional route
  (MetaMask etc.). Works, but assumes the visitor already has a wallet,
  which most people don't.
- **Gas** — someone still has to pay for `claim()` and `placeBid()`
  transactions. On a testnet that's free faucet ETH; on a real chain you'd
  want a paymaster/sponsor (account abstraction, ERC-4337) so citizens
  aren't asked to buy crypto before they can claim a free allocation —
  otherwise you've recreated exactly the purchasing-power barrier the
  whole design is meant to remove.

None of this is required to make the *game* playable — only to make the
*real token version* usable by people who've never touched crypto before.
