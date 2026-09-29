# Redeploy: Fund Custody Fix, Reinvestment Restriction, Governor Compensation

This redeploy touches **both** `RoundAuction.sol` and `CompanyTreasury.sol`
substantially — unlike the two smaller self-audit fixes before it (see
`SECURITY_REVIEW.md`), which only needed `CompanyTreasury` redeployed.
This one changes `RoundAuction` itself, so both contracts get fresh
addresses.

## Why this was necessary

Three separate, real problems, each surfaced by asking a direct question
about how the system should actually behave — not found through abstract
review, through concretely asking "what happens when X."

### 1. A genuine fund-custody bug — dividends could never actually be paid

Tracing through exactly where INVEST tokens physically live at every
step revealed that `adjustCapital()` — the only function letting
`CompanyTreasury` touch a company's capital — only updated an internal
accounting number. It never moved any real tokens. Meanwhile,
`CompanyTreasury`'s payout functions (`distribute()`, `claimDividend()`,
the INVEST secondary market) all assumed they already held the
underlying INVEST to pay out. They didn't; the real tokens never left
`RoundAuction`. **Any real attempt to pay a dividend, sell company
INVEST, or settle a treasury auction would simply have reverted** with
an insufficient-balance error — not a risk, a certainty.

**Fix:** `adjustCapital()` now enforces a real invariant: `RoundAuction`
always physically holds INVEST tokens equal to the sum of every
company's tracked capital. A negative delta pays real tokens out to the
treasury at the exact moment the ledger updates. A positive delta
requires the treasury to have already sent the matching real tokens in
the same transaction — every caller in `CompanyTreasury` that credits
capital now does exactly that (forward the tokens, then call
`adjustCapital`), rather than assuming money that was never actually
transferred.

### 2. Governors could reinvest a company's original citizen-funded capital, not just income

Nothing previously distinguished "capital citizens originally paid in
during privatization" from "income the company has earned since." A
governor calling `invest()` could commit **100% of a company's original
capital** to a single cross-holding bet, with no more protection than
being elected — a materially larger risk than the existing 5% cap on
ordinary token withdrawals.

**Fix:** a new, separate `reinvestableIncome` pool per company.
`invest()` now draws exclusively from this pool — never from original
`capital`. Original capital can still return to citizens through
dividends, but a governor can never spend it on a new investment.
Income only enters this pool through a real, traceable path (see #3).

### 3. Corporate cross-holdings couldn't actually receive income, so there was no way to fund #2's restriction anyway

Once original capital was correctly walled off, income needed a real
way to flow *in*. Corporate holdings (companies that invested in other
companies via `invest()`) could accumulate voting power in what they'd
invested in, but had no way to actually **claim a dividend** — the
existing `claimDividend()` checks `msg.sender` directly, and a
synthetic corporate-holder address has no private key to call anything.

**Fix:** `claimDividendAsCorporation()`, mirroring the existing
`voteAsCorporation()` pattern — a company's governor can claim a
dividend on behalf of shares their organization holds elsewhere, with
proceeds credited directly into that company's `reinvestableIncome`
pool, never to any individual wallet.

## What else shipped in the same pass: governor in-kind compensation

Decided separately, alongside the above: governors are compensated 1%
of shares actually won through a reinvestment they initiated, paid
in-kind (in the acquired shares themselves, not INVEST), locked until
the origin company's governance has rotated through 2 more full terms.
This is carved out automatically at the moment of settlement in
`_mintShares()` — the same internal function both the main proportional
pass and the stall-breaker fallback call, so the rule can't silently
apply in one path and not the other. An ordinary citizen's winning bid
is completely unaffected; the compensation branch only triggers when
the winning bidder is a recognized corporate-holder address.

## What stays exactly the same

`InvestToken`, `OpenVerifier`, and `ShareAuction` — no code changes, no
redeploy needed, existing addresses stay valid. The existing 1%
host fee on every settlement is unchanged, and does not compound with
governor compensation — one is taken from the INVEST currency side of a
settlement, the other from the share side of a reinvestment
specifically; they never apply to the same value twice.

## Deployment sequence

Both `RoundAuction` and `CompanyTreasury` need fresh addresses this
time, since `RoundAuction` itself changed:

1. **Deploy new `RoundAuction`** — same single constructor arg as
   always: `_investToken`.
2. **Deploy new `CompanyTreasury`** — constructor: `_investToken`, and
   the **new** `RoundAuction` address from step 1.
3. **Wire:** new `RoundAuction.setTreasury(new CompanyTreasury address)`.
4. **Wire:** `InvestToken.setAuthorizedSink(new RoundAuction address, true)`.
5. **Wire:** `InvestToken.setRoundAuctionForTradability(new RoundAuction address)`.
6. **Relist all 10 companies** on the new `RoundAuction` — it's a fresh
   contract with empty company state, same as every prior full redeploy.
7. **Update `web3.js`** with both new addresses.
8. **Verify both new contracts** on Arbiscan, Sourcify, and Blockscout.

Any real state on the currently-live `RoundAuction` v7 / `CompanyTreasury`
v5 (active bids, any real governance already underway) is abandoned by
this redeploy, same tradeoff as every previous one tonight.
