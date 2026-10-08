# Redeploy checklist: v8 (RoundAuction v8, Governance, CompanyTreasury v6)

This replaces RoundAuction and CompanyTreasury and adds a new Governance
contract. Why: SECURITY_REVIEW.md, Findings 9–22.

**Stays exactly as is (no redeploy):** InvestToken, OpenVerifier,
ShareAuction.

| Contract | Address (Arbitrum One) |
|---|---|
| InvestToken (unchanged) | `0x38E02e24Fddc1F34a8F5BDFD1cc308407627c766` |
| OpenVerifier (unchanged) | `0x4Be82ae3f86Bdf35725f686b33b8FfB9a8aE6512` |
| RoundAuction v7 (being replaced) | `0xf78B615cC0aA83BDa50b2990817A96b0434Cc38d` |
| CompanyTreasury v5 (being replaced) | `0x6640Ba0D2E5E8652dbF2cddE7af8B01055A84241` |

**Golden rule, same as every deploy:** after every transaction, read the
value back and check it before moving on. A green receipt is not proof.

Write each new address down as you go. You'll need all three at the end.

---

## Part 0 — Before you start (about 10 minutes)

**0.1 Write down the 10 companies from the old contract.** The new
RoundAuction starts empty, so you'll relist them with the same values.

1. In Remix, open **RoundAuction.sol** from the `main` branch version
   (the one currently live) and compile it.
2. Go to **Deploy & Run Transactions**. Environment: **Injected
   Provider – MetaMask**, network **Arbitrum One**.
3. Contract dropdown: **RoundAuction**. Paste
   `0xf78B615cC0aA83BDa50b2990817A96b0434Cc38d` into **At Address** and
   click it. Do NOT click Deploy.
4. In the loaded contract, find **companies**, type `0`, click it.
   Write down **name**, **totalShares** and **roundDuration**.
5. Repeat for `1` through `9`.

> **Worth a decision before relisting:** v8 sells at most 300 shares per
> round (Finding 11). A company with millions of shares would take
> thousands of rounds to sell half and open elections. If any of your
> totalShares are very large, you may want smaller numbers this time.
> Tell me and I'll suggest values.

**0.2 Get the new contract files.** On GitHub, switch to the
**rebuild-v8** branch. You need these four from the `contracts` folder:
`InvestToken.sol` (unchanged, needed for imports), `RoundAuction.sol`,
`Governance.sol`, `CompanyTreasury.sol`. Put them in Remix, replacing
the old RoundAuction.sol and CompanyTreasury.sol.

**0.3 Compiler settings** (Solidity Compiler tab → Advanced
Configurations), same as October 3:

- Compiler: **0.8.34**
- **Enable optimization**, runs **200**
- **viaIR: on** (via the compiler configuration file, as on October 3)
- EVM version: leave as you used on October 3

**0.4 Check you're on the real network.** In Deploy & Run, the account
shown must be your owner wallet (the one that owns InvestToken), and
MetaMask must say **Arbitrum One**. If you ever see account
`0x5B38Da…` or block numbers like 1, 2, 3, you are on Remix VM. Stop
and switch to Injected Provider.

---

## Part 1 — Deploy the three contracts

### Step 1. Deploy RoundAuction v8

1. Compile **RoundAuction.sol**. Contract dropdown: **RoundAuction**.
2. Next to Deploy, enter `_investToken`:
   `0x38E02e24Fddc1F34a8F5BDFD1cc308407627c766`
3. Click **Deploy**, confirm in MetaMask.
4. **Check (stale-bytecode trap):** in the deployed contract's function
   list, you must see **getActiveBids**, **activeBidCount**,
   **setGovernance** and **shareCountAt**. If they're missing, Remix
   deployed the old file: stop and tell me.
5. **Check:** click **investToken** → must read `0x38E0…c766`.
6. Write down the address: **NEW_RA = ______________**

### Step 2. Deploy Governance

1. Compile **Governance.sol**. Contract dropdown: **Governance**.
2. Enter `_shares`: **NEW_RA** (from step 1).
3. Deploy, confirm.
4. **Check:** click **shares** → must read NEW_RA. You should also see
   **lastRoundId** in the function list.
5. Write down: **NEW_GOV = ______________**

### Step 3. Deploy CompanyTreasury v6

1. Compile **CompanyTreasury.sol**. Contract dropdown: **CompanyTreasury**.
2. Three constructor fields (new: there are three now, not two):
   - `_investToken`: `0x38E02e24Fddc1F34a8F5BDFD1cc308407627c766`
   - `_roundAuction`: **NEW_RA**
   - `_governance`: **NEW_GOV**
3. Deploy, confirm.
4. **Check:** **roundAuction** reads NEW_RA, **governance** reads
   NEW_GOV, **investToken** reads `0x38E0…c766`. You should see
   **claimTreasuryAuction** and **vendorPaymentPasses**, and NOT see
   **distribute**.
5. Write down: **NEW_CT = ______________**

---

## Part 2 — Wire them together

### Step 4. RoundAuction → Governance

1. On NEW_RA: **setGovernance**, paste NEW_GOV, transact.
2. **Check:** **governance** reads NEW_GOV.
3. This can only be set once. If you paste the wrong address, stop and
   tell me: it means redeploying RoundAuction.

### Step 5. RoundAuction → CompanyTreasury

1. On NEW_RA: **setTreasury**, paste NEW_CT, transact.
2. **Check:** **treasury** reads NEW_CT. Also set-once.

### Step 6. Load InvestToken

In Remix, compile **InvestToken.sol**, choose **InvestToken**, paste
`0x38E02e24Fddc1F34a8F5BDFD1cc308407627c766` into **At Address**, click it.

### Step 7. Allow citizens to send INVEST to the new contracts

1. On InvestToken: **setAuthorizedSink** with `account` = NEW_RA,
   `allowed` = `true`. Transact.
2. **Check:** **authorizedSink**(NEW_RA) reads `true`.
3. Same again with `account` = **NEW_CT**, `allowed` = `true`.
4. **Check:** **authorizedSink**(NEW_CT) reads `true`.

### Step 8. Point tradability at the new RoundAuction

1. On InvestToken: **setRoundAuctionForTradability**, paste NEW_RA, transact.
2. **Check:** **roundAuctionForTradability** reads NEW_RA.

### Step 9. Close the old contracts to deposits

So nobody can accidentally send INVEST to the retired contracts. From
this step until the updated site goes live, the current site can't take
bids (it still points at the old contracts). Since no citizens have
joined yet, that's harmless; just do steps 9–13 in one sitting.

1. **setAuthorizedSink**(`0xf78B615cC0aA83BDa50b2990817A96b0434Cc38d`, `false`)
2. **Check:** authorizedSink of that address reads `false`.
3. **setAuthorizedSink**(`0x6640Ba0D2E5E8652dbF2cddE7af8B01055A84241`, `false`)
4. **Check:** reads `false`.

---

## Part 3 — Relist and finish

### Step 10. Relist the 10 companies

On NEW_RA, for each company you wrote down in step 0.1:
**listCompany**(`companyId`, `name`, `totalShares`, `roundDuration`).

- Use the same ids 0–9 as before.
- **Check after each:** **companies**(id) shows the right name and
  totalShares, and **companiesListed** has gone up by one.

### Step 11. Payment tokens for the INVEST market (only if used before)

If you had approved a payment token (for example a stablecoin) on the
old treasury: on NEW_CT, **setApprovedPaymentToken**(token address,
`true`). **Check:** **approvedPaymentTokens**(token) reads `true`.

### Step 12. Verify the source code publicly

Verify NEW_RA, NEW_GOV and NEW_CT on Arbiscan, Sourcify and Blockscout,
with exactly the compiler settings from step 0.3, the same way as on
October 3. Governance has one constructor argument (NEW_RA);
CompanyTreasury has three.

### Step 13. Send me the three addresses

Send NEW_RA, NEW_GOV and NEW_CT, plus the **block number** of the
RoundAuction deploy (shown in its Arbiscan transaction page). I'll
update the site so it uses the new contracts.

---

## If something goes wrong

- **A transaction fails:** don't retry blindly. Send me a screenshot of
  the error.
- **A Check shows the wrong value:** stop there and tell me which step.
- **Nothing is lost by stopping halfway:** until step 8, the live site
  keeps working on the old contracts.
- **After step 9,** the live site can't take bids until I ship the
  updated frontend with your new addresses.
