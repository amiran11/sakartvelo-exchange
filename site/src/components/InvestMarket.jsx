import { useState, useEffect, useCallback } from "react";
import { ArrowLeftRight } from "lucide-react";
import {
  getInvestOffers,
  getApprovedPaymentTokens,
  getInvestBalance,
  getCompanyGovernance,
  offerInvestReal,
  buyInvestReal,
  cancelInvestOfferReal,
  parseAmount,
} from "../web3.js";
import { C, ZERO, short, same, fmt, useTx } from "./liveUtils.js";
import { Button, Input, Select, Field, Muted, ErrorLine } from "./ui.jsx";

// Price of one INVEST in the payment token, for comparing offers.
function unitPrice(o) {
  if (o.investAmount === 0n) return "";
  const scaled = (o.paymentAmount * 10n ** 18n) / o.investAmount; // payment-token units per 1 INVEST
  return `${fmt(scaled, o.token.decimals, 4)} ${o.token.symbol} each`;
}

function OfferRow({ o, wallet, companies, operatingKeys, reload }) {
  const { busy, error, run } = useTx();
  const company = o.isCorporateOffer ? companies.find((c) => BigInt(c.id) === o.creditCompanyId) : null;
  const mine = !o.isCorporateOffer && same(o.seller, wallet.address);
  const iRunSeller = o.isCorporateOffer && same(operatingKeys[o.creditCompanyId.toString()], wallet.address);
  return (
    <div style={{ borderBottom: "1px solid rgba(237,230,214,0.08)", padding: "8px 0" }}>
      <div className="flex items-center justify-between gap-3">
        <div className="mono" style={{ fontSize: 11.5 }}>
          <div><b>{fmt(o.investAmount)} INVEST</b> for {fmt(o.paymentAmount, o.token.decimals, 4)} {o.token.symbol}</div>
          <div style={{ opacity: 0.55, fontSize: 10.5 }}>
            {unitPrice(o)} · sold by {company ? `${company.name} (company treasury)` : mine ? "you" : short(o.seller)}
          </div>
        </div>
        {mine || iRunSeller ? (
          <Button small kind="quiet" busy={busy} onClick={() => run(() => cancelInvestOfferReal(wallet.signer, o.id), reload)}>Cancel</Button>
        ) : (
          <Button small busy={busy} onClick={() => run(() => buyInvestReal(wallet.signer, o), reload)}>Buy</Button>
        )}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export default function InvestMarket({ wallet, companies }) {
  const [offers, setOffers] = useState(null);
  const [payTokens, setPayTokens] = useState([]);
  const [balance, setBalance] = useState(null);
  const [operatingKeys, setOperatingKeys] = useState({});
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState("");
  const [price, setPrice] = useState("");
  const [loadError, setLoadError] = useState("");
  const { busy, error, setError, run } = useTx();

  const load = useCallback(async () => {
    try {
      const [o, t, b] = await Promise.all([
        getInvestOffers(wallet.provider),
        getApprovedPaymentTokens(wallet.provider),
        getInvestBalance(wallet.address, wallet.provider),
      ]);
      // Operating keys of companies with open offers, so their governor can cancel.
      const ids = [...new Set(o.filter((x) => x.isCorporateOffer).map((x) => x.creditCompanyId.toString()))];
      const keys = {};
      await Promise.all(ids.map(async (id) => {
        const g = await getCompanyGovernance(Number(id), wallet.provider);
        if (g.operatingKey !== ZERO) keys[id] = g.operatingKey;
      }));
      setOffers(o); setPayTokens(t); setBalance(b); setOperatingKeys(keys); setLoadError("");
    } catch (err) {
      setLoadError(err.shortMessage || err.message || "Couldn't load the market.");
    }
  }, [wallet.provider, wallet.address]);

  useEffect(() => { load(); }, [load]);

  const post = async () => {
    const tok = payTokens.find((t) => same(t.address, token));
    if (!tok) return setError("Choose what you want to be paid in.");
    let amt, pr;
    try { amt = await parseAmount(amount, 18); pr = await parseAmount(price, tok.decimals); } catch { return setError("Enter how much INVEST to sell and your total price."); }
    if (balance !== null && amt > balance) return setError(`You only have ${fmt(balance)} INVEST.`);
    await run(() => offerInvestReal(wallet.signer, amt, tok.address, pr), async () => { setAmount(""); setPrice(""); await load(); });
  };

  return (
    <div style={{ marginTop: 32 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
        <ArrowLeftRight size={15} />
        <div className="zilla" style={{ fontSize: 16, fontWeight: 700 }}>INVEST Market</div>
      </div>
      <div className="mono" style={{ fontSize: 10.5, opacity: 0.5, marginBottom: 14, lineHeight: 1.5 }}>
        Anyone can buy INVEST here, including people who weren't original citizens. Sellers set a total price in an accepted token;
        their INVEST is held by the treasury contract until someone buys or they cancel.
      </div>

      {loadError && <ErrorLine error={loadError} />}

      <div style={{ background: "rgba(237,230,214,0.05)", border: "1px solid rgba(237,230,214,0.15)", borderRadius: 6, padding: 18 }}>
        {offers === null ? (
          !loadError && <Muted>Loading offers…</Muted>
        ) : offers.length === 0 ? (
          <Muted style={{ marginBottom: 12 }}>No open offers.</Muted>
        ) : (
          <div style={{ marginBottom: 16 }}>
            {offers.map((o) => <OfferRow key={o.id.toString()} o={o} wallet={wallet} companies={companies} operatingKeys={operatingKeys} reload={load} />)}
          </div>
        )}

        <div className="mono" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Sell your INVEST</div>
        {payTokens.length === 0 ? (
          <Muted>The market opens once the operator approves a token to pay with.</Muted>
        ) : (
          <>
            <Muted style={{ marginBottom: 8 }}>You have {fmt(balance)} INVEST.</Muted>
            <Field label="INVEST to sell"><Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Paid in">
              <Select value={token} onChange={(e) => setToken(e.target.value)}>
                <option value="">Choose…</option>
                {payTokens.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
              </Select>
            </Field>
            <Field label="Total price"><Input type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
            <Button busy={busy} onClick={post}>Post offer</Button>
          </>
        )}
        <ErrorLine error={error} />
      </div>
      <div className="mono" style={{ fontSize: 10, opacity: 0.35, marginTop: 6, color: C.text }}>
        Fictional simulation. INVEST is not a real currency or investment.
      </div>
    </div>
  );
}
