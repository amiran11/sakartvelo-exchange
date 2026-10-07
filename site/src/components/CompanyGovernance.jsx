import { useState, useEffect, useCallback } from "react";
import { Landmark, Clock, KeyRound, AlertTriangle } from "lucide-react";
import {
  getCompanyGovernance,
  getCandidates,
  getMyShareCount,
  hasVotedThisRound,
  declareCandidacyReal,
  openGovernanceVoteReal,
  voteReal,
  tallyRoundReal,
  setOperatingKeyReal,
  startNewTermReal,
  getEthBalance,
  normalizeAddress,
} from "../web3.js";

const ZERO = "0x0000000000000000000000000000000000000000";
// Below this, an operating key probably can't pay for even one transaction.
const LOW_GAS_WEI = 200000000000000n; // 0.0002 ETH

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(5);
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

function useCountdown(endSeconds) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Number(endSeconds) - now);
  const passed = remaining <= 0 && Number(endSeconds) > 0;
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return { passed, label: d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s` };
}

const btnPrimary = { background: "#C98A3E", color: "#141B18", border: "none", padding: "6px 14px", borderRadius: 3, fontWeight: 700, fontSize: 11, cursor: "pointer" };
const btnLight = { background: "#EDE6D6", color: "#1C1A16", border: "none", padding: "8px 16px", borderRadius: 3, fontWeight: 700, fontSize: 12, cursor: "pointer" };
const inputStyle = { width: "100%", background: "rgba(237,230,214,0.08)", border: "1px solid rgba(237,230,214,0.2)", borderRadius: 3, padding: 8, color: "#EDE6D6", fontSize: 11, marginBottom: 6 };
const noticeBox = (color) => ({ background: `${color}1A`, border: `1px solid ${color}`, borderRadius: 4, padding: 12, marginBottom: 10 });

// The governor registers a second MetaMask account as this term's
// operating key. Only its ADDRESS is ever entered here — no private key
// is shown, copied or typed into the site at any point.
function OperatingKeyForm({ governor, companyName, busy, onSubmit, submitLabel }) {
  const [input, setInput] = useState("");
  const [problem, setProblem] = useState("");

  const submit = async () => {
    setProblem("");
    const addr = await normalizeAddress(input);
    if (!addr) return setProblem("That isn't a valid wallet address. Copy it again from MetaMask.");
    if (addr === ZERO) return setProblem("That's the empty address. Copy the new account's address from MetaMask.");
    if (same(addr, governor)) {
      return setProblem("That's your governor account. Add a separate account in MetaMask and paste its address instead.");
    }
    onSubmit(addr);
  };

  return (
    <div>
      <ol className="mono" style={{ fontSize: 11, lineHeight: 1.7, paddingLeft: 18, margin: "0 0 10px" }}>
        <li>In MetaMask, open the account menu and choose "Add account". Name it something like "{companyName} operating key".</li>
        <li>Copy the new account's address and paste it below.</li>
        <li>Send that account a little ETH on Arbitrum One to pay for gas. 0.001 ETH is plenty for a term.</li>
        <li>Switch MetaMask back to this governor account, then register below.</li>
      </ol>
      <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x… address of the new account" className="mono" style={inputStyle} />
      {problem && <div className="mono" style={{ fontSize: 11, color: "#C97D6F", marginBottom: 6 }}>{problem}</div>}
      <button onClick={submit} disabled={busy || !input.trim()} className="mono" style={btnPrimary}>
        {busy ? "..." : submitLabel}
      </button>
    </div>
  );
}

export default function CompanyGovernance({ company, wallet, source = "ShareAuction" }) {
  const [gov, setGov] = useState(null);
  const [candidates, setCandidates] = useState(null);
  const [myShares, setMyShares] = useState(0n);
  const [myVoted, setMyVoted] = useState(false);
  const [keyBalance, setKeyBalance] = useState(null);
  const [program, setProgram] = useState("");
  const [openProgram, setOpenProgram] = useState(null);
  const [showReplace, setShowReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // RoundAuction opens governance once half the shares are assigned, sold
  // out or not. The older ShareAuction screen additionally waited for the
  // auction to finish, so that rule is kept for it.
  const halfAssigned = company.sharesIssued * 2n >= company.totalShares;
  const eligible = source === "RoundAuction" ? halfAssigned : company.finalized && halfAssigned;

  const load = useCallback(async () => {
    // Skip all chain reads until governance can actually open — candidate
    // lookup scans event logs, which is expensive to repeat on every card.
    if (!eligible) return;
    const [g, c, shares] = await Promise.all([
      getCompanyGovernance(company.id, wallet.provider, source),
      getCandidates(company.id, wallet.provider, source),
      getMyShareCount(company.id, wallet.address, wallet.provider, source),
    ]);
    setGov(g);
    setCandidates(c);
    setMyShares(shares);
    setMyVoted(g.round > 0n ? await hasVotedThisRound(company.id, g.round, wallet.address, wallet.provider, source) : false);
    setKeyBalance(g.operatingKey !== ZERO ? await getEthBalance(g.operatingKey, wallet.provider) : null);
  }, [company.id, wallet, source, eligible]);

  useEffect(() => {
    load();
  }, [load]);

  const votingCountdown = useCountdown(gov?.voteEnd ?? 0n);
  const termCountdown = useCountdown(gov?.termEnd ?? 0n);

  if (!eligible) {
    return (
      <div className="mono" style={{ fontSize: 11, opacity: 0.5, marginTop: 10 }}>
        Governance opens once at least half this company's shares are assigned
        ({company.sharesIssued.toString()} of {company.totalShares.toString()} so far).
      </div>
    );
  }
  if (gov === null) {
    return <div className="mono" style={{ fontSize: 11, opacity: 0.5, marginTop: 10 }}>Loading governance state…</div>;
  }

  const run = async (fn) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.shortMessage || err.reason || err.message || "Transaction failed.");
    } finally {
      setBusy(false);
    }
  };

  const hasGovernor = gov.governor !== ZERO;
  const hasKey = gov.operatingKey !== ZERO;
  const iAmGovernor = same(gov.governor, wallet.address);
  const iAmOperatingKey = hasKey && same(gov.operatingKey, wallet.address);
  const iAmCandidate = candidates?.some((c) => same(c.address, wallet.address));
  const activeCandidates = candidates?.filter((c) => !c.eliminated) || [];
  const lowGas = keyBalance !== null && keyBalance < LOW_GAS_WEI;
  const registerKey = (addr) => run(async () => {
    await setOperatingKeyReal(wallet.signer, company.id, addr, source);
    setShowReplace(false);
  });

  return (
    <div style={{ borderTop: "1px solid rgba(237,230,214,0.1)", marginTop: 14, paddingTop: 14 }}>
      <div className="flex items-center gap-2 mono" style={{ fontSize: 11, opacity: 0.6, marginBottom: 10 }}>
        <Landmark size={12} /> Governance, term {gov.termNum.toString()}
      </div>

      {hasGovernor ? (
        <div>
          {/* Connected as this company's operating key */}
          {iAmOperatingKey && !termCountdown.passed && (
            <div style={noticeBox("#7FA37A")}>
              <div className="mono flex items-center gap-1" style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                <KeyRound size={12} /> Acting as governor of {company.name}
              </div>
              <div className="mono" style={{ fontSize: 11, opacity: 0.8 }}>
                This account is the registered operating key. Gas balance: {fmtEth(keyBalance ?? 0n)} ETH.
              </div>
              {lowGas && (
                <div className="mono" style={{ fontSize: 11, color: "#C97D6F", marginTop: 6 }}>
                  Balance is low. Send this account some ETH on Arbitrum One before taking governor actions.
                </div>
              )}
            </div>
          )}

          <div className="mono" style={{ fontSize: 12, marginBottom: 6 }}>
            Governor: {short(gov.governor)}{iAmGovernor && " (you)"}
          </div>
          <div className="mono" style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
            Operating key: {hasKey ? short(gov.operatingKey) : "not registered yet"}
          </div>
          <div className="mono flex items-center gap-1" style={{ fontSize: 11, opacity: 0.7, marginBottom: 10 }}>
            <Clock size={11} />
            {termCountdown.passed ? "Term over. Anyone can start a new term." : `Term ends in ${termCountdown.label}`}
          </div>

          {/* Governor connected, no key yet */}
          {iAmGovernor && !hasKey && !termCountdown.passed && (
            <div style={noticeBox("#C98A3E")}>
              <div className="mono" style={{ fontSize: 11, marginBottom: 8 }}>
                You're elected. Register an operating key to use governor controls this term.
              </div>
              <OperatingKeyForm governor={gov.governor} companyName={company.name} busy={busy} onSubmit={registerKey} submitLabel="Register operating key" />
            </div>
          )}

          {/* Governor connected, key already registered */}
          {iAmGovernor && hasKey && !termCountdown.passed && (
            <div style={noticeBox("#C98A3E")}>
              <div className="mono" style={{ fontSize: 11, marginBottom: 6 }}>
                Switch MetaMask to your operating-key account ({short(gov.operatingKey)}) to use governor controls.
                Gas balance there: {fmtEth(keyBalance ?? 0n)} ETH.
              </div>
              {lowGas && (
                <div className="mono" style={{ fontSize: 11, color: "#C97D6F", marginBottom: 6 }}>
                  That account is low on ETH. Send it some before taking governor actions.
                </div>
              )}
              {!showReplace ? (
                <button onClick={() => setShowReplace(true)} className="mono" style={{ ...btnPrimary, background: "transparent", color: "#C98A3E", border: "1px solid #C98A3E" }}>
                  Replace operating key
                </button>
              ) : (
                <div style={{ marginTop: 8 }}>
                  <div className="mono" style={{ fontSize: 11, marginBottom: 6 }}>
                    Use this if the old account is lost or you think it's compromised. The old key stops working as soon as the new one is registered.
                  </div>
                  <OperatingKeyForm governor={gov.governor} companyName={company.name} busy={busy} onSubmit={registerKey} submitLabel="Register new operating key" />
                </div>
              )}
            </div>
          )}

          {termCountdown.passed && (
            <button onClick={() => run(() => startNewTermReal(wallet.signer, company.id, source))} disabled={busy} className="mono" style={btnLight}>
              {busy ? "..." : "Start a new term"}
            </button>
          )}
        </div>
      ) : gov.round === 0n ? (
        /* Candidacy phase */
        <div>
          {myShares > 0n && !iAmCandidate && (
            <div style={{ marginBottom: 10 }}>
              <textarea
                value={program}
                onChange={(e) => setProgram(e.target.value)}
                placeholder="Your platform (max ~700 words / 4500 bytes)"
                className="mono"
                style={{ ...inputStyle, minHeight: 60 }}
              />
              <button onClick={() => run(() => declareCandidacyReal(wallet.signer, company.id, program, source))} disabled={busy || !program.trim()} className="mono" style={btnPrimary}>
                {busy ? "..." : "Declare candidacy"}
              </button>
            </div>
          )}
          {myShares === 0n && (
            <div className="mono" style={{ fontSize: 11, opacity: 0.5, marginBottom: 8 }}>
              Hold at least one share of this company to stand or vote.
            </div>
          )}

          {candidates && candidates.length > 0 ? (
            <>
              <div className="mono" style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>
                {candidates.length} candidate{candidates.length === 1 ? "" : "s"} declared
              </div>
              {candidates.map((c) => (
                <CandidateRow key={c.address} c={c} wallet={wallet} openProgram={openProgram} setOpenProgram={setOpenProgram} />
              ))}
              <div className="mono" style={{ fontSize: 10.5, opacity: 0.6, margin: "10px 0 8px", lineHeight: 1.5 }}>
                Opening voting starts a 3-day round. Make sure shareholders are ready to vote: a round that closes with no votes can't be tallied.
              </div>
              <button onClick={() => run(() => openGovernanceVoteReal(wallet.signer, company.id, source))} disabled={busy} className="mono" style={btnLight}>
                {busy ? "..." : "Open voting"}
              </button>
            </>
          ) : (
            <div className="mono" style={{ fontSize: 11, opacity: 0.5 }}>No candidates yet.</div>
          )}
        </div>
      ) : !votingCountdown.passed ? (
        /* Voting open */
        <div>
          <div className="mono flex items-center gap-1" style={{ fontSize: 11, opacity: 0.7, marginBottom: 10 }}>
            <Clock size={11} /> Round {gov.round.toString()} closes in {votingCountdown.label}
          </div>
          {gov.totalVotesCast === 0n && (
            <div className="mono flex gap-1" style={{ fontSize: 11, color: "#C98A3E", marginBottom: 10, lineHeight: 1.5 }}>
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
              No votes cast yet. If this round closes with no votes, the election can't be tallied.
            </div>
          )}
          {activeCandidates.map((c) => (
            <CandidateRow key={c.address} c={c} wallet={wallet} openProgram={openProgram} setOpenProgram={setOpenProgram} showVotes>
              {myShares > 0n && !myVoted && (
                <button onClick={() => run(() => voteReal(wallet.signer, company.id, c.address, source))} disabled={busy} className="mono" style={{ ...btnPrimary, padding: "4px 10px", fontSize: 10 }}>
                  Vote
                </button>
              )}
            </CandidateRow>
          ))}
          {myVoted && <div className="mono" style={{ fontSize: 10, opacity: 0.5, marginTop: 6 }}>You've voted this round.</div>}
        </div>
      ) : gov.totalVotesCast === 0n ? (
        /* Closed with zero votes: tallyRound would revert */
        <div className="mono flex gap-1" style={{ fontSize: 11, color: "#C97D6F", lineHeight: 1.5 }}>
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
          This round closed with no votes, so it can't be tallied. The current contract has no way to restart this election.
        </div>
      ) : (
        /* Closed, ready to tally */
        <button onClick={() => run(() => tallyRoundReal(wallet.signer, company.id, source))} disabled={busy} className="mono" style={btnLight}>
          {busy ? "..." : "Tally this round"}
        </button>
      )}

      {error && <div className="mono" style={{ fontSize: 11, color: "#C97D6F", marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function CandidateRow({ c, wallet, openProgram, setOpenProgram, showVotes, children }) {
  const open = openProgram === c.address;
  return (
    <div style={{ padding: "6px 0", borderBottom: "1px solid rgba(237,230,214,0.08)" }}>
      <div className="flex items-center justify-between">
        <button onClick={() => setOpenProgram(open ? null : c.address)} className="mono" style={{ background: "none", border: "none", color: "#EDE6D6", fontSize: 11, cursor: "pointer", padding: 0, textAlign: "left" }}>
          {short(c.address)}{same(c.address, wallet.address) && " (you)"}
          {showVotes && ` — ${c.votes.toString()} votes`}
          <span style={{ opacity: 0.5 }}> {open ? "hide platform" : "read platform"}</span>
        </button>
        {children}
      </div>
      {open && (
        <div className="mono" style={{ fontSize: 11, opacity: 0.8, whiteSpace: "pre-wrap", marginTop: 6, lineHeight: 1.5 }}>
          {c.program || "No platform text."}
        </div>
      )}
    </div>
  );
}
