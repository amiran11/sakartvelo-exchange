import { useState, useEffect, useCallback } from "react";
import { Clock, RefreshCw } from "lucide-react";
import {
  getListedRoundCompanies,
  getRoundBids,
  getRoundAuctionRules,
  getRoundInvestAllowance,
  approveInvestForRound,
  placeRoundBid,
  settleRoundReal,
  parseAmount,
} from "../web3.js";
import CompanyGovernance from "./CompanyGovernance.jsx";
import CompanyTreasury from "./CompanyTreasury.jsx";
import InvestMarket from "./InvestMarket.jsx";
import { C, same, fmt, useCountdown, useTx } from "./liveUtils.js";
import { Button, Input, Muted, ErrorLine } from "./ui.jsx";

function RoundCompanyCard({ company, companies, wallet, rules, onChanged }) {
  const [bids, setBids] = useState(null);
  const [bidAmount, setBidAmount] = useState("");
  const { busy, error, setError, run } = useTx();
  const { passed: closed, label } = useCountdown(company.roundEnd);

  const loadBids = useCallback(async () => {
    setBids(await getRoundBids(company.id, wallet.provider));
  }, [company.id, wallet.provider]);

  useEffect(() => { loadBids(); }, [loadBids]);

  const myBid = bids?.find((b) => same(b.bidder, wallet.address));
  const sharesRemaining = company.totalShares - company.sharesIssued;
  const lowest = bids && bids.length ? bids.reduce((m, b) => (b.amount < m ? b.amount : m), bids[0].amount) : null;
  const full = rules && bids && BigInt(bids.length) >= rules.maxActiveBids;
  const refresh = async () => { await loadBids(); if (onChanged) await onChanged(); };

  const handleBid = async () => {
    let amount;
    try { amount = await parseAmount(bidAmount, 18); } catch { setError("Enter how much INVEST to bid, for example 25."); return; }
    await run(async () => {
      const allowance = await getRoundInvestAllowance(wallet.address, wallet.provider);
      if (allowance < amount) {
        // One-time unlimited approval so every later bid is a single
        // transaction. INVEST has no value outside this closed system.
        const { MaxUint256 } = await import("ethers");
        await approveInvestForRound(wallet.signer, MaxUint256);
      }
      await placeRoundBid(wallet.signer, company.id, amount);
      setBidAmount("");
    }, refresh);
  };

  return (
    <div style={{ background: "rgba(237,230,214,0.05)", border: "1px solid rgba(237,230,214,0.15)", borderRadius: 6, padding: 18, marginBottom: 14 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <div className="zilla" style={{ fontWeight: 700, fontSize: 15 }}>{company.name}</div>
        <div className="mono" style={{ fontSize: 10, opacity: 0.5 }}>ID {company.id} · ROUND {company.currentRound.toString()}</div>
      </div>

      <div className="mono" style={{ fontSize: 11, opacity: 0.65, marginBottom: 8 }}>
        {company.finalized
          ? `Sold out: all ${company.totalShares.toLocaleString()} shares issued`
          : `${company.sharesIssued.toLocaleString()} of ${company.totalShares.toLocaleString()} shares issued · ${sharesRemaining.toLocaleString()} left`}
        {rules && !company.finalized && ` · up to ${rules.maxSharesPerRound.toString()} sold per round`}
      </div>

      {!company.finalized && (
        <>
          <div className="flex items-center gap-1 mono" style={{ fontSize: 11, opacity: 0.75, marginBottom: 10 }}>
            <Clock size={11} />
            {closed ? "Round closed: settle it to issue shares and open the next round" : `This round closes in ${label}`}
          </div>

          {bids === null ? (
            <Muted>Loading bids…</Muted>
          ) : (
            <div className="mono" style={{ fontSize: 11, opacity: 0.8, marginBottom: 10, lineHeight: 1.6 }}>
              {bids.length}{rules ? ` of ${rules.maxActiveBids.toString()}` : ""} active bids
              {lowest !== null && ` · lowest ${fmt(lowest)} INVEST (= 1 share)`}
              {myBid && (
                <div style={{ color: C.accent }}>
                  Your bid: {fmt(myBid.amount)} INVEST. If settled now it's worth {((myBid.amount + lowest - 1n) / lowest).toLocaleString()} share
                  {(myBid.amount + lowest - 1n) / lowest === 1n ? "" : "s"}. It carries into each round until it wins.
                </div>
              )}
            </div>
          )}

          {!closed && bids && !myBid && (full ? (
            <Muted style={{ marginBottom: 8 }}>This company has the maximum {rules.maxActiveBids.toString()} active bids. Bidding reopens after the next settlement.</Muted>
          ) : (
            <div className="flex gap-2" style={{ marginBottom: 6 }}>
              <Input type="number" min="1" value={bidAmount} onChange={(e) => setBidAmount(e.target.value)} placeholder="INVEST to bid (min. 1)" style={{ flex: 1 }} />
              <Button busy={busy} onClick={handleBid}>Bid</Button>
            </div>
          ))}
          {!closed && bids && !myBid && !full && (
            <Muted style={{ fontSize: 10.5, marginBottom: 6 }}>
              One active bid per wallet. The lowest bid sets the price of one share; a bid of 3× the lowest gets 3 shares.
            </Muted>
          )}

          {closed && (
            <Button kind="light" busy={busy} onClick={() => run(() => settleRoundReal(wallet.signer, company.id), refresh)}>Settle this round</Button>
          )}
        </>
      )}

      <ErrorLine error={error} />

      <CompanyGovernance company={company} wallet={wallet} />
      <CompanyTreasury company={company} companies={companies} wallet={wallet} onChanged={onChanged} />
    </div>
  );
}

export default function RealRoundAuctions({ wallet }) {
  const [companies, setCompanies] = useState(null);
  const [rules, setRules] = useState(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, r] = await Promise.all([getListedRoundCompanies(wallet.provider), getRoundAuctionRules(wallet.provider)]);
      setCompanies(list);
      setRules(r);
    } catch (err) {
      setLoadError(err.message || "Couldn't load the company list.");
    }
  }, [wallet.provider]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ marginTop: 32 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
        <RefreshCw size={15} />
        <div className="zilla" style={{ fontSize: 16, fontWeight: 700 }}>Round Auctions</div>
      </div>
      <div className="mono" style={{ fontSize: 10.5, opacity: 0.5, marginBottom: 14, lineHeight: 1.5 }}>
        Shares are sold in rounds, in proportion to what each bidder commits. Bids that don't win carry
        forward into the next round automatically. Once half a company's shares are issued, its
        shareholders elect a governor and govern its treasury.
      </div>

      {loadError && <ErrorLine error={loadError} />}

      {companies === null ? (
        !loadError && <Muted>Reading listed companies from chain…</Muted>
      ) : companies.length === 0 ? (
        <Muted>No companies listed yet on this contract.</Muted>
      ) : (
        companies.map((c) => <RoundCompanyCard key={c.id} company={c} companies={companies} wallet={wallet} rules={rules} onChanged={load} />)
      )}

      {companies && <InvestMarket wallet={wallet} companies={companies} />}
    </div>
  );
}
