import { useState, useEffect, useRef, useCallback } from "react";
import {
  Landmark, Pickaxe, Flame, Layers, TreePine, Gavel, Train, Factory, Zap, Anchor, Mountain, Ship,
  TrendingUp, TrendingDown, Trophy, Wallet, Clock, Hash, RotateCcw
} from "lucide-react";

// "owned" = the state directly holds and operates the asset today.
// "licensed" = the state holds title, but a private concern runs it under a
// license or long-term lease — the exact "quasi-ownership" gap this whole
// simulation is about. Batumi Port is real: state-owned, operations leased
// to a private operator for 49 years since 2006. Anaklia is the opposite
// case, and very current: in July 2026 Georgia walked away from a planned
// deal with a Chinese-Singaporean consortium and confirmed the port will
// stay 100% state-owned under a "landlord" model instead.
const ASSET_DEFS = [
  { id: "land",      name: "Sakartvelo Land Fund",         sector: "Land",      Icon: Landmark, base: 160, accent: "#8C6F4E", status: "owned" },
  { id: "gold",      name: "Bolnisi Gold Mines",           sector: "Mining",    Icon: Pickaxe,  base: 220, accent: "#C98A3E", status: "licensed" },
  { id: "coal",      name: "Tkibuli Coal Basin",           sector: "Mining",    Icon: Flame,    base: 90,  accent: "#6B655A", status: "licensed" },
  { id: "marble",    name: "Racha Marble Works",           sector: "Quarrying", Icon: Layers,   base: 130, accent: "#C4BCA1", status: "licensed" },
  { id: "forest",    name: "National Forest Fund",         sector: "Forestry",  Icon: TreePine, base: 100, accent: "#4F7A52", status: "owned" },
  { id: "rail",      name: "Georgian Railway",             sector: "Transport", Icon: Train,    base: 190, accent: "#5B6B73", status: "owned" },
  { id: "manganese", name: "Chiatura Manganese Concern",   sector: "Mining",    Icon: Mountain, base: 150, accent: "#7A6F5C", status: "licensed" },
  { id: "ferro",     name: "Zestafoni Ferroalloys Plant",  sector: "Industry",  Icon: Factory,  base: 170, accent: "#8A4A3E", status: "licensed" },
  { id: "hydro",     name: "Enguri Hydropower Plant",      sector: "Energy",    Icon: Zap,      base: 200, accent: "#3E7A8A", status: "owned" },
  { id: "port",      name: "Batumi Sea Port",              sector: "Logistics", Icon: Anchor,   base: 210, accent: "#3E5A7A", status: "licensed" },
  { id: "anaklia",   name: "Anaklia Deep Sea Port",        sector: "Logistics", Icon: Ship,     base: 240, accent: "#3A6EA5", status: "owned" },
];

const SHARES_PER_ASSET = 5;
const ROUND_SECONDS = 9;
const GOVERNANCE_SECONDS = 30;
const TRADING_SECONDS = 75;
const STARTING_INVEST = 1000;
const HOST_FEE_RATE = 0.01; // 1% to host, 99% capitalizes the company
const BOTS = [
  { id: "bot1", name: "Highland Fund" },
  { id: "bot2", name: "Consortium VII" },
  { id: "bot3", name: "Riverbend Capital" },
];
const HOLDERS = ["player", ...BOTS.map(b => b.id)];

function serial(assetId) {
  return assetId.toUpperCase() + "-" + Math.random().toString(16).slice(2, 8).toUpperCase();
}
function shortHash() {
  return "0x" + Math.random().toString(16).slice(2, 10);
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function fmt(n) { return Math.round(n).toLocaleString(); }

// A company's elected governor spends its capital pool: REINVEST ("buy" —
// modernize, raising the company's underlying value), DIVIDEND ("sell" —
// liquidate capital straight back to current shareholders, pro-rata), or
// HOLD (do nothing — the fate of a company nobody bothered to govern).
function applyGovernancePolicy(assetId, policy, assets, holdings, cash) {
  const a = assets[assetId];
  if (a.governanceResolved) return;
  if (policy === "reinvest") {
    const spend = Math.round(a.capital * 0.5);
    a.capital -= spend;
    a.trueValue = Math.round(a.trueValue * 1.15);
  } else if (policy === "dividend") {
    const payout = a.capital;
    a.capital = 0;
    HOLDERS.forEach(h => {
      const held = holdings[h][assetId];
      if (held > 0) cash[h] += payout * (held / SHARES_PER_ASSET);
    });
  }
  a.governanceResolved = true;
  a.governancePolicy = policy;
}
function pickBotPolicy() {
  const r = Math.random();
  if (r < 0.45) return "reinvest";
  if (r < 0.85) return "dividend";
  return "hold";
}

function makeInitialState() {
  const cash = {};
  HOLDERS.forEach(h => (cash[h] = STARTING_INVEST));
  const holdings = {};
  HOLDERS.forEach(h => { holdings[h] = {}; ASSET_DEFS.forEach(a => (holdings[h][a.id] = 0)); });

  const assets = {};
  ASSET_DEFS.forEach(a => {
    const trueValue = Math.round(a.base * (0.75 + Math.random() * 1.0));
    assets[a.id] = {
      sharesRemaining: SHARES_PER_ASSET,
      currentBid: 0,
      leader: null,
      roundEndsAt: Date.now() + ROUND_SECONDS * 1000,
      trueValue,
      price: a.base,
      priceLast: a.base,
      done: false,
      botValuation: {},
      capital: 0,
      governanceResolved: false,
      governancePolicy: null,
    };
    BOTS.forEach(b => {
      assets[a.id].botValuation[b.id] = trueValue * (0.85 + Math.random() * 0.4);
    });
  });

  return { cash, holdings, assets, mintLog: [], hostTake: 0 };
}

export default function SovereignLots() {
  const [view, setView] = useState("game"); // game | whitepaper
  const [phase, setPhase] = useState("landing"); // landing | claim | auction | governance | trading | end
  const [game, setGame] = useState(makeInitialState);
  const [now, setNow] = useState(Date.now());
  const [governanceEndsAt, setGovernanceEndsAt] = useState(null);
  const [tradingEndsAt, setTradingEndsAt] = useState(null);
  const [mintPopup, setMintPopup] = useState(null);
  const walletHash = useState(() => shortHash())[0];
  const tickRef = useRef(null);

  const resetGame = useCallback(() => {
    setGame(makeInitialState());
    setPhase("claim");
    setGovernanceEndsAt(null);
    setTradingEndsAt(null);
    setMintPopup(null);
  }, []);

  const claim = () => {
    setPhase("auction");
  };

  // ---- main game loop ----
  useEffect(() => {
    if (phase !== "auction" && phase !== "governance" && phase !== "trading") return;
    tickRef.current = setInterval(() => {
      setNow(Date.now());
      setGame(g => {
        const next = {
          cash: { ...g.cash },
          holdings: JSON.parse(JSON.stringify(g.holdings)),
          assets: JSON.parse(JSON.stringify(g.assets)),
          mintLog: [...g.mintLog],
          hostTake: g.hostTake,
        };

        if (phase === "auction") {
          let allDone = true;
          ASSET_DEFS.forEach(def => {
            const a = next.assets[def.id];
            if (a.sharesRemaining <= 0) { a.done = true; return; }
            allDone = false;

            // bots may bid
            BOTS.forEach(bot => {
              if (Math.random() < 0.4) {
                const increment = Math.max(4, Math.round(a.currentBid * 0.09));
                const proposed = a.currentBid + increment;
                const valuation = a.botValuation[bot.id];
                if (proposed <= valuation && next.cash[bot.id] >= proposed && a.leader !== bot.id) {
                  a.currentBid = proposed;
                  a.leader = bot.id;
                }
              }
            });

            if (Date.now() >= a.roundEndsAt) {
              if (a.leader) {
                const winnerId = a.leader;
                const price = a.currentBid;
                const hostCut = Math.round(price * HOST_FEE_RATE);
                const capitalCut = price - hostCut;
                next.cash[winnerId] -= price;
                next.holdings[winnerId][def.id] += 1;
                a.capital += capitalCut;
                next.hostTake += hostCut;
                const s = serial(def.id);
                next.mintLog.push({ serial: s, owner: winnerId, asset: def.id, price, capitalCut, hostCut });
                if (winnerId === "player") {
                  setMintPopup({ serial: s, name: def.name, price, capitalCut, hostCut, accent: def.accent });
                }
              }
              a.sharesRemaining -= 1;
              a.currentBid = 0;
              a.leader = null;
              a.roundEndsAt = Date.now() + ROUND_SECONDS * 1000;
              if (a.sharesRemaining <= 0) {
                a.done = true;
                a.price = a.trueValue * (0.7 + Math.random() * 0.3);
                a.priceLast = a.price;
              }
            }
          });

          if (allDone) {
            ASSET_DEFS.forEach(def => {
              if (next.holdings.player[def.id] === 0) {
                applyGovernancePolicy(def.id, pickBotPolicy(), next.assets, next.holdings, next.cash);
              }
            });
            setPhase("governance");
            setGovernanceEndsAt(Date.now() + GOVERNANCE_SECONDS * 1000);
          }
        }

        if (phase === "governance") {
          if (governanceEndsAt && Date.now() >= governanceEndsAt) {
            ASSET_DEFS.forEach(def => {
              if (!next.assets[def.id].governanceResolved) {
                applyGovernancePolicy(def.id, "hold", next.assets, next.holdings, next.cash);
              }
            });
            setPhase("trading");
            setTradingEndsAt(Date.now() + TRADING_SECONDS * 1000);
          }
        }

        if (phase === "trading") {
          ASSET_DEFS.forEach(def => {
            const a = next.assets[def.id];
            a.priceLast = a.price;
            const reversion = (a.trueValue - a.price) * 0.02;
            const noise = (Math.random() - 0.5) * a.price * 0.06;
            if (Math.random() < 0.03) a.trueValue *= 0.9 + Math.random() * 0.2; // news event
            a.price = Math.max(2, a.price + reversion + noise);

            // bots trade opportunistically
            BOTS.forEach(bot => {
              if (Math.random() < 0.15) {
                const holds = next.holdings[bot.id][def.id];
                if (holds > 0 && a.price > a.trueValue * 1.1) {
                  next.holdings[bot.id][def.id] -= 1;
                  next.cash[bot.id] += a.price * 0.98;
                } else if (next.cash[bot.id] > a.price && a.price < a.trueValue * 0.92) {
                  next.holdings[bot.id][def.id] += 1;
                  next.cash[bot.id] -= a.price;
                }
              }
            });
          });

          if (tradingEndsAt && Date.now() >= tradingEndsAt) {
            setPhase("end");
          }
        }

        return next;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [phase, governanceEndsAt, tradingEndsAt]);

  useEffect(() => {
    if (!mintPopup) return;
    const t = setTimeout(() => setMintPopup(null), 2600);
    return () => clearTimeout(t);
  }, [mintPopup]);

  const placeBid = (assetId, amount) => {
    setGame(g => {
      const a = g.assets[assetId];
      if (a.done || amount <= a.currentBid || g.cash.player < amount) return g;
      const next = { ...g, assets: { ...g.assets, [assetId]: { ...a, currentBid: amount, leader: "player" } } };
      return next;
    });
  };

  const chooseGovernance = (assetId, policy) => {
    setGame(g => {
      if (g.assets[assetId].governanceResolved) return g;
      const assets = JSON.parse(JSON.stringify(g.assets));
      const holdings = JSON.parse(JSON.stringify(g.holdings));
      const cash = { ...g.cash };
      applyGovernancePolicy(assetId, policy, assets, holdings, cash);
      return { ...g, assets, holdings, cash };
    });
  };

  const buy = (assetId) => {
    setGame(g => {
      const a = g.assets[assetId];
      const cost = a.price * 1.01;
      if (g.cash.player < cost) return g;
      const holdings = JSON.parse(JSON.stringify(g.holdings));
      holdings.player[assetId] += 1;
      return { ...g, cash: { ...g.cash, player: g.cash.player - cost }, holdings };
    });
  };
  const sell = (assetId) => {
    setGame(g => {
      if (g.holdings.player[assetId] <= 0) return g;
      const proceeds = g.assets[assetId].price * 0.98;
      const holdings = JSON.parse(JSON.stringify(g.holdings));
      holdings.player[assetId] -= 1;
      return { ...g, cash: { ...g.cash, player: g.cash.player + proceeds }, holdings };
    });
  };

  const netWorth = (holderId) => {
    let total = game.cash[holderId];
    ASSET_DEFS.forEach(def => { total += game.holdings[holderId][def.id] * game.assets[def.id].price; });
    return total;
  };

  if (view === "whitepaper") {
    return <WhitePaper onBack={() => setView("game")} />;
  }

  return (
    <div style={{ fontFamily: "Inter, sans-serif", background: "linear-gradient(180deg,#141B18,#1B2622)", minHeight: "100%", color: "#EDE6D6" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@500;700&family=IBM+Plex+Mono:wght@500;600&family=Inter:wght@400;500;600;700&display=swap');
        .zilla { font-family: 'Zilla Slab', serif; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        @keyframes popIn { 0% { transform: scale(0.85) rotate(-2deg); opacity: 0; } 60% { transform: scale(1.04) rotate(1deg); opacity: 1; } 100% { transform: scale(1) rotate(0deg); } }
        @keyframes ribbon { from { transform: translateX(-8px); } to { transform: translateX(0); } }
        .cert-pop { animation: popIn 0.45s ease-out; }
        .perforated { background-image: repeating-linear-gradient(90deg, transparent, transparent 6px, rgba(0,0,0,0.12) 6px, rgba(0,0,0,0.12) 7px); background-position: top; background-size: 100% 2px; background-repeat: no-repeat; }
      `}</style>

      {/* header */}
      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid rgba(237,230,214,0.15)" }}>
        <div>
          <div className="zilla" style={{ fontSize: 26, fontWeight: 700, letterSpacing: 0.5 }}>SAKARTVELO EXCHANGE</div>
          <div className="mono" style={{ fontSize: 11, opacity: 0.55, letterSpacing: 1 }}>A STATE-ASSET AUCTION SIMULATION</div>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setView("whitepaper")}
            className="mono"
            style={{ fontSize: 11, opacity: 0.6, letterSpacing: 0.5, background: "none", border: "none", color: "#EDE6D6", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}
          >
            WHITE PAPER
          </button>
          <div className="mono" style={{ fontSize: 11, opacity: 0.6 }}>{walletHash}</div>
          {(phase === "auction" || phase === "governance" || phase === "trading" || phase === "end") && (
            <div className="mono flex items-center gap-1.5" style={{ fontSize: 11, opacity: 0.55 }} title="1% of every winning bid, off the top">
              <Hash size={11} /> host take {fmt(game.hostTake)}
            </div>
          )}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded" style={{ background: "rgba(237,230,214,0.08)" }}>
            <Wallet size={16} />
            <span className="mono" style={{ fontWeight: 600 }}>{fmt(game.cash.player)} INVEST</span>
          </div>
        </div>
      </div>

      {phase === "landing" && <LandingScreen onEnter={() => setPhase("claim")} />}

      {phase === "claim" && <ClaimScreen onClaim={claim} />}

      {(phase === "auction" || phase === "governance" || phase === "trading") && (
        <PhaseBanner phase={phase} endsAt={phase === "governance" ? governanceEndsAt : tradingEndsAt} now={now} />
      )}

      {phase === "auction" && (
        <div className="grid gap-4 p-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          {ASSET_DEFS.map(def => (
            <AuctionCard
              key={def.id}
              def={def}
              a={game.assets[def.id]}
              now={now}
              cash={game.cash.player}
              onBid={(amt) => placeBid(def.id, amt)}
            />
          ))}
        </div>
      )}

      {phase === "governance" && (
        <GovernanceScreen game={game} onChoose={chooseGovernance} />
      )}

      {phase === "trading" && (
        <TradingBoard game={game} onBuy={buy} onSell={sell} />
      )}

      {phase === "end" && (
        <EndScreen game={game} netWorth={netWorth} onReset={resetGame} />
      )}

      {mintPopup && <MintPopup data={mintPopup} />}

      <div className="px-6 py-4 mono" style={{ fontSize: 11, opacity: 0.45, borderTop: "1px solid rgba(237,230,214,0.1)" }}>
        Every player starts with an equal INVEST allocation and no way to cash it out except by bidding.
        99% of every winning bid capitalizes the company; 1% goes to the house. Once a company sells out,
        its shareholders govern it — reinvest the capital, pay it out as a dividend, or do nothing — before
        it opens for trading. Named for real Georgian regions, industries, and infrastructure (Bolnisi,
        Tkibuli, Racha, Chiatura, Zestafoni, Enguri, Batumi, Anaklia) but this is a fictional simulation,
        not affiliated with any real company, agency, or state entity.
      </div>
    </div>
  );
}

function WhitePaper({ onBack }) {
  const Section = ({ n, title, children }) => (
    <div style={{ marginBottom: 30 }}>
      <div className="zilla" style={{ fontSize: 17, fontWeight: 700, marginBottom: 8, color: "#EDE6D6" }}>
        <span className="mono" style={{ opacity: 0.45, marginRight: 8, fontSize: 14 }}>{n}</span>{title}
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.7, opacity: 0.82 }}>{children}</div>
    </div>
  );
  return (
    <div style={{ fontFamily: "Inter, sans-serif", background: "linear-gradient(180deg,#141B18,#1B2622)", minHeight: "100vh", color: "#EDE6D6" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@500;700&family=IBM+Plex+Mono:wght@500;600&family=Inter:wght@400;500;600;700&display=swap');
        .zilla { font-family: 'Zilla Slab', serif; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
      `}</style>

      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid rgba(237,230,214,0.15)" }}>
        <div className="zilla" style={{ fontSize: 20, fontWeight: 700 }}>SAKARTVELO EXCHANGE</div>
        <button
          onClick={onBack}
          className="mono"
          style={{ fontSize: 11, letterSpacing: 0.5, background: "rgba(237,230,214,0.08)", border: "none", color: "#EDE6D6", cursor: "pointer", padding: "8px 14px", borderRadius: 3 }}
        >
          ← BACK TO EXCHANGE
        </button>
      </div>

      <div className="px-6 py-12" style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ background: "rgba(201,138,62,0.12)", border: "1px solid #C98A3E", borderRadius: 4, padding: "14px 16px", marginBottom: 36 }}>
          <div className="mono" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "#C98A3E", marginBottom: 4 }}>
            ⚠ FICTIONAL SIMULATION
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, opacity: 0.85 }}>
            This is a protocol design for a simulated game, not a real financial product, security, or claim on
            any real-world asset. Any resemblance to real states, companies, or agencies is fictional and exists
            solely as a gamified rule-set.
          </div>
        </div>

        <div className="mono" style={{ fontSize: 11, opacity: 0.5, letterSpacing: 1, marginBottom: 6 }}>PROTOCOL WHITE PAPER</div>
        <div className="zilla" style={{ fontSize: 32, fontWeight: 700, marginBottom: 8, lineHeight: 1.15 }}>
          Sakartvelo Exchange
        </div>
        <div style={{ fontSize: 14.5, opacity: 0.7, marginBottom: 44, lineHeight: 1.6 }}>
          A closed-loop allocation, a competitive market, and elected, term-limited governance —
          simulating how a state's holdings could pass into citizen ownership without a "sell it for cash"
          method that structurally favors whoever already has capital.
        </div>

        <Section n="0" title="Abstract">
          Most privatization designs fail in one of two familiar ways: sold for cash, ownership concentrates
          immediately among whoever already had money; given away as freely tradable vouchers, it concentrates
          almost as fast, as recipients sell under financial pressure for a fraction of value. Sakartvelo
          Exchange is a mechanism-design response to both failure modes at once — an allocation that cannot be
          resold for cash, a price set by competitive bidding rather than a bureaucrat's estimate, and a
          governance layer that is elected and term-limited rather than inherited or appointed.
        </Section>

        <Section n="1" title="The problem this is modeling">
          Call it the purchasing-power gap: when state assets are sold at market price, the people with the
          least capital are structurally excluded before the auction even opens. Historical voucher
          privatizations tried to fix this by giving equity away for free — but freely tradable vouchers just
          moved the same problem a few months downstream, as recipients facing real financial pressure sold
          them cheaply to whoever already had cash. Neither method actually distributes ownership; the second
          one just adds a delay. Sakartvelo Exchange tests a third structure: equal allocation of a currency
          that literally cannot be sold for cash, spent only on bidding for real shares at a real,
          competitively-discovered price.
        </Section>

        <Section n="2" title="Phase one — monetization">
          Every verified citizen receives one equal, one-time allocation of INVEST — a closed-loop token that
          can be spent bidding at auction, but never transferred wallet-to-wallet, gifted, or sold. That
          closes the exact hole that sank voucher privatization: there's no way to cash out early under
          pressure, because there's no legitimate path for INVEST to reach anyone except through the auction
          house itself. Total emission is capped two separate ways — a hard numeric ceiling independent of who
          gets verified, and a rule tying new allocations to whether the privatization process is still
          actually running. Once every listed asset has been sold, issuance stops entirely, for everyone,
          citizen or not.
        </Section>

        <Section n="3" title="Phase two — the auction">
          Each listed company auctions a fixed number of shares. Every bid is sealed until settlement; the
          highest bidders each win one share and pay exactly what they bid — no uniform clearing price, no
          bureaucrat-set floor. Winning shares are locked for a period after minting, so a bidder can't flip
          their new stake for a quick profit before governance ever gets a chance to organize — ownership has
          to mean something before it becomes tradable.
        </Section>

        <Section n="4" title="Phase three — governance">
          Once a company is at least half-assigned to real owners, candidacy opens: any current shareholder
          can put themselves forward with a short platform. Shareholders vote, weighted by shares of that
          specific company. Winning takes a real majority — 51% of votes cast — not just a plurality; if
          nobody clears that bar, the field narrows to the top two and voting runs again, a runoff rather than
          a single contested plurality vote. The winner holds office for a fixed term, then the whole cycle
          reopens from nothing. And the elected wallet itself never directly operates the company — the
          winner registers a separate, freshly-generated operating key for that term specifically, which goes
          dead the moment the term ends. A new term means a genuinely new key, not just a renewed mandate on
          an old one.
        </Section>

        <Section n="5" title="Phase four — treasury and capital">
          An elected governor can move a small, fixed share of any single asset a company holds without
          needing anyone's approval — enough for ordinary operations, not enough to matter if that key is ever
          compromised. Anything larger has to go one of two ways: sold at open market through a sealed-bid
          process where the governor never learns who's bidding what until after bidding closes and settlement
          needs no one's signature at all, or paid to a specific named party only after a real shareholder
          vote approves it — the path for a fixed invoice an open auction can't express. Separately, every
          term ends with its own mandatory vote: shareholders decide, independent of whatever the outgoing
          governor did, whether to pay out a small dividend or leave the capital invested for whoever governs
          next.
        </Section>

        <Section n="6" title="Phase five — secondary markets">
          Two markets exist beyond the primary auction. Shareholders can list and sell shares once their lock
          period ends, and companies can do the same with stakes they've built up in each other. Separately,
          citizenship itself is a one-time, historical fact — verified and allocated only during the original
          privatization window. Anyone arriving afterward has no free path to INVEST at all; their only way in
          is buying spare INVEST from an existing citizen or a company treasury, paid for in another crypto
          asset. There is no fiat on-ramp anywhere in the design — deliberately. What counts as an acceptable
          payment asset is a governance decision, not something the protocol can verify on its own.
        </Section>

        <Section n="7" title="What isn't solved">
          Worth stating plainly rather than glossing over. A protocol can't verify that two wallets belong to
          different people — the citizen-verification layer stops trivial throwaway-wallet farming, not one
          person controlling several verified identities. A single administrative key still controls who
          counts as a citizen and which assets get listed at all, which is a real concentration of power this
          design hasn't distributed. Nothing here has been through a professional security audit, adversarial
          testing, or a live testnet under real conditions. Treated as a finished, trustworthy system rather
          than a working simulation of one, it would be a mistake — the interesting part is the mechanism
          design, not a claim that every risk has been closed out.
        </Section>

        <div className="mono" style={{ fontSize: 11, opacity: 0.4, marginTop: 50, paddingTop: 20, borderTop: "1px solid rgba(237,230,214,0.12)", lineHeight: 1.6 }}>
          Implemented across three contracts — InvestToken, ShareAuction, and CompanyTreasury — split apart
          because the full mechanism exceeded Ethereum's single-contract size limit once built out in full.
          Source and full technical documentation ship alongside this site.
        </div>
      </div>
    </div>
  );
}

function LandingScreen({ onEnter }) {
  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 22 }}>
      <div className="zilla" style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: "#EDE6D6" }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, opacity: 0.78 }}>{children}</div>
    </div>
  );
  return (
    <div className="px-6 py-10" style={{ maxWidth: 720, margin: "0 auto" }}>
      <div style={{ background: "rgba(201,138,62,0.12)", border: "1px solid #C98A3E", borderRadius: 4, padding: "14px 16px", marginBottom: 28 }}>
        <div className="mono" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "#C98A3E", marginBottom: 4 }}>
          ⚠ FICTIONAL SIMULATION
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, opacity: 0.85 }}>
          This is not a real country, government, company, or financial product. Any resemblance to real
          states, state assets, or companies is fictional and exists solely as a gamified rule-set — a
          setting, not a claim about anything real. Nothing here is a security or a claim on any
          real-world asset.
        </div>
      </div>

      <div className="zilla" style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>How this works</div>
      <div className="mono" style={{ fontSize: 11, opacity: 0.5, marginBottom: 28, letterSpacing: 0.5 }}>
        READ BEFORE YOU CLAIM — IT ONLY TAKES A MINUTE
      </div>

      <Section title="1. Citizenship is a one-time, historical fact">
        Only wallets verified and claimed during the original privatization window count as citizens.
        Once that window closes, no one — citizen or not — gets a new free allocation, ever.
      </Section>

      <Section title="2. Auctions decide who owns what">
        Each state concern — a mine, a rail network, a port, land, forest — auctions off a fixed number of
        shares. Highest bidders win a share each and pay exactly what they bid. Shares are locked for a
        period after minting before they can be resold.
      </Section>

      <Section title="3. Once a company is half-sold, shareholders govern it">
        As soon as at least half of a company's shares have real owners, any shareholder can put themselves
        forward as a candidate with a short platform (roughly 700 words). Other shareholders vote, weighted
        by how many shares of that company they hold.
      </Section>

      <Section title="4. Winning takes 51%, not just the most votes">
        A candidate needs 51% of the votes actually cast to win outright. If nobody clears that bar, every
        candidate except the top two is eliminated and another round of voting opens — a runoff. This
        repeats until someone wins.
      </Section>

      <Section title="5. The governor's term is one month — with its own key">
        The elected governor gets 30 days of authority. Winning the election doesn't hand over control
        directly — the governor registers a fresh keypair specifically for operating the company that term,
        separate from their personal wallet. When the term ends, that key stops working entirely, and
        whoever wins the next election registers a brand new one.
      </Section>

      <Section title="6. What a governor can actually do">
        Reinvest the company's capital into another company's live auction (buy). Sell a stake the company
        holds in another company back onto the market, or sell down its own capital for outside crypto
        (sell). Move any other asset the company holds. All of it — on-chain, visible, and only for the
        length of one term.
      </Section>

      <Section title="7. Every term ends with a mandatory vote">
        Once a governor's term is over, every shareholder votes: pay out 1% of the company's capital as a
        dividend, or leave it invested. Simple majority decides — this happens automatically, regardless of
        what the outgoing governor chose to do during their term.
      </Section>

      <Section title="8. Joining after the fact means buying in — never for free">
        Anyone who wasn't a citizen during the original privatization has no path to a free allocation.
        Their only way in is buying spare INVEST from a citizen or a company treasury, paid for in an
        approved crypto asset. There is no fiat on-ramp anywhere in this system — no bank transfer, no card
        payment, nothing pegged to a government currency by design.
      </Section>

      <Section title="What this demo simplifies">
        This playable version compresses governance into a single instant choice per company, for pace. The
        real, deployed contracts implement everything above in full: candidacy, runoff rounds, rotating
        operating keys, the end-of-term policy vote, and the INVEST secondary market. If you deploy the
        contracts yourself, that's the version that actually runs.
      </Section>

      <button
        onClick={onEnter}
        className="mono"
        style={{ background: "#EDE6D6", color: "#1C1A16", border: "none", padding: "12px 28px", borderRadius: 3, fontWeight: 700, cursor: "pointer", fontSize: 13, letterSpacing: 0.5, marginTop: 8 }}
      >
        ENTER THE EXCHANGE
      </button>
    </div>
  );
}

function ClaimScreen({ onClaim }) {
  return (
    <div className="flex items-center justify-center" style={{ minHeight: 420 }}>
      <div className="perforated" style={{ background: "#EDE6D6", color: "#1C1A16", borderRadius: 4, padding: "36px 40px", maxWidth: 420, textAlign: "center", boxShadow: "0 12px 30px rgba(0,0,0,0.35)" }}>
        <Gavel size={30} style={{ margin: "0 auto 12px" }} />
        <div className="zilla" style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Citizen Allocation</div>
        <p style={{ fontSize: 14, opacity: 0.75, marginBottom: 20, lineHeight: 1.5 }}>
          Eleven state concerns go to auction today — mines, a rail network, a hydropower plant, two sea
          ports, land, forest, and more. Some are fully state-owned; others the state only ever licensed
          out to a private operator. Everyone bidding gets the same starting balance. What you do with it
          is yours to decide.
        </p>
        <p className="mono" style={{ fontSize: 10, opacity: 0.45, marginBottom: 20 }}>
          One allocation per verified wallet — the contract version gates this behind identity, not just a checkbox.
        </p>
        <button
          onClick={onClaim}
          className="mono"
          style={{ background: "#1C1A16", color: "#EDE6D6", border: "none", padding: "10px 22px", borderRadius: 3, fontWeight: 600, cursor: "pointer", fontSize: 13, letterSpacing: 0.5 }}
        >
          CLAIM {STARTING_INVEST} INVEST
        </button>
      </div>
    </div>
  );
}

function PhaseBanner({ phase, endsAt, now }) {
  const remaining = endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : null;
  const label = phase === "auction" ? "Auction floor open" : phase === "governance" ? "Governance vote open" : "Trading floor open";
  const Icon = phase === "auction" ? Gavel : phase === "governance" ? Landmark : TrendingUp;
  return (
    <div className="flex items-center gap-3 px-6 py-2" style={{ background: "rgba(237,230,214,0.06)" }}>
      <Icon size={14} />
      <span className="mono" style={{ fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>{label}</span>
      {remaining !== null && (
        <span className="mono" style={{ fontSize: 12, opacity: 0.6, marginLeft: "auto" }}>
          <Clock size={12} style={{ display: "inline", marginRight: 4, verticalAlign: -2 }} />
          closes in {remaining}s
        </span>
      )}
    </div>
  );
}

function AuctionCard({ def, a, now, cash, onBid }) {
  const remaining = Math.max(0, Math.ceil((a.roundEndsAt - now) / 1000));
  const pct = clamp(remaining / ROUND_SECONDS, 0, 1);
  const nextBid = Math.max(a.currentBid + 10, Math.round((a.currentBid || def.base * 0.3) * 1.1));
  const isLeader = a.leader === "player";
  const soldOut = a.sharesRemaining <= 0;

  return (
    <div style={{ background: "rgba(237,230,214,0.05)", border: `1px solid ${a.done ? "rgba(237,230,214,0.1)" : def.accent + "55"}`, borderRadius: 6, padding: 16, opacity: soldOut ? 0.55 : 1 }}>
      <div className="flex items-center gap-2 mb-2">
        <def.Icon size={18} color={def.accent} />
        <div style={{ flex: 1 }}>
          <div className="zilla" style={{ fontWeight: 700, fontSize: 15 }}>{def.name}</div>
          <div className="mono" style={{ fontSize: 10, opacity: 0.5 }}>{def.sector.toUpperCase()} · LOT {SHARES_PER_ASSET - a.sharesRemaining + 1}/{SHARES_PER_ASSET}</div>
        </div>
      </div>
      <div className="mono" style={{ fontSize: 9, letterSpacing: 0.5, opacity: 0.5, marginBottom: 10, textTransform: "uppercase" }}>
        {def.status === "owned" ? "Currently: state-owned" : "Currently: state license — not owned"}
      </div>

      {soldOut ? (
        <div className="mono" style={{ fontSize: 12, opacity: 0.6, padding: "10px 0" }}>
          Sold out — moves to trading floor.<br />Capitalized {fmt(a.capital)} INVEST.
        </div>
      ) : (
        <>
          <div style={{ height: 4, borderRadius: 2, background: "rgba(237,230,214,0.12)", marginBottom: 10, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct * 100}%`, background: def.accent, transition: "width 1s linear" }} />
          </div>
          <div className="flex items-center justify-between mb-1">
            <div className="mono" style={{ fontSize: 12, opacity: 0.7 }}>Current bid</div>
            <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{fmt(a.currentBid)} {isLeader && <span style={{ color: def.accent }}>(you)</span>}</div>
          </div>
          <div className="flex items-center justify-between mb-3">
            <div className="mono" style={{ fontSize: 10, opacity: 0.45 }}>Capitalized so far</div>
            <div className="mono" style={{ fontSize: 10, opacity: 0.45 }}>{fmt(a.capital)} INVEST</div>
          </div>
          <button
            disabled={cash < nextBid}
            onClick={() => onBid(nextBid)}
            className="mono"
            style={{ width: "100%", padding: "8px 0", borderRadius: 3, border: "none", cursor: cash < nextBid ? "not-allowed" : "pointer", background: cash < nextBid ? "rgba(237,230,214,0.15)" : def.accent, color: "#141B18", fontWeight: 700, fontSize: 12 }}
          >
            BID {fmt(nextBid)}
          </button>
        </>
      )}
    </div>
  );
}

function GovernanceScreen({ game, onChoose }) {
  return (
    <div className="grid gap-4 p-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
      {ASSET_DEFS.map(def => {
        const a = game.assets[def.id];
        const held = game.holdings.player[def.id];
        const canGovern = held > 0 && !a.governanceResolved;
        return (
          <div key={def.id} style={{ background: "rgba(237,230,214,0.05)", border: `1px solid ${def.accent}55`, borderRadius: 6, padding: 16 }}>
            <div className="flex items-center gap-2 mb-3">
              <def.Icon size={18} color={def.accent} />
              <div style={{ flex: 1 }}>
                <div className="zilla" style={{ fontWeight: 700, fontSize: 15 }}>{def.name}</div>
                <div className="mono" style={{ fontSize: 10, opacity: 0.5 }}>
                  YOU HOLD {held}/{SHARES_PER_ASSET} · CAPITAL {fmt(a.capital)}
                </div>
              </div>
            </div>

            {a.governanceResolved ? (
              <div className="mono" style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.5 }}>
                {a.governancePolicy === "reinvest" && "Governor reinvested — modernized, future value up."}
                {a.governancePolicy === "dividend" && "Governor paid a dividend to every shareholder."}
                {a.governancePolicy === "hold" && "No governor acted — capital held as-is."}
              </div>
            ) : canGovern ? (
              <div className="flex flex-col gap-2">
                <button onClick={() => onChoose(def.id, "reinvest")} className="mono" style={{ padding: "8px 0", borderRadius: 3, border: "none", background: def.accent, color: "#141B18", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>REINVEST (raise value)</button>
                <button onClick={() => onChoose(def.id, "dividend")} className="mono" style={{ padding: "8px 0", borderRadius: 3, border: `1px solid ${def.accent}88`, background: "transparent", color: "#EDE6D6", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>PAY DIVIDEND</button>
                <button onClick={() => onChoose(def.id, "hold")} className="mono" style={{ padding: "6px 0", borderRadius: 3, border: "none", background: "transparent", color: "#EDE6D6", opacity: 0.55, fontSize: 11, cursor: "pointer" }}>HOLD</button>
              </div>
            ) : (
              <div className="mono" style={{ fontSize: 12, opacity: 0.5 }}>You hold no shares here — other owners are voting.</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TradingBoard({ game, onBuy, onSell }) {
  return (
    <div className="grid gap-4 p-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
      {ASSET_DEFS.map(def => {
        const a = game.assets[def.id];
        const held = game.holdings.player[def.id];
        const up = a.price >= a.priceLast;
        return (
          <div key={def.id} style={{ background: "rgba(237,230,214,0.05)", border: `1px solid ${def.accent}55`, borderRadius: 6, padding: 16 }}>
            <div className="flex items-center gap-2 mb-3">
              <def.Icon size={18} color={def.accent} />
              <div style={{ flex: 1 }}>
                <div className="zilla" style={{ fontWeight: 700, fontSize: 15 }}>{def.name}</div>
                <div className="mono" style={{ fontSize: 10, opacity: 0.5 }}>YOU HOLD {held} SHARE{held === 1 ? "" : "S"}</div>
              </div>
            </div>
            <div className="flex items-center justify-between mb-3">
              <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>{fmt(a.price)}</div>
              <div style={{ color: up ? "#7FAF8E" : "#C97D6F" }} className="flex items-center gap-1 mono" >
                {up ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                <span style={{ fontSize: 11 }}>{up ? "up" : "down"}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => onBuy(def.id)} className="mono" style={{ flex: 1, padding: "8px 0", borderRadius: 3, border: "none", background: def.accent, color: "#141B18", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>BUY</button>
              <button onClick={() => onSell(def.id)} disabled={held <= 0} className="mono" style={{ flex: 1, padding: "8px 0", borderRadius: 3, border: `1px solid ${def.accent}88`, background: "transparent", color: "#EDE6D6", fontWeight: 700, fontSize: 12, cursor: held <= 0 ? "not-allowed" : "pointer", opacity: held <= 0 ? 0.4 : 1 }}>SELL</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EndScreen({ game, netWorth, onReset }) {
  const ranked = HOLDERS.map(h => ({
    id: h,
    name: h === "player" ? "You" : BOTS.find(b => b.id === h).name,
    worth: netWorth(h),
  })).sort((a, b) => b.worth - a.worth);
  const playerRank = ranked.findIndex(r => r.id === "player") + 1;
  const totalCapital = ASSET_DEFS.reduce((sum, def) => sum + game.assets[def.id].capital, 0);

  return (
    <div className="flex items-center justify-center px-6" style={{ minHeight: 460 }}>
      <div className="perforated" style={{ background: "#EDE6D6", color: "#1C1A16", borderRadius: 4, padding: "32px 36px", maxWidth: 460, width: "100%", boxShadow: "0 12px 30px rgba(0,0,0,0.35)" }}>
        <Trophy size={26} style={{ margin: "0 auto 10px", display: "block" }} />
        <div className="zilla" style={{ fontSize: 20, fontWeight: 700, textAlign: "center", marginBottom: 4 }}>Trading floor closed</div>
        <div className="mono" style={{ fontSize: 12, textAlign: "center", opacity: 0.65, marginBottom: 20 }}>
          You finished #{playerRank} of {ranked.length}
        </div>
        {ranked.map((r, i) => (
          <div key={r.id} className="flex items-center justify-between" style={{ padding: "8px 0", borderBottom: i < ranked.length - 1 ? "1px solid rgba(28,26,22,0.12)" : "none" }}>
            <div className="mono" style={{ fontSize: 13, fontWeight: r.id === "player" ? 700 : 500 }}>
              {i + 1}. {r.name}
            </div>
            <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{fmt(r.worth)}</div>
          </div>
        ))}
        <div className="mono" style={{ fontSize: 11, opacity: 0.55, textAlign: "center", marginTop: 16, lineHeight: 1.6 }}>
          {fmt(totalCapital)} INVEST capitalized across five companies · {fmt(game.hostTake)} to the house
        </div>
        <button
          onClick={onReset}
          className="mono flex items-center justify-center gap-2"
          style={{ width: "100%", marginTop: 14, background: "#1C1A16", color: "#EDE6D6", border: "none", padding: "10px 0", borderRadius: 3, fontWeight: 600, cursor: "pointer", fontSize: 13 }}
        >
          <RotateCcw size={14} /> PLAY AGAIN
        </button>
      </div>
    </div>
  );
}

function MintPopup({ data }) {
  return (
    <div style={{ position: "fixed", top: 90, right: 24, zIndex: 50 }}>
      <div className="cert-pop perforated" style={{ background: "#EDE6D6", color: "#1C1A16", borderRadius: 4, padding: "16px 18px", width: 260, boxShadow: "0 10px 24px rgba(0,0,0,0.4)", border: `2px solid ${data.accent}` }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: 1, opacity: 0.6, marginBottom: 4 }}>SHARE CERTIFICATE MINTED</div>
        <div className="zilla" style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{data.name}</div>
        <div className="flex items-center gap-1 mono" style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
          <Hash size={11} /> {data.serial}
        </div>
        <div className="mono" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Paid {fmt(data.price)} INVEST</div>
        <div className="mono" style={{ fontSize: 10, opacity: 0.6, lineHeight: 1.5 }}>
          {fmt(data.capitalCut)} → company capital<br />
          {fmt(data.hostCut)} → host
        </div>
      </div>
    </div>
  );
}
