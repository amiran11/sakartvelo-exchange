import { useState, useEffect, useCallback } from "react";
import { Loader2, TrendingUp, Clock } from "lucide-react";
import {
  getListedCompanies,
  getCompanyBids,
  getInvestAllowance,
  approveInvest,
  placeBidReal,
  finalizeAuctionReal,
} from "../web3.js";

function fmtInvest(raw) {
  // INVEST uses 18 decimals, same as ETH — raw is a BigInt from the contract.
  const whole = raw / 10n ** 18n;
  return whole.toLocaleString();
}

function useCountdown(auctionEndSeconds) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Number(auctionEndSeconds) - now);
  const closed = remaining <= 0;
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return { closed, label: `${h}h ${m}m ${s}s` };
}

function CompanyAuctionCard({ company, wallet, onChanged }) {
  const [bids, setBids] = useState(null);
  const [bidAmount, setBidAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { closed, label } = useCountdown(company.auctionEnd);

  const loadBids = useCallback(async () => {
    const b = await getCompanyBids(company.id, wallet.provider);
    setBids(b);
  }, [company.id, wallet.provider]);

  useEffect(() => {
    loadBids();
  }, [loadBids]);

  const highestBid = bids && bids.length > 0 ? bids[0].amount : 0n;

  const handleBid = async () => {
    setError("");
    let amountRaw;
    try {
      const { parseUnits } = await import("ethers");
      amountRaw = parseUnits(bidAmount, 18); // string-based parsing — avoids
      // float precision loss that Number(bidAmount) * 1e18 would have for
      // non-trivial decimal amounts (JS floats aren't safe at 1e18 scale).
      if (amountRaw <= 0n) throw new Error();
    } catch {
      setError("Enter a valid amount of INVEST to bid.");
      return;
    }
    setBusy(true);
    try {
      // A real allowance check first — placeBid() does transferFrom()
      // under the hood, which reverts without a sufficient approve().
      const allowance = await getInvestAllowance(wallet.address, wallet.provider);
      if (allowance < amountRaw) {
        await approveInvest(wallet.signer, amountRaw);
      }
      await placeBidReal(wallet.signer, company.id, amountRaw);
      setBidAmount("");
      await loadBids();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.shortMessage || err.message || "Bid failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleFinalize = async () => {
    setError("");
    setBusy(true);
    try {
      await finalizeAuctionReal(wallet.signer, company.id);
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.shortMessage || err.message || "Finalize failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ background: "rgba(237,230,214,0.05)", border: "1px solid rgba(237,230,214,0.15)", borderRadius: 6, padding: 18, marginBottom: 14 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <div className="zilla" style={{ fontWeight: 700, fontSize: 15 }}>{company.name}</div>
        <div className="mono" style={{ fontSize: 10, opacity: 0.5 }}>ID {company.id}</div>
      </div>

      <div className="mono" style={{ fontSize: 11, opacity: 0.6, marginBottom: 10 }}>
        {company.finalized
          ? `Finalized — ${company.sharesIssued.toString()}/${company.totalShares.toString()} shares issued, ${fmtInvest(company.capital)} INVEST capitalized`
          : `${company.totalShares.toString()} shares up for auction`}
      </div>

      {!company.finalized && (
        <div className="flex items-center gap-1 mono" style={{ fontSize: 11, opacity: 0.7, marginBottom: 12 }}>
          <Clock size={11} />
          {closed ? "Auction window closed — awaiting finalize" : `Closes in ${label}`}
        </div>
      )}

      {bids === null ? (
        <div className="mono" style={{ fontSize: 11, opacity: 0.5 }}>Loading bid history…</div>
      ) : !company.finalized ? (
        <div className="mono" style={{ fontSize: 11, opacity: 0.7, marginBottom: 12 }}>
          {bids.length} bid{bids.length === 1 ? "" : "s"} so far
          {bids.length > 0 && ` — current highest: ${fmtInvest(highestBid)} INVEST`}
        </div>
      ) : null}

      {!company.finalized && !closed && (
        <div className="flex gap-2" style={{ marginBottom: 8 }}>
          <input
            type="number"
            value={bidAmount}
            onChange={(e) => setBidAmount(e.target.value)}
            placeholder="Amount of INVEST"
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

      {!company.finalized && closed && (
        <button
          onClick={handleFinalize}
          disabled={busy}
          className="mono flex items-center gap-2"
          style={{ background: "#EDE6D6", color: "#1C1A16", border: "none", padding: "8px 18px", borderRadius: 3, fontWeight: 700, cursor: "pointer", fontSize: 12 }}
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {busy ? "FINALIZING..." : "FINALIZE THIS AUCTION"}
        </button>
      )}

      {error && <div className="mono" style={{ fontSize: 11, color: "#C97D6F", marginTop: 8 }}>{error}</div>}
    </div>
  );
}

export default function RealAuctions({ wallet }) {
  const [companies, setCompanies] = useState(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await getListedCompanies(wallet.provider);
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
      <div className="flex items-center gap-2" style={{ marginBottom: 14 }}>
        <TrendingUp size={15} />
        <div className="zilla" style={{ fontSize: 16, fontWeight: 700 }}>Live Auctions</div>
      </div>

      {loadError && <div className="mono" style={{ fontSize: 12, color: "#C97D6F" }}>{loadError}</div>}

      {companies === null ? (
        <div className="mono" style={{ fontSize: 12, opacity: 0.5 }}>Reading listed companies from chain…</div>
      ) : companies.length === 0 ? (
        <div className="mono" style={{ fontSize: 12, opacity: 0.5, lineHeight: 1.6 }}>
          No companies listed yet on this contract. The owner lists companies via listCompany() —
          check back once at least one is live.
        </div>
      ) : (
        companies.map((c) => (
          <CompanyAuctionCard key={c.id} company={c} wallet={wallet} onChanged={load} />
        ))
      )}
    </div>
  );
}
