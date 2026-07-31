import { useState, useEffect, useCallback } from "react";
import { Landmark, Clock } from "lucide-react";
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
  generateOperatingKeypair,
} from "../web3.js";

function useCountdown(endSeconds) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Number(endSeconds) - now);
  const passed = remaining <= 0 && Number(endSeconds) > 0;
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return { passed, label: `${h}h ${m}m ${s}s` };
}

export default function CompanyGovernance({ company, wallet }) {
  const [gov, setGov] = useState(null);
  const [candidates, setCandidates] = useState(null);
  const [myShares, setMyShares] = useState(0n);
  const [myVoted, setMyVoted] = useState(false);
  const [program, setProgram] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [generatedKey, setGeneratedKey] = useState(null);

  const load = useCallback(async () => {
    const [g, c, shares] = await Promise.all([
      getCompanyGovernance(company.id, wallet.provider),
      getCandidates(company.id, wallet.provider),
      getMyShareCount(company.id, wallet.address, wallet.provider),
    ]);
    setGov(g);
    setCandidates(c);
    setMyShares(shares);
    if (g.round > 0n) {
      const voted = await hasVotedThisRound(company.id, g.round, wallet.address, wallet.provider);
      setMyVoted(voted);
    }
  }, [company.id, wallet]);

  useEffect(() => {
    load();
  }, [load]);

  const eligible = company.sharesIssued * 2n >= company.totalShares;

  const votingCountdown = useCountdown(gov?.voteEnd ?? 0n);
  const termCountdown = useCountdown(gov?.termEnd ?? 0n);

  if (!company.finalized || !eligible) {
    return (
      <div className="mono" style={{ fontSize: 11, opacity: 0.5, marginTop: 10 }}>
        Governance opens once at least half this company's shares are assigned.
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
      setError(err.shortMessage || err.message || "Transaction failed.");
    } finally {
      setBusy(false);
    }
  };

  const iAmCandidate = candidates?.some((c) => c.address.toLowerCase() === wallet.address.toLowerCase());
  const iAmGovernor = gov.governor.toLowerCase() === wallet.address.toLowerCase();
  const activeCandidates = candidates?.filter((c) => !c.eliminated) || [];

  return (
    <div style={{ borderTop: "1px solid rgba(237,230,214,0.1)", marginTop: 14, paddingTop: 14 }}>
      <div className="flex items-center gap-2 mono" style={{ fontSize: 11, opacity: 0.6, marginBottom: 10 }}>
        <Landmark size={12} /> GOVERNANCE — term {gov.termNum.toString()}
      </div>

      {/* A governor is currently seated */}
      {gov.governor !== "0x0000000000000000000000000000000000000000" ? (
        <div>
          <div className="mono" style={{ fontSize: 12, marginBottom: 6 }}>
            Governor: {gov.governor.slice(0, 6)}…{gov.governor.slice(-4)}
            {iAmGovernor && " (you)"}
          </div>
          <div className="mono flex items-center gap-1" style={{ fontSize: 11, opacity: 0.7, marginBottom: 10 }}>
            <Clock size={11} />
            {termCountdown.passed ? "Term expired — awaiting a new term" : `Term ends in ${termCountdown.label}`}
          </div>

          {iAmGovernor && gov.operatingKey === "0x0000000000000000000000000000000000000000" && !termCountdown.passed && (
            <div style={{ background: "rgba(201,138,62,0.1)", border: "1px solid #C98A3E", borderRadius: 4, padding: 12, marginBottom: 10 }}>
              <div className="mono" style={{ fontSize: 11, marginBottom: 8 }}>
                You're elected, but haven't registered an operating key yet — no governor-only action
                (invest, dividends, etc.) will work until you do.
              </div>
              {!generatedKey ? (
                <button
                  onClick={async () => setGeneratedKey(await generateOperatingKeypair())}
                  className="mono"
                  style={{ background: "#C98A3E", color: "#141B18", border: "none", padding: "6px 14px", borderRadius: 3, fontWeight: 700, fontSize: 11, cursor: "pointer" }}
                >
                  GENERATE A FRESH OPERATING KEY
                </button>
              ) : (
                <div>
                  <div className="mono" style={{ fontSize: 10, color: "#C97D6F", marginBottom: 6, wordBreak: "break-all" }}>
                    ⚠ Save this private key now — it won't be shown again, and it's the only way to act as
                    governor this term: {generatedKey.privateKey}
                  </div>
                  <button
                    onClick={() => run(() => setOperatingKeyReal(wallet.signer, company.id, generatedKey.address))}
                    disabled={busy}
                    className="mono"
                    style={{ background: "#C98A3E", color: "#141B18", border: "none", padding: "6px 14px", borderRadius: 3, fontWeight: 700, fontSize: 11, cursor: "pointer" }}
                  >
                    {busy ? "..." : "REGISTER THIS KEY (REAL TRANSACTION)"}
                  </button>
                </div>
              )}
            </div>
          )}

          {termCountdown.passed && (
            <button
              onClick={() => run(() => startNewTermReal(wallet.signer, company.id))}
              disabled={busy}
              className="mono"
              style={{ background: "#EDE6D6", color: "#1C1A16", border: "none", padding: "8px 16px", borderRadius: 3, fontWeight: 700, fontSize: 12, cursor: "pointer" }}
            >
              {busy ? "..." : "START A NEW TERM"}
            </button>
          )}
        </div>
      ) : gov.round === 0n ? (
        /* No election open yet — candidacy phase */
        <div>
          {myShares > 0n && !iAmCandidate && (
            <div style={{ marginBottom: 10 }}>
              <textarea
                value={program}
                onChange={(e) => setProgram(e.target.value)}
                placeholder="Your platform (max ~700 words / 4500 bytes)"
                className="mono"
                style={{ width: "100%", minHeight: 60, background: "rgba(237,230,214,0.08)", border: "1px solid rgba(237,230,214,0.2)", borderRadius: 3, padding: 8, color: "#EDE6D6", fontSize: 11, marginBottom: 6 }}
              />
              <button
                onClick={() => run(() => declareCandidacyReal(wallet.signer, company.id, program))}
                disabled={busy || !program.trim()}
                className="mono"
                style={{ background: "#C98A3E", color: "#141B18", border: "none", padding: "6px 14px", borderRadius: 3, fontWeight: 700, fontSize: 11, cursor: "pointer" }}
              >
                {busy ? "..." : "DECLARE CANDIDACY"}
              </button>
            </div>
          )}

          {candidates && candidates.length > 0 && (
            <div className="mono" style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>
              {candidates.length} candidate{candidates.length === 1 ? "" : "s"} declared so far
            </div>
          )}

          {candidates && candidates.length > 0 && (
            <button
              onClick={() => run(() => openGovernanceVoteReal(wallet.signer, company.id))}
              disabled={busy}
              className="mono"
              style={{ background: "#EDE6D6", color: "#1C1A16", border: "none", padding: "8px 16px", borderRadius: 3, fontWeight: 700, fontSize: 12, cursor: "pointer" }}
            >
              {busy ? "..." : "OPEN VOTING"}
            </button>
          )}
        </div>
      ) : !votingCountdown.passed ? (
        /* Voting is open */
        <div>
          <div className="mono flex items-center gap-1" style={{ fontSize: 11, opacity: 0.7, marginBottom: 10 }}>
            <Clock size={11} /> Round {gov.round.toString()} closes in {votingCountdown.label}
          </div>
          {activeCandidates.map((c) => (
            <div key={c.address} className="flex items-center justify-between" style={{ padding: "6px 0", borderBottom: "1px solid rgba(237,230,214,0.08)" }}>
              <div className="mono" style={{ fontSize: 11 }}>
                {c.address.slice(0, 6)}…{c.address.slice(-4)} — {c.votes.toString()} votes
              </div>
              {myShares > 0n && !myVoted && (
                <button
                  onClick={() => run(() => voteReal(wallet.signer, company.id, c.address))}
                  disabled={busy}
                  className="mono"
                  style={{ background: "#C98A3E", color: "#141B18", border: "none", padding: "4px 10px", borderRadius: 3, fontWeight: 700, fontSize: 10, cursor: "pointer" }}
                >
                  VOTE
                </button>
              )}
            </div>
          ))}
          {myVoted && <div className="mono" style={{ fontSize: 10, opacity: 0.5, marginTop: 6 }}>You've voted this round.</div>}
        </div>
      ) : (
        /* Voting closed, not yet tallied */
        <button
          onClick={() => run(() => tallyRoundReal(wallet.signer, company.id))}
          disabled={busy}
          className="mono"
          style={{ background: "#EDE6D6", color: "#1C1A16", border: "none", padding: "8px 16px", borderRadius: 3, fontWeight: 700, fontSize: 12, cursor: "pointer" }}
        >
          {busy ? "..." : "TALLY THIS ROUND"}
        </button>
      )}

      {error && <div className="mono" style={{ fontSize: 11, color: "#C97D6F", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
