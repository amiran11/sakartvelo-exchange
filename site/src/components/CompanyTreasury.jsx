import { useState, useEffect, useCallback } from "react";
import { Vault, ChevronDown, ChevronRight, Copy } from "lucide-react";
import {
  CONTRACT_ADDRESSES,
  getCompanyGovernance,
  getCompanyTreasury,
  getTokenInfo,
  normalizeAddress,
  parseAmount,
  depositTokenReal,
  getFreeAllowanceLeft,
  withdrawTokenReal,
  getTreasuryAuctions,
  openTreasuryAuctionReal,
  commitTreasuryBidReal,
  revealTreasuryBidReal,
  settleTreasuryAuctionReal,
  claimTreasuryAuctionReal,
  getSavedBid,
  makeRevealCode,
  parseRevealCode,
  getVendorPayments,
  proposeVendorPaymentReal,
  voteVendorPaymentReal,
  executeVendorPaymentReal,
  getDividendTerms,
  openPolicyVoteReal,
  votePolicyReal,
  resolvePolicyVoteReal,
  claimDividendReal,
  claimDividendAsCorporationReal,
  getCorporateHoldings,
  investReal,
  voteAsCorporationReal,
  getApprovedPaymentTokens,
  governorOfferInvestReal,
} from "../web3.js";
import { C, ZERO, short, same, fmt, fmtDate, useCountdown, useTx, count } from "./liveUtils.js";
import { Button, Input, Select, Field, Notice, Muted, ErrorLine, Section, Row } from "./ui.jsx";

function Countdown({ to, prefix }) {
  const { passed, label } = useCountdown(to);
  return <span>{passed ? "ended" : `${prefix} ${label}`}</span>;
}

function Tabs({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 flex-wrap" style={{ marginBottom: 12 }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className="mono"
          style={{
            background: active === t.id ? "rgba(201,138,62,0.18)" : "transparent",
            border: `1px solid ${active === t.id ? C.accent : "rgba(237,230,214,0.18)"}`,
            color: active === t.id ? C.accent : C.text, borderRadius: 3, padding: "4px 10px", fontSize: 10.5, cursor: "pointer",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Card({ children, dim }) {
  return <div style={{ border: "1px solid rgba(237,230,214,0.15)", borderRadius: 4, padding: 12, marginBottom: 8, opacity: dim ? 0.6 : 1 }}>{children}</div>;
}

function Title({ children }) {
  return <div className="mono" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{children}</div>;
}

// Picks one of the company's tokens, or (when allowCustom) any address.
function TokenPicker({ tokens, value, onChange, allowCustom }) {
  const [custom, setCustom] = useState("");
  const isCustom = value === "custom";
  return (
    <>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a token…</option>
        {tokens.map((t) => <option key={t.address} value={t.address}>{t.symbol}{t.balance !== undefined ? ` (company holds ${fmt(t.balance, t.decimals)})` : ""}</option>)}
        {allowCustom && <option value="custom">Another token (paste its address)</option>}
      </Select>
      {isCustom && (
        <Input style={{ marginTop: 6 }} value={custom} placeholder="0x… token contract address"
          onChange={(e) => { setCustom(e.target.value); onChange("custom", e.target.value); }} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Overview

function Overview({ company, wallet, data, reload }) {
  const [tokenSel, setTokenSel] = useState("");
  const [customAddr, setCustomAddr] = useState("");
  const [amount, setAmount] = useState("");
  const { busy, error, setError, run } = useTx();
  const known = [...data.tokens, ...data.payTokens.filter((p) => !data.tokens.some((t) => same(t.address, p.address)))];

  const deposit = async () => {
    const addrText = tokenSel === "custom" ? customAddr : tokenSel;
    const addr = await normalizeAddress(addrText || "");
    if (!addr) return setError("Choose a token, or paste a valid token address.");
    if (same(addr, CONTRACT_ADDRESSES.InvestToken)) return setError("INVEST goes to companies through bidding, not deposits.");
    let info, raw;
    try { info = await getTokenInfo(addr, wallet.provider); raw = await parseAmount(amount, info.decimals); }
    catch { return setError("Enter a valid amount."); }
    await run(() => depositTokenReal(wallet.signer, company.id, addr, raw), async () => { setAmount(""); await reload(); });
  };

  return (
    <div>
      <Row label="INVEST capital (from the sale of shares)">{fmt(data.capital)} INVEST</Row>
      <Row label="Reinvestable income (from asset sales and dividends)">{fmt(data.reinvestableIncome)} INVEST</Row>
      {data.tokens.length === 0 ? (
        <Muted style={{ margin: "6px 0 12px" }}>The treasury holds no other tokens yet.</Muted>
      ) : (
        data.tokens.map((t) => <Row key={t.address} label={t.symbol}>{fmt(t.balance, t.decimals, 4)}</Row>)
      )}
      <Muted style={{ margin: "8px 0 12px" }}>
        The governor can move up to 5% of each token per term on their own. Anything more goes through a sealed-bid auction
        or a payment that shareholders approve.
      </Muted>

      <Title>Add tokens to this treasury</Title>
      <Field label="Token">
        <TokenPicker tokens={known} value={tokenSel} allowCustom onChange={(v, custom) => { setTokenSel(v); if (custom !== undefined) setCustomAddr(custom); }} />
      </Field>
      <Field label="Amount"><Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Muted style={{ marginBottom: 8 }}>Anyone can add tokens. A deposit is a gift to the company and can't be taken back.</Muted>
      <Button busy={busy} onClick={deposit}>Deposit</Button>
      <ErrorLine error={error} />
    </div>
  );
}

// ---------------------------------------------------------------- Auctions

function AuctionCard({ a, wallet, reload }) {
  const { busy, error, setError, run } = useTx();
  const [bid, setBid] = useState("");
  const [code, setCode] = useState("");
  const [newCode, setNewCode] = useState(null);
  const commitOver = useCountdown(a.commitEnd).passed; // re-renders as deadlines pass
  const revealOver = useCountdown(a.revealEnd).passed;
  const phase = !commitOver ? "commit" : !revealOver ? "reveal" : a.settled ? "done" : "settle";
  const saved = getSavedBid(a.id, wallet.address);
  const iWon = a.settled && same(a.leader, wallet.address);

  const commit = async () => {
    let raw;
    try { raw = await parseAmount(bid, 18); } catch { return setError("Enter your bid in INVEST."); }
    await run(() => commitTreasuryBidReal(wallet.signer, a.id, raw, a.deposit), async (revealCode) => { setNewCode(revealCode); setBid(""); await reload(); });
  };
  const reveal = async () => {
    const p = saved ? { amount: BigInt(saved.amount), salt: saved.salt } : parseRevealCode(code);
    if (!p) return setError("That reveal code isn't valid. It looks like 25000000000000000000-0x…");
    await run(() => revealTreasuryBidReal(wallet.signer, a.id, p.amount, p.salt), reload);
  };
  const copy = (text) => { try { navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ } };

  return (
    <Card dim={phase === "done" && !a.mine.revealed}>
      <Title>Selling {fmt(a.amount, a.token.decimals, 4)} {a.token.symbol}</Title>
      <div className="mono" style={{ fontSize: 10.5, opacity: 0.6, marginBottom: 8 }}>
        Auction #{a.id.toString()} · {a.committed.toString()} sealed bid{a.committed === 1n ? "" : "s"}
        {phase !== "commit" && ` · ${a.revealed.toString()} revealed`}
        {" · "}
        {phase === "commit" && <Countdown to={a.commitEnd} prefix="bidding closes in" />}
        {phase === "reveal" && <Countdown to={a.revealEnd} prefix="reveals close in" />}
        {phase === "settle" && "waiting to be settled"}
        {phase === "done" && (a.leader === ZERO ? "no valid bids, tokens returned to the company" : `won by ${same(a.leader, wallet.address) ? "you" : short(a.leader)} for ${fmt(a.leadingAmount)} INVEST`)}
      </div>

      {newCode && (
        <Notice>
          <b>Save your reveal code.</b> You'll need it after bidding closes to reveal your bid. It's saved in this browser too, but if you
          switch device or clear your browser without it, you can't reveal and you lose the {fmt(a.deposit)} INVEST deposit.
          <div className="flex gap-2 items-center" style={{ marginTop: 6 }}>
            <code style={{ wordBreak: "break-all", fontSize: 10 }}>{newCode}</code>
            <Button small kind="outline" onClick={() => copy(newCode)}><Copy size={10} /> Copy</Button>
          </div>
        </Notice>
      )}

      {phase === "commit" && !a.mine.committed && (
        <>
          <div className="flex gap-2">
            <Input type="number" min="0" value={bid} onChange={(e) => setBid(e.target.value)} placeholder="Your bid in INVEST" style={{ flex: 1 }} />
            <Button busy={busy} onClick={commit}>Place sealed bid</Button>
          </div>
          <Muted style={{ marginTop: 6 }}>
            Nobody sees your amount until you reveal it. Placing the bid locks a {fmt(a.deposit)} INVEST deposit, returned when you reveal.
            Your bid amount is only paid when you reveal, and refunded if you don't win.
          </Muted>
        </>
      )}
      {phase === "commit" && a.mine.committed && !newCode && (
        <Muted>
          You've placed a sealed bid. Come back after bidding closes to reveal it.
          {saved && <> Reveal code (keep a copy): <code style={{ wordBreak: "break-all", fontSize: 10 }}>{makeRevealCode(BigInt(saved.amount), saved.salt)}</code></>}
        </Muted>
      )}

      {phase === "reveal" && a.mine.committed && !a.mine.revealed && (
        saved ? (
          <>
            <Button busy={busy} onClick={reveal}>Reveal my bid of {fmt(BigInt(saved.amount))} INVEST</Button>
            <Muted style={{ marginTop: 6 }}>Revealing pays your bid now. If you don't win, claim it back after the auction is settled.</Muted>
          </>
        ) : (
          <>
            <Muted style={{ marginBottom: 6 }}>This browser doesn't have your bid saved. Paste the reveal code you copied when you bid.</Muted>
            <div className="flex gap-2">
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Reveal code" style={{ flex: 1 }} />
              <Button busy={busy} onClick={reveal}>Reveal</Button>
            </div>
          </>
        )
      )}
      {phase === "reveal" && a.mine.revealed && <Muted>Your bid of {fmt(a.mine.revealedAmount)} INVEST is revealed.</Muted>}

      {phase === "settle" && (
        <>
          <Button kind="light" busy={busy} onClick={() => run(() => settleTreasuryAuctionReal(wallet.signer, a.id), reload)}>Settle auction</Button>
          <Muted style={{ marginTop: 6 }}>Anyone can settle. The highest revealed bid wins; then each bidder claims their tokens or refund.</Muted>
        </>
      )}

      {phase === "done" && a.mine.revealed && !a.mine.claimed && (
        <Button busy={busy} onClick={() => run(() => claimTreasuryAuctionReal(wallet.signer, a.id), reload)}>
          {iWon ? `Claim ${fmt(a.amount, a.token.decimals, 4)} ${a.token.symbol} and your deposit` : `Claim back ${fmt(a.deposit + a.mine.revealedAmount)} INVEST`}
        </Button>
      )}
      {phase === "done" && a.mine.claimed && <Muted>Claimed.</Muted>}
      {(phase === "done" || phase === "settle") && a.mine.committed && !a.mine.revealed && (
        <Muted>Your bid wasn't revealed in time, so its {fmt(a.deposit)} INVEST deposit went to the company.</Muted>
      )}
      <ErrorLine error={error} />
    </Card>
  );
}

function Auctions({ company, wallet }) {
  const [list, setList] = useState(null);
  const load = useCallback(async () => setList(await getTreasuryAuctions(company.id, wallet.address, wallet.provider)), [company.id, wallet]);
  useEffect(() => { load(); }, [load]);
  if (!list) return <Muted>Loading auctions…</Muted>;
  return (
    <div>
      <Muted style={{ marginBottom: 10 }}>
        When the governor sells more than 5% of a token, it's sold here by sealed bids: 2 days to bid, then 1 day to reveal.
        What the company earns becomes income it can reinvest.
      </Muted>
      {list.length === 0 ? <Muted>No auctions yet.</Muted> : list.map((a) => <AuctionCard key={a.id.toString()} a={a} wallet={wallet} reload={load} />)}
    </div>
  );
}

// ---------------------------------------------------------------- Payments

function PaymentCard({ p, wallet, reload }) {
  const { busy, error, run } = useTx();
  const open = !useCountdown(p.voteEnd).passed;
  const turnout = p.yesWeight + p.noWeight;
  return (
    <Card dim={p.executed}>
      <Title>Pay {fmt(p.amount, p.token.decimals, 4)} {p.token.symbol} to {short(p.to)}</Title>
      <div className="mono" style={{ fontSize: 10.5, opacity: 0.65, marginBottom: 8, lineHeight: 1.6 }}>
        Payment #{p.id.toString()} · {p.executed ? (p.passes ? "approved and paid" : "rejected, funds returned to the company") : open ? <Countdown to={p.voteEnd} prefix="voting closes in" /> : "voting closed, waiting to be carried out"}
        <br />
        Yes {p.yesWeight.toLocaleString()} · No {p.noWeight.toLocaleString()} · turnout {turnout.toLocaleString()} of the {p.quorumNeeded.toLocaleString()} shares needed (20% of {p.issued.toLocaleString()})
        {!p.executed && <> · <span style={{ color: p.passes ? C.ok : C.danger }}>{p.passes ? "would pass now" : "would fail now"}</span></>}
      </div>
      {open && !p.voted && p.myWeight > 0n && (
        <div className="flex gap-2">
          <Button small busy={busy} onClick={() => run(() => voteVendorPaymentReal(wallet.signer, p.id, true), reload)}>Approve ({count(p.myWeight, "share")})</Button>
          <Button small kind="quiet" busy={busy} onClick={() => run(() => voteVendorPaymentReal(wallet.signer, p.id, false), reload)}>Reject</Button>
        </div>
      )}
      {open && p.voted && <Muted>You've voted on this payment.</Muted>}
      {open && !p.voted && p.myWeight === 0n && <Muted>Only wallets that held shares when this was proposed can vote.</Muted>}
      {!open && !p.executed && (
        <Button kind="light" busy={busy} onClick={() => run(() => executeVendorPaymentReal(wallet.signer, p.id), reload)}>
          {p.passes ? "Carry out the payment" : "Close and return the funds"}
        </Button>
      )}
      <ErrorLine error={error} />
    </Card>
  );
}

function Payments({ company, wallet }) {
  const [list, setList] = useState(null);
  const load = useCallback(async () => setList(await getVendorPayments(company.id, wallet.address, wallet.provider)), [company.id, wallet]);
  useEffect(() => { load(); }, [load]);
  if (!list) return <Muted>Loading payments…</Muted>;
  return (
    <div>
      <Muted style={{ marginBottom: 10 }}>
        Payments the governor proposes to a named address. Shareholders have 3 days to vote. A payment goes through only if at least
        20% of shares vote and 51% of the votes say yes. Otherwise the money goes back to the company.
      </Muted>
      {list.length === 0 ? <Muted>No payments proposed yet.</Muted> : list.map((p) => <PaymentCard key={p.id.toString()} p={p} wallet={wallet} reload={load} />)}
    </div>
  );
}

// ---------------------------------------------------------------- Dividends

function TermCard({ company, t, wallet, reload }) {
  const { busy, error, run } = useTx();
  const voteOver = useCountdown(t.voteEnd).passed;
  const voting = t.voteEnd > 0n && !voteOver;
  const awaitingResolve = t.voteEnd > 0n && !voting && !t.resolved;
  const total = t.dividendWeight + t.reinvestWeight;
  return (
    <Card>
      <Title>Term {t.term} · ended {fmtDate(t.endTime)}</Title>
      {t.voteEnd === 0n && (
        <>
          <Muted style={{ marginBottom: 8 }}>Shareholders decide: pay 1% of the company's capital out as a dividend, or keep it invested. Anyone can open the vote.</Muted>
          <Button kind="light" busy={busy} onClick={() => run(() => openPolicyVoteReal(wallet.signer, company.id, t.term), reload)}>Open the dividend vote</Button>
        </>
      )}
      {(voting || awaitingResolve) && (
        <div className="mono" style={{ fontSize: 10.5, opacity: 0.7, marginBottom: 8 }}>
          Pay a dividend: {t.dividendWeight.toLocaleString()} · Reinvest: {t.reinvestWeight.toLocaleString()} ({count(total, "share")} voted)
          {" · "}{voting ? <Countdown to={t.voteEnd} prefix="closes in" /> : "voting closed"}
        </div>
      )}
      {voting && !t.hasVoted && t.myWeight > 0n && (
        <div className="flex gap-2">
          <Button small busy={busy} onClick={() => run(() => votePolicyReal(wallet.signer, company.id, t.term, true), reload)}>Pay a dividend</Button>
          <Button small kind="quiet" busy={busy} onClick={() => run(() => votePolicyReal(wallet.signer, company.id, t.term, false), reload)}>Reinvest</Button>
          <span className="mono" style={{ fontSize: 10.5, opacity: 0.6, alignSelf: "center" }}>{count(t.myWeight, "share")}</span>
        </div>
      )}
      {voting && t.hasVoted && <Muted>You've voted.</Muted>}
      {voting && !t.hasVoted && t.myWeight === 0n && <Muted>Only wallets that held shares when the term ended can vote.</Muted>}
      {awaitingResolve && <Button kind="light" busy={busy} onClick={() => run(() => resolvePolicyVoteReal(wallet.signer, company.id, t.term), reload)}>Count the vote</Button>}
      {t.resolved && (t.perShare > 0n ? (
        <div className="mono" style={{ fontSize: 11 }}>
          <div style={{ marginBottom: 6 }}>Dividend: {fmt(t.perShare / 10n ** 18n, 18, 6)} INVEST per share, paid on shares held when the term ended.</div>
          {t.owed > 0n && <Button busy={busy} onClick={() => run(() => claimDividendReal(wallet.signer, company.id, t.term), reload)}>Claim {fmt(t.owed, 18, 4)} INVEST</Button>}
          {t.claimed && <Muted>You've claimed your dividend.</Muted>}
          {!t.claimed && t.owed === 0n && <Muted>Nothing to claim for this wallet.</Muted>}
        </div>
      ) : (
        <Muted>Shareholders chose to reinvest. No dividend this term.</Muted>
      ))}
      <ErrorLine error={error} />
    </Card>
  );
}

function Dividends({ company, wallet }) {
  const [terms, setTerms] = useState(null);
  const load = useCallback(async () => setTerms(await getDividendTerms(company.id, wallet.address, wallet.provider)), [company.id, wallet]);
  useEffect(() => { load(); }, [load]);
  if (!terms) return <Muted>Loading dividends…</Muted>;
  return (
    <div>
      <Muted style={{ marginBottom: 10 }}>
        After each governor's term, shareholders vote on a dividend of 1% of capital. Votes and payouts use the shares each wallet held
        when the term ended, so shares moved afterwards don't change anything.
      </Muted>
      {terms.length === 0 ? <Muted>No term has ended yet.</Muted> : terms.map((t) => <TermCard key={t.term} company={company} t={t} wallet={wallet} reload={load} />)}
    </div>
  );
}

// ---------------------------------------------------------------- Governor tools

function TokenAmountForm({ data, title, explain, needTo, submitLabel, onSubmit, extra }) {
  const [token, setToken] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const { busy, error, setError, run } = useTx();
  const submit = async () => {
    const info = data.tokens.find((t) => same(t.address, token));
    if (!info) return setError("Choose a token the company holds.");
    let toAddr = null;
    if (needTo) { toAddr = await normalizeAddress(to); if (!toAddr) return setError("Enter a valid recipient address."); }
    let raw;
    try { raw = await parseAmount(amount, info.decimals); } catch { return setError("Enter a valid amount."); }
    await run(() => onSubmit(info.address, raw, toAddr), () => { setAmount(""); setTo(""); });
  };
  return (
    <Card>
      <Title>{title}</Title>
      <Muted style={{ marginBottom: 8 }}>{explain}</Muted>
      {data.tokens.length === 0 ? <Muted>The company holds no tokens to use for this.</Muted> : (
        <>
          <Field label="Token"><TokenPicker tokens={data.tokens} value={token} onChange={(v) => setToken(v)} /></Field>
          {extra && extra(token)}
          {needTo && <Field label="Recipient address"><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" /></Field>}
          <Field label="Amount"><Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Button busy={busy} onClick={submit}>{submitLabel}</Button>
        </>
      )}
      <ErrorLine error={error} />
    </Card>
  );
}

function FreeAllowance({ companyId, token, wallet, data }) {
  const [left, setLeft] = useState(null);
  useEffect(() => {
    if (!token) { setLeft(null); return; }
    getFreeAllowanceLeft(companyId, token, wallet.provider).then(setLeft).catch(() => setLeft(null));
  }, [companyId, token, wallet.provider, data]); // data changes after every withdrawal
  const info = data.tokens.find((t) => same(t.address, token));
  if (!info || left === null) return null;
  return <Muted style={{ marginBottom: 8 }}>You can still withdraw {fmt(left, info.decimals, 4)} {info.symbol} on your own this term.</Muted>;
}

function GovernorTools({ company, companies, wallet, data, reload }) {
  const [holdings, setHoldings] = useState(null);
  const [payTokens, setPayTokens] = useState([]);
  const inv = useTx();
  const corp = useTx();
  const sell = useTx();
  const [target, setTarget] = useState("");
  const [investAmt, setInvestAmt] = useState("");
  const [corpTarget, setCorpTarget] = useState("");
  const [corpTerm, setCorpTerm] = useState("");
  const [corpCandidate, setCorpCandidate] = useState("");
  const [sellAmt, setSellAmt] = useState("");
  const [sellToken, setSellToken] = useState("");
  const [sellPrice, setSellPrice] = useState("");
  const others = companies.filter((c) => c.id !== company.id);

  useEffect(() => {
    getCorporateHoldings(company.id, others, wallet.provider).then(setHoldings).catch(() => setHoldings([]));
    getApprovedPaymentTokens(wallet.provider).then(setPayTokens).catch(() => setPayTokens([]));
  }, [company.id, wallet.provider, companies.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const doInvest = async () => {
    if (target === "") return inv.setError("Choose a company to invest in.");
    let raw;
    try { raw = await parseAmount(investAmt, 18); } catch { return inv.setError("Enter an amount of INVEST."); }
    await inv.run(() => investReal(wallet.signer, company.id, Number(target), raw), async () => { setInvestAmt(""); await reload(); });
  };
  const doSell = async () => {
    const tok = payTokens.find((t) => same(t.address, sellToken));
    if (!tok) return sell.setError("Choose what buyers pay with.");
    let amt, price;
    try { amt = await parseAmount(sellAmt, 18); price = await parseAmount(sellPrice, tok.decimals); } catch { return sell.setError("Enter both amounts."); }
    await sell.run(() => governorOfferInvestReal(wallet.signer, company.id, amt, tok.address, price), async () => { setSellAmt(""); setSellPrice(""); await reload(); });
  };

  return (
    <div>
      <Notice color={C.ok}>You're signed in with {company.name}'s operating key. Everything here acts for the company.</Notice>

      <TokenAmountForm data={data} needTo title="Withdraw (up to 5% per term)"
        explain="Send a token to any address. You can move at most 5% of each token's balance per term on your own."
        submitLabel="Withdraw"
        extra={(token) => <FreeAllowance companyId={company.id} token={token} wallet={wallet} data={data} />}
        onSubmit={async (token, raw, to) => { await withdrawTokenReal(wallet.signer, company.id, token, to, raw); await reload(); }} />

      <TokenAmountForm data={data} title="Sell at a sealed-bid auction"
        explain="Puts the tokens up for sealed bids: 2 days to bid, 1 day to reveal, highest bid wins. The INVEST earned becomes reinvestable income."
        submitLabel="Start auction"
        onSubmit={async (token, raw) => { await openTreasuryAuctionReal(wallet.signer, company.id, token, raw); await reload(); }} />

      <TokenAmountForm data={data} needTo title="Propose a payment"
        explain="For a bill or contract larger than 5%. The amount is set aside, shareholders vote for 3 days, and it's paid only if at least 20% of shares vote and 51% approve."
        submitLabel="Propose payment"
        onSubmit={async (token, raw, to) => { await proposeVendorPaymentReal(wallet.signer, company.id, token, to, raw); await reload(); }} />

      <Card>
        <Title>Reinvest in another company</Title>
        <Muted style={{ marginBottom: 8 }}>
          Bid the company's reinvestable income ({fmt(data.reinvestableIncome)} INVEST available) in another company's auction. Original capital
          can never be used. If the bid wins, you personally receive 1% of the shares, locked until two more terms have passed.
        </Muted>
        <Field label="Company to invest in">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            {others.filter((c) => !c.finalized).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="INVEST to bid"><Input type="number" min="1" value={investAmt} onChange={(e) => setInvestAmt(e.target.value)} /></Field>
        <Button busy={inv.busy} onClick={doInvest} disabled={data.reinvestableIncome === 0n}>Place company bid</Button>
        <ErrorLine error={inv.error} />
      </Card>

      <Card>
        <Title>Shares this company holds elsewhere</Title>
        {holdings === null ? <Muted>Loading…</Muted> : holdings.length === 0 ? <Muted>None yet. Reinvesting builds them.</Muted> : (
          <>
            {holdings.map((h) => <Row key={h.companyId} label={h.name}>{count(h.shares, "share")}</Row>)}
            <div style={{ marginTop: 10 }}>
              <Field label="Company">
                <Select value={corpTarget} onChange={(e) => setCorpTarget(e.target.value)}>
                  <option value="">Choose…</option>
                  {holdings.map((h) => <option key={h.companyId} value={h.companyId}>{h.name}</option>)}
                </Select>
              </Field>
              <div className="flex gap-2" style={{ marginBottom: 8 }}>
                <Input type="number" min="1" value={corpTerm} onChange={(e) => setCorpTerm(e.target.value)} placeholder="Term number" style={{ flex: 1 }} />
                <Button small busy={corp.busy} onClick={() => corp.run(() => claimDividendAsCorporationReal(wallet.signer, company.id, Number(corpTarget), Number(corpTerm)), reload)} disabled={corpTarget === "" || !corpTerm}>
                  Claim dividend
                </Button>
              </div>
              <div className="flex gap-2">
                <Input value={corpCandidate} onChange={(e) => setCorpCandidate(e.target.value)} placeholder="Candidate address to vote for" style={{ flex: 1 }} />
                <Button small busy={corp.busy} disabled={corpTarget === "" || !corpCandidate} onClick={async () => {
                  const cand = await normalizeAddress(corpCandidate);
                  if (!cand) return corp.setError("Enter a valid candidate address.");
                  await corp.run(() => voteAsCorporationReal(wallet.signer, company.id, Number(corpTarget), cand));
                }}>Vote these shares</Button>
              </div>
              <Muted style={{ marginTop: 6 }}>Dividends claimed this way become this company's reinvestable income.</Muted>
            </div>
          </>
        )}
        <ErrorLine error={corp.error} />
      </Card>

      <Card>
        <Title>Sell company INVEST on the market</Title>
        <Muted style={{ marginBottom: 8 }}>Offer some of the company's capital ({fmt(data.capital)} INVEST) for an accepted token. Payment goes to the company's treasury.</Muted>
        {payTokens.length === 0 ? <Muted>No payment tokens are accepted on the market yet.</Muted> : (
          <>
            <Field label="INVEST to sell"><Input type="number" min="0" value={sellAmt} onChange={(e) => setSellAmt(e.target.value)} /></Field>
            <Field label="Paid in"><TokenPicker tokens={payTokens} value={sellToken} onChange={(v) => setSellToken(v)} /></Field>
            <Field label="Total price"><Input type="number" min="0" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} /></Field>
            <Button busy={sell.busy} onClick={doSell}>Post offer</Button>
          </>
        )}
        <ErrorLine error={sell.error} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Panel

export default function CompanyTreasury({ company, companies, wallet, onChanged }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("overview");
  const [data, setData] = useState(null);
  const [gov, setGov] = useState(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      const [t, g, payTokens] = await Promise.all([
        getCompanyTreasury(company.id, wallet.provider),
        getCompanyGovernance(company.id, wallet.provider),
        getApprovedPaymentTokens(wallet.provider),
      ]);
      setData({ ...t, payTokens }); setGov(g); setLoadError("");
    } catch (err) {
      setLoadError(err.shortMessage || err.message || "Couldn't read the treasury.");
    }
  }, [company.id, wallet.provider]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const reload = async () => { await load(); if (onChanged) await onChanged(); };
  const now = Math.floor(Date.now() / 1000);
  const iAmKey = gov && gov.operatingKey !== ZERO && same(gov.operatingKey, wallet.address) && now < Number(gov.termEnd);
  const tabs = [
    { id: "overview", label: "Holdings" },
    { id: "auctions", label: "Auctions" },
    { id: "payments", label: "Payments" },
    { id: "dividends", label: "Dividends" },
    ...(iAmKey ? [{ id: "governor", label: "Governor tools" }] : []),
  ];

  const toggle = (
    <button onClick={() => setOpen(!open)} className="mono flex items-center gap-1" style={{ background: "none", border: "none", color: C.accent, fontSize: 10.5, cursor: "pointer" }}>
      {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {open ? "Hide" : "Show"}
    </button>
  );

  return (
    <Section icon={Vault} title="Treasury" right={toggle}>
      {!open ? (
        <Muted>Capital {fmt(company.capital)} INVEST. Open to see holdings, auctions, payments and dividends. Governor tools appear here when the operating key is connected.</Muted>
      ) : loadError ? (
        <ErrorLine error={loadError} />
      ) : !data ? (
        <Muted>Loading treasury…</Muted>
      ) : (
        <>
          <Tabs tabs={tabs} active={tab} onChange={setTab} />
          {tab === "overview" && <Overview company={company} wallet={wallet} data={data} reload={reload} />}
          {tab === "auctions" && <Auctions company={company} wallet={wallet} />}
          {tab === "payments" && <Payments company={company} wallet={wallet} />}
          {tab === "dividends" && <Dividends company={company} wallet={wallet} />}
          {tab === "governor" && iAmKey && <GovernorTools company={company} companies={companies} wallet={wallet} data={data} reload={reload} />}
        </>
      )}
    </Section>
  );
}

