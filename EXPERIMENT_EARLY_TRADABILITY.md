# Natural experiment: early tradability of INVEST

**Pre-registration note — written 9 October 2026, 19:15 Tbilisi time (UTC+4),
before any outside participant has claimed INVEST.**

Author: Amiran Kapanadze · Project: Sakartvelo Exchange (Arbitrum One)
Related paper: *Monetization, Privatization, Capitalization: Formalizing a
Primary-Market Sequence for State-Asset Privatization On-Chain* —
https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7419018

---

## 1. Why this exists

The paper argues for a strict sequence: **monetization** (citizens receive
INVEST), then **privatization** (citizens spend INVEST on company shares in
round auctions), and only then **capitalization** (INVEST becomes freely
tradable). Trading opens only when a company has sold at least 51% of its
shares, so that ownership is spread before a market forms.

On 9 October 2026 that order was broken by accident. A one-share test company
(id 11, "Georgian Stock Exchange") sold its only share in a single bid. 1 of 1
shares is 100%, above the 51% threshold, so RoundAuction switched
`globalTradabilityUnlocked` to `true` while every real company was still
unsold. INVEST became freely transferable for all holders.

The live system is therefore now running the **counter-scenario** the paper
argues against: vouchers that can be traded *before* the assets are
distributed — the situation of the 1990s voucher privatizations. Rather than
reverting it immediately, the author has decided to observe it and record the
result.

## 2. Hypotheses

**H1 — the paper's thesis (sequencing matters).** With INVEST tradable before
companies are sold, participants will tend to sell or pool their INVEST rather
than bid with it, and ownership of INVEST, shares and governor seats will
concentrate in few hands.

**H0 — the counter-thesis (sequencing does not matter).** Even with early
tradability, most participants will bid their own INVEST, and ownership of
shares and governor seats will stay broadly spread.

## 3. Measures and thresholds

All figures come from public on-chain data (Arbiscan / contract events).
"System addresses" means RoundAuction, CompanyTreasury, the burn address and
any liquidity pool. Thresholds are fixed now and will not be changed after
the data is seen.

| # | Measure | Supports H1 if… | Supports H0 if… |
|---|---|---|---|
| M1 | Share of all claimed INVEST that left the claiming wallet **to a non-system address** (transfer or pool) before being bid | more than 50% | less than 25% |
| M2 | Share of non-system INVEST held by the top 10 wallets at the end of the window | more than 50% | less than 25% |
| M3 | For companies that sold at least one round: median share of issued shares held by the single largest holder | more than 50% | less than 25% |
| M4 | Governor elections won by a wallet (or wallet cluster, see §5) that also holds the most INVEST or shares across the system | more than half of decided elections | none or one |
| M5 | Number of distinct share-holding wallets across all companies, relative to the number of claimers | fewer than 25% of claimers hold shares | more than 60% of claimers hold shares |

Results between the two thresholds are recorded as **inconclusive** for that
measure. The overall reading is the majority of M1–M5 that are not
inconclusive.

## 4. Observation window

- **Start:** 9 October 2026 (this note).
- **Checkpoints:** every 7 days — 16, 23, 30 October, 6 November 2026.
- **End:** 8 November 2026 (30 days, one governance term), or earlier if an
  abort condition in §6 is triggered.
- **Minimum for any conclusion:** at least 20 claiming wallets other than the
  author's. Below that, the result is reported as "insufficient participation".

At each checkpoint, record: `citizenCount`, total supply, the Arbiscan holder
list, all INVEST transfers since the last checkpoint, and for each company:
shares issued, shareholder count, largest holder, governor.

## 5. Known limitations (stated in advance)

1. **Sybil wallets.** One person can control many wallets. OpenVerifier only
   checks that a wallet *holds* 0.0083 ETH, so the same ETH can verify many
   wallets in turn. Mitigation: cluster wallets that were funded with ETH from
   the same source address or that move INVEST between each other, and report
   every measure both per wallet and per cluster.
2. **No outside value.** INVEST has no market price unless someone creates a
   pool. Selling behaviour without a price differs from the voucher era.
3. **Small scale.** Participation will likely be in the tens, not thousands.
   Results show tendencies, not proof.
4. **Author involvement.** Before this note, the author (a) created and then
   began removing a small Uniswap v4 INVEST/ETH pool, (b) burned 1 INVEST to the
   standard burn address, (c) switched OpenVerifier off and back on. These may
   have influenced early behaviour and are listed in §7.
5. **Not real assets.** All companies are simulated; there is no real-world
   claim behind any share.

## 6. Abort conditions and allowed interventions

The experiment may be stopped early, and the stop recorded, if:

- a bug or exploit is found in the contracts;
- someone tries to use INVEST for something unlawful or misleading
  (for example, selling it to the public as a real investment);
- funds that are not the attacker's own are at risk.

Allowed interventions and their effect (each one transaction, each recorded
with its date and transaction hash):

| Intervention | Effect |
|---|---|
| `InvestToken.setVerifier(OpenVerifier, false)` | stops new self-verification |
| Deploy `TradabilityLock`, then `InvestToken.setRoundAuctionForTradability(lock)` | re-closes trading for all holders (ends the counter-scenario) |
| `InvestToken.setMaxCitizens(citizenCount)` | freezes the citizen list |

Any intervention during the window ends or changes the experiment and must be
logged in §7.

## 6a. Continuity commitment

Participants join a live system, not a disposable test. Whatever the result:

- **v8 is not retired when the window closes.** The contracts, the site and
  every holding (INVEST, share NFTs, governor seats, treasuries) stay as they
  are. Elections, auctions and treasury rules keep running.
- **Admin powers will not be used against holders.** After the window, the
  owner functions are used only to fix a bug or stop an exploit, and every use
  is logged publicly in this file with its transaction hash.
- **Lessons go into a new deployment, not into rewriting this one.** A future
  version (v9) will be launched alongside v8. Moving to it is each holder's own
  choice; nobody is forced to migrate, and v8 is not switched off to push
  people across.

### Lessons already learned (seed list for v9)

1. **The tradability rule must not be triggerable by a tiny company.** Unlock
   should require a minimum company size and a minimum number of distinct
   shareholders, not only 51% of shares sold.
2. **A balance check is not identity verification.** OpenVerifier's
   "holds 0.0083 ETH" check can be passed by one person with many wallets
   using the same ETH. v9 needs real proof of personhood or citizenship.
3. **Tradability should be a switch the design controls, not an accident.**
   v9 should make the phase change (privatization → capitalization) explicit
   and visible on the site.
4. **Test companies belong on a test network.** Single-share test listings on
   mainnet change system-wide state.

## 7. Log

| Date (Tbilisi) | Event | Reference |
|---|---|---|
| 8 Oct 2026 | v8 contracts deployed and verified on Arbitrum One | InvestToken `0x99ED3761F8416342D814ad4CCAe81993c2Ab7e4a` |
| 9 Oct 2026, ~01:20 | Company 11 (1 share) settled; tradability unlocked for all | RoundAuction `0x9739e5dCcc76BD424BcD12e7f1ce56143e77b796` |
| 9 Oct 2026 | Host fee of 10 INVEST withdrawn by the author | block 513002190 |
| 9 Oct 2026, ~16:20 | Author created a Uniswap v4 INVEST/ETH pool (0.25%) and added ~0.1 INVEST | pool `0x8883…d425` |
| 9 Oct 2026, ~17:00 | Author burned 1 INVEST to `0x…dEaD` | block 513203908 |
| 9 Oct 2026, 17:16 | OpenVerifier switched **off** | tx `0x6b50b5da282d98a7a359a83f5a84c472325479de7a27ab3abab1f36e766147a9` |
| 9 Oct 2026, ~17:22 | OpenVerifier switched back **on** | tx — *to be added* |
| 9 Oct 2026, ~17:25 | Author removing liquidity from the pool | tx — *to be added* |
| 9 Oct 2026, 19:15 | **This note written. Window opens.** State: total supply 1,000 INVEST, 4 holders (author, RoundAuction, Uniswap PoolManager, burn address), one citizen (the author). | — |

## 8. Reporting

At the end of the window, publish a short results note alongside this file
with the M1–M5 values, per wallet and per cluster, the overall reading
(H1 / H0 / inconclusive / insufficient participation), and the raw data used.
Whatever the result, it is reported.
