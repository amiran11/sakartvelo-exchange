# Fresh deploy checklist: v8 (everything from scratch)

Deploys a complete new set of contracts on Arbitrum One:

| # | Contract | What it does |
|---|---|---|
| 1 | InvestToken | Citizen list and the INVEST currency |
| 2 | OpenVerifier | Lets anyone holding 0.0083+ ETH verify themselves as a citizen |
| 3 | RoundAuction v8 | Share auctions, share NFTs, company capital |
| 4 | Governance | Elections, governors, operating keys |
| 5 | CompanyTreasury v6 | Company money: custody, auctions, payments, dividends, INVEST market |

**Why from scratch, not partial:** citizenship lives in InvestToken and
assets lived in the old RoundAuction. The October 3 partial redeploy left
the author's wallet marked as a citizen who had already claimed, with
its shares and INVEST stranded in a retired contract. A fresh
InvestToken gives everyone a clean start. Nobody else has joined, so
nothing is lost.

**ShareAuction is retired.** It never had a listing. It is not deployed
again, and the site no longer shows it.

**Rehearsed:** this exact sequence, with the same checks, runs clean on
a local chain set to Arbitrum's limits (`test/rehearse-fresh-deploy.mjs`).

**Golden rule:** after every transaction, read the value back and
compare. A green receipt is not proof.

Write each new address down as you go:

| | Address | Deploy block |
|---|---|---|
| NEW_IT (InvestToken) | | |
| NEW_OV (OpenVerifier) | | |
| NEW_RA (RoundAuction) | | |
| NEW_GOV (Governance) | | |
| NEW_CT (CompanyTreasury) | | |

---

## Part 0 — Decide and prepare (about 15 minutes)

**0.1 Citizen limit.** InvestToken caps how many citizens can ever claim.
Suggested: **1000** (or the value on the current InvestToken: load it at
`0x38E02e24Fddc1F34a8F5BDFD1cc308407627c766` with At Address and click
**maxCitizens**). It can be raised later with **setMaxCitizens**.

**0.2 Companies and share counts.** This matters more than it looks.
Every citizen gets 1,000 INVEST, and a share sells for at least 1 INVEST.
Elections open only once half a company's shares are sold. Selling half
of a 10,000-share company takes at least 5,000 INVEST, five citizens
spending everything on that one company. With 10,000–100,000 shares per
company, elections would effectively never open during a pilot.

Suggested for the pilot (ids 0–9, round length 3600 seconds = 1 hour):

| id | name | totalShares |
|---|---|---|
| 0 | (your company 0) | 100 |
| 1 | (your company 1) | 200 |
| 2 | (your company 2) | 300 |
| 3 | (your company 3) | 400 |
| 4 | (your company 4) | 500 |
| 5 | (your company 5) | 600 |
| 6 | (your company 6) | 700 |
| 7 | (your company 7) | 800 |
| 8 | (your company 8) | 900 |
| 9 | (your company 9) | 1000 |

To keep your current names: load the current RoundAuction at
`0xf78B615cC0aA83BDa50b2990817A96b0434Cc38d` with At Address, click
**companies** for ids 0–9, and copy each **name** (and **roundDuration**
if you want to keep it).

**0.3 Files.** On GitHub, switch to the **rebuild-v8** branch. From the
`contracts` folder you need: `InvestToken.sol`, `OpenVerifier.sol`,
`RoundAuction.sol`, `Governance.sol`, `CompanyTreasury.sol`. Put them in
Remix, replacing any older copies.

**0.4 Compiler** (Solidity Compiler tab → Advanced Configurations), same
as October 3: version **0.8.34**, **optimization on, 200 runs**, **viaIR
on**, EVM version as you used on October 3.

**0.5 Network.** Deploy & Run → Environment **Injected Provider –
MetaMask**, network **Arbitrum One**, account = the wallet that will own
everything. If you see account `0x5B38Da…` or block numbers like 1, 2, 3,
you're on Remix VM: stop and switch.

**0.6 Gas.** Five deploys plus about 20 transactions. Have roughly
0.002 ETH on Arbitrum One in the owner wallet.

---

## Part 1 — Deploy

### Step 1. InvestToken

1. Compile **InvestToken.sol**, choose **InvestToken**.
2. `_maxCitizens`: your number from 0.1 (for example `1000`).
3. Deploy, confirm.
4. **Check:** **symbol** reads `INVEST`; **maxCitizens** reads your
   number; **owner** reads your wallet.
5. Write down **NEW_IT** and its **deploy block** (Arbiscan → the
   transaction → Block). The site needs this block number.

### Step 2. OpenVerifier

1. Compile **OpenVerifier.sol**, choose **OpenVerifier**.
2. `_investToken`: **NEW_IT**. Deploy, confirm.
3. **Check:** **investToken** reads NEW_IT; **MIN_BALANCE** reads
   `8300000000000000` (0.0083 ETH).
4. Write down **NEW_OV**.

### Step 3. RoundAuction v8

1. Compile **RoundAuction.sol**, choose **RoundAuction**.
2. `_investToken`: **NEW_IT**. Deploy, confirm.
3. **Check (stale-bytecode trap):** the function list must include
   **getActiveBids**, **setGovernance** and **shareCountAt**. If not,
   Remix deployed an old file: stop and tell me.
4. **Check:** **investToken** reads NEW_IT.
5. Write down **NEW_RA**.

### Step 4. Governance

1. Compile **Governance.sol**, choose **Governance**.
2. `_shares`: **NEW_RA**. Deploy, confirm.
3. **Check:** **shares** reads NEW_RA; **lastRoundId** is in the list.
4. Write down **NEW_GOV**.

### Step 5. CompanyTreasury v6

1. Compile **CompanyTreasury.sol**, choose **CompanyTreasury**.
2. Three fields: `_investToken` **NEW_IT**, `_roundAuction` **NEW_RA**,
   `_governance` **NEW_GOV**. Deploy, confirm.
3. **Check:** **investToken**, **roundAuction**, **governance** read back
   those three. **claimTreasuryAuction** is in the list; **distribute**
   is NOT.
4. Write down **NEW_CT**.

---

## Part 2 — Wire

### Step 6. RoundAuction → Governance

On NEW_RA: **setGovernance**(NEW_GOV). **Check:** **governance** reads
NEW_GOV. *Set-once: a wrong address means redeploying RoundAuction.*

### Step 7. RoundAuction → Treasury

On NEW_RA: **setTreasury**(NEW_CT). **Check:** **treasury** reads NEW_CT.
*Also set-once.*

### Step 8. Let OpenVerifier verify citizens

On NEW_IT: **setVerifier**(NEW_OV, `true`). **Check:** **verifier**(NEW_OV)
reads `true`.

### Step 9. Let citizens spend INVEST into the system

On NEW_IT: **setAuthorizedSink**(NEW_RA, `true`), then
**setAuthorizedSink**(NEW_CT, `true`). **Check:** **authorizedSink** of
each reads `true`.

### Step 10. Tradability

On NEW_IT: **setRoundAuctionForTradability**(NEW_RA). **Check:**
**roundAuctionForTradability** reads NEW_RA.

Do **not** call **setAuctionHouse**. **Check:** **auctionHouse** reads
`0x0000000000000000000000000000000000000000`.

---

## Part 3 — List, verify, test

### Step 11. List the companies

On NEW_RA, for each row of your table from 0.2:
**listCompany**(id, name, totalShares, 3600).
**Check after each:** **companies**(id) shows the right name and
totalShares; **companiesListed** went up by one.

### Step 12. Payment token for the INVEST market (optional)

Only if you want the INVEST market open now: on NEW_CT,
**setApprovedPaymentToken**(token address, `true`). **Check:**
**approvedPaymentTokens**(token) reads `true`.

### Step 13. Verify the source code

Verify all five on Arbiscan, Sourcify and Blockscout, with exactly the
compiler settings from 0.4. Constructor values: InvestToken
(maxCitizens), OpenVerifier (NEW_IT), RoundAuction (NEW_IT), Governance
(NEW_RA), CompanyTreasury (NEW_IT, NEW_RA, NEW_GOV).

### Step 14. Send me the addresses

Send the five addresses and NEW_IT's deploy block. I'll point the site
at them and merge `rebuild-v8` into `main`.

### Step 15. Smoke test with your own wallet (after the site is updated)

1. On the live page, connect, click verify, then claim: you should get
   1,000 INVEST.
2. Bid a few INVEST on the smallest company. After the round closes,
   settle it: the share NFTs appear in your wallet.

---

## If something goes wrong

- **A transaction fails:** don't retry blindly. Send me a screenshot.
- **A Check shows the wrong value:** stop at that step and tell me which.
- **Stopping halfway is safe.** Nothing touches the old contracts, and
  the live site keeps using them until I switch it in step 14.
