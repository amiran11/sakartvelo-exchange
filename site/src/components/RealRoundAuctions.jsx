import { useState, useEffect, useCallback } from "react";
import { Loader2, TrendingUp, Clock, RefreshCw } from "lucide-react";
import {
  getListedRoundCompanies,
  getRoundBids,
  getRoundInvestAllowance,
  approveInvestForRound,
  placeRoundBid,
  settleRoundReal,
} from "../web3.js";

function fmtInvest(raw) {
  return (raw / 10n ** 18n).toLocaleString();
}

function useCountdown(endSeconds) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Number(endSeconds) - now);
  const closed = remaining <= 0;
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return { closed, label: `${h}h ${m}m ${s}s` };
}

function RoundCompanyCard({ company, wallet, onChanged }) {
  const [bids, setBids] = useState(null);
  const [bidAmount, setBidAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { closed, label } = useCountdown(company.roundEnd);

  const loadBids = useCallback(async () => {
    const b = await getRoundBids(company.id, wallet.provider);
    setBids(b);
  }, [company.id, wallet.provider]);

  useEffect(() => {
    loadBids();
  }, [loadBids]);

  const activeBids = bids?.filter((b) => b.active) || [];
  const myActiveBid = activeBids.find((b) => b.bidder.toLowerCase() === wallet.address.toLowerCase());
  const sharesRemaining = company.totalShares - company.sharesIssued;

  const handleBid = async () => {
    setError("");
    let amountRaw;
    try {
      const { parseUnits } = await import("ethers");
      amountRaw = parseUnits(bidAmount, 18);
      if (amountRaw <= 0n) throw new Error();
    } catch {
      setError("Enter a valid amount of INVEST to bid.");
      return;
    }
    setBusy(true);
    try {
      const allowance = await getRoundInvestAllowance(wallet.address, wallet.provider);
      if (allowance < amountRaw) {
        await approveInvestForRound(wallet.signer, amountRaw);
      }
      await placeRoundBid(wallet.signer, company.id, amountRaw);
      setBidAmount("");
      await loadBids();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.shortMessage || err.message || "Bid failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleSettle = async () => {
    setError("");
    setBusy(true);
    try {
      await settleRoundReal(wallet.signer, company.id);
      await loadBids();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.shortMessage || err.message || "Settle failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: "rgba(237,230,214,0.05)", border: "1px solid rgba(237,230,214,0.15)", borderRadius: 6, padding: 18, marginBottom: 14 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <div className="zilla" style={{ fontWeight: 700, fontSize: 15 }}>{company.name}</div>
        <div className="mono" style={{ fontSize: 10, opacity: 0.5 }}>ID {company.id} — ROUND {company.currentRound.toString()}</div>
      </div>

      <div className="mono" style={{ fontSize: 11, opacity: 0.6, marginBottom: 10 }}>
        {company.finalized
          ? `Sold out — ${company.sharesIssued.toString()}/${company.totalShares.toString()} shares issued`
          : `${sharesRemaining.toString()} of ${company.totalShares.toString()} shares remaining`}
      </div>

      {!company.finalized && (
        <div className="flex items-center gap-1 mono" style={{ fontSize: 11, opacity: 0.7, marginBottom: 12 }}>
          <Clock size={11} />
          {closed ? "Round closed — awaiting settlement" : `This round closes in ${label}`}
        </div>
      )}

      {bids === null ? (
        <div className="mono" style={{ fontSize: 11, opacity: 0.5 }}>Loading bid history…</div>
      ) : !company.finalized ? (
        <div className="mono" style={{ fontSize: 11, opacity: 0.7, marginBottom: 12 }}>
          {activeBids.length} active bid{activeBids.length === 1 ? "" : "s"} carrying into this round
          {myActiveBid && (
            <span style={{ color: "#C98A3E" }}> — your {fmtInvest(myActiveBid.amount)} INVEST bid is still active</span>
          )}
        </div>
      ) : null}

      {!company.finalized && !closed && !myActiveBid && (
        <div className="flex gap-2" style={{ marginBottom: 8 }}>
          <input
            type="number"
            value={bidAmount}
            onChange={(e) => setBidAmount(e.target.value)}
            placeholder="Amount of INVEST (min. 1)"
            className="mono"
            style={{ flex: 1, background: "rgba(237,230,214,0.08)", border: "1px solid rgba(237,230,214,0.2)", borderRadius: 3, padding: "8px 10px", color: "#EDE6D6", fontSize: 12 }}
          />
          <button
            onClick={handleBid}
            disabled={busy}
            className="mono flex items-center gap-1"
            style={{ background: "#C98A3E", color: "#141B18", border: "none", padding: "8px 16px", borderRadius: 3, fontWeight: 700, cursor: "pointer", fontSize: 12 }}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {busy ? "..." : "BID"}
          </button>
        </div>
      )}

      {!company.finalized && !closed && myActiveBid && (
        <div className="mono" style={{ fontSize: 11, opacity: 0.5, marginBottom: 8 }}>
          You already have an active bid this cycle — it carries forward automatically until it wins or the company sells out.
        </div>
      )}

      {!company.finalized && closed && (
        <button
          onClick={handleSettle}
          disabled={busy}
          className="mono flex items-center gap-2"
          style={{ background: "#EDE6D6", color: "#1C1A16", border: "none", padding: "8px 18px", borderRadius: 3, fontWeight: 700, cursor: "pointer", fontSize: 12 }}
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {busy ? "SETTLING..." : "SETTLE THIS ROUND"}
        </button>
      )}

      {error && <div className="mono" style={{ fontSize: 11, color: "#C97D6F", marginTop: 8 }}>{error}</div>}
    </div>
  );
}

export default function RealRoundAuctions({ wallet }) {
  const [companies, setCompanies] = useState(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await getListedRoundCompanies(wallet.provider);
      setCompanies(list);
    } catch (err) {
      setLoadError(err.message || "Couldn't load company list.");
    }
  }, [wallet.provider]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div style={{ marginTop: 32 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
        <RefreshCw size={15} />
        <div className="zilla" style={{ fontSize: 16, fontWeight: 700 }}>Round Auctions</div>
      </div>
      <div className="mono" style={{ fontSize: 10.5, opacity: 0.5, marginBottom: 14, lineHeight: 1.5 }}>
        A second auction mechanic — proportional to commitment, not winner-take-all. Losing bids carry
        forward automatically into the next round rather than needing to be replaced.
      </div>

      {loadError && <div className="mono" style={{ fontSize: 12, color: "#C97D6F" }}>{loadError}</div>}

      {companies === null ? (
        <div className="mono" style={{ fontSize: 12, opacity: 0.5 }}>Reading listed companies from chain…</div>
      ) : companies.length === 0 ? (
        <div className="mono" style={{ fontSize: 12, opacity: 0.5, lineHeight: 1.6 }}>
          No companies listed yet on this contract.
        </div>
      ) : (
        companies.map((c) => (
          <RoundCompanyCard key={c.id} company={c} wallet={wallet} onChanged={load} />
        ))
      )}
    </div>
  );
}
