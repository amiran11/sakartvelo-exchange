import { useState, useEffect, useCallback } from "react";
import { Landmark, Clock, KeyRound, Users } from "lucide-react";
import {
  getCompanyGovernance,
  getCandidates,
  getMyShareCount,
  getMyVoteWeight,
  getElectionRules,
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
import { C, ZERO, short, same, useCountdown, useTx, count } from "./liveUtils.js";
import { Button, Input, Notice, Muted, ErrorLine, Section } from "./ui.jsx";

// Below this, an operating key probably can't pay for even one transaction.
const LOW_GAS_WEI = 200000000000000n; // 0.0002 ETH
const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(5);
const PROGRAM_PREVIEW = 320; // characters shown before "Read full program"
const MAX_PROGRAM_BYTES = 4500;

function pct(part, whole) {
  if (!whole || whole === 0n) return "0%";
  const bp = Number((part * 10000n) / whole);
  return `${(bp / 100).toFixed(bp < 100 ? 2 : 1)}%`;
}

// The governor registers a second MetaMask account as this term's
// operating key. Only its ADDRESS is ever entered here: no private key
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
      <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x… address of the new account" style={{ marginBottom: 6 }} />
      {problem && <div className="mono" style={{ fontSize: 11, color: C.danger, marginBottom: 6 }}>{problem}</div>}
      <Button onClick={submit} busy={busy} disabled={!input.trim()}>{submitLabel}</Button>
    </div>
  );
}

// One candidate, with their program readable before anyone votes.
function CandidateCard({ c, wallet, sharesIssued, showVotes, totalVotes, children }) {
  const [open, setOpen] = useState(false);
  const program = c.program || "";
  const long = program.length > PROGRAM_PREVIEW;
  const shown = open || !long ? program : program.slice(0, PROGRAM_PREVIEW).trimEnd() + "…";
  return (
    <div style={{ border: `1px solid ${c.eliminated ? "rgba(237,230,214,0.08)" : "rgba(237,230,214,0.18)"}`, borderRadius: 4, padding: 12, marginBottom: 8, opacity: c.eliminated ? 0.5 : 1 }}>
      <div className="flex items-start justify-between gap-3" style={{ marginBottom: 8 }}>
        <div className="mono" style={{ fontSize: 11.5 }}>
          <div style={{ fontWeight: 700 }}>{short(c.address)}{same(c.address, wallet.address) && " (you)"}</div>
          <div style={{ opacity: 0.6, fontSize: 10.5, marginTop: 2 }}>
            holds {count(c.stake, "share")} ({pct(c.stake, sharesIssued)})
            {c.eliminated && " · out of the running"}
          </div>
          {showVotes && !c.eliminated && (
            <div style={{ color: C.accent, fontSize: 10.5, marginTop: 2 }}>
              {count(c.votes, "vote")}{totalVotes > 0n ? ` (${pct(c.votes, totalVotes)} of votes cast)` : ""}
            </div>
          )}
        </div>
        {children}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap", opacity: program ? 0.9 : 0.5 }}>
        {program ? shown : "This candidate didn't write a program."}
      </div>
      {long && (
        <button onClick={() => setOpen(!open)} className="mono" style={{ background: "none", border: "none", color: C.accent, fontSize: 10.5, cursor: "pointer", padding: 0, marginTop: 6 }}>
          {open ? "Show less" : "Read full program"}
        </button>
      )}
    </div>
  );
}

function CandidacyForm({ company, wallet, myShares, rules, candidateCount, onDone }) {
  const [program, setProgram] = useState("");
  const { busy, error, run } = useTx();
  const bytes = new TextEncoder().encode(program).length;

  // Minimum stake: 0.1% of the shares issued so far (Governance only).
  const minStake = rules ? (company.sharesIssued * rules.minStakeBps + 9999n) / 10000n : 0n;
  const full = rules && BigInt(candidateCount) >= rules.maxCandidates;

  if (full) return <Muted style={{ marginBottom: 10 }}>All {rules.maxCandidates.toString()} candidate places are taken for this election.</Muted>;
  if (rules && myShares < minStake) {
    return (
      <Muted style={{ marginBottom: 10 }}>
        To stand as a candidate you need at least {count(minStake, "share")} (0.1% of the {company.sharesIssued.toLocaleString()} issued).
        You hold {myShares.toLocaleString()}.
      </Muted>
    );
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="mono" style={{ fontSize: 11, marginBottom: 6 }}>Stand for governor. Tell shareholders what you'll do with the company:</div>
      <textarea
        value={program}
        onChange={(e) => setProgram(e.target.value)}
        placeholder="Your program: priorities, how you'd use the treasury, dividends or reinvestment…"
        className="mono"
        style={{ width: "100%", minHeight: 90, background: "rgba(237,230,214,0.08)", border: "1px solid rgba(237,230,214,0.2)", borderRadius: 3, padding: 8, color: C.text, fontSize: 11.5, lineHeight: 1.5 }}
      />
      <div className="mono flex justify-between items-center" style={{ fontSize: 10.5, margin: "4px 0 8px" }}>
        <span style={{ color: bytes > MAX_PROGRAM_BYTES ? C.danger : undefined, opacity: bytes > MAX_PROGRAM_BYTES ? 1 : 0.5 }}>
          {bytes.toLocaleString()} / {MAX_PROGRAM_BYTES.toLocaleString()} bytes (about 700 words). It can't be edited after you declare.
        </span>
      </div>
      <Button busy={busy} disabled={!program.trim() || bytes > MAX_PROGRAM_BYTES} onClick={() => run(() => declareCandidacyReal(wallet.signer, company.id, program), onDone)}>
        Declare candidacy
      </Button>
      <ErrorLine error={error} />
    </div>
  );
}

export default function CompanyGovernance({ company, wallet }) {
  const [gov, setGov] = useState(null);
  const [candidates, setCandidates] = useState(null);
  const [myShares, setMyShares] = useState(0n);
  const [myWeight, setMyWeight] = useState(0n);
  const [myVoted, setMyVoted] = useState(false);
  const [keyBalance, setKeyBalance] = useState(null);
  const [rules, setRules] = useState(null);
  const [showReplace, setShowReplace] = useState(false);
  const [loadError, setLoadError] = useState("");
  const { busy, error, run } = useTx();

  // Elections open once half the shares are issued, sold out or not.
  const eligible = company.sharesIssued * 2n >= company.totalShares;

  const load = useCallback(async () => {
    if (!eligible) return;
    try {
      const [g, c, shares, r] = await Promise.all([
        getCompanyGovernance(company.id, wallet.provider),
        getCandidates(company.id, wallet.provider),
        getMyShareCount(company.id, wallet.address, wallet.provider),
        getElectionRules(wallet.provider),
      ]);
      const [weight, voted, keyBal] = await Promise.all([
        getMyVoteWeight(company.id, wallet.address, g, wallet.provider),
        g.round > 0n ? hasVotedThisRound(company.id, g.round, wallet.address, wallet.provider) : Promise.resolve(false),
        g.operatingKey !== ZERO ? getEthBalance(g.operatingKey, wallet.provider) : Promise.resolve(null),
      ]);
      setGov(g); setCandidates(c); setMyShares(shares); setRules(r);
      setMyWeight(weight); setMyVoted(voted); setKeyBalance(keyBal);
      setLoadError("");
    } catch (err) {
      setLoadError(err.shortMessage || err.message || "Couldn't read governance state.");
    }
  }, [company.id, wallet, eligible]);

  useEffect(() => { load(); }, [load]);

  const votingCountdown = useCountdown(gov?.voteEnd ?? 0n);
  const termCountdown = useCountdown(gov?.termEnd ?? 0n);

  if (!eligible) {
    return (
      <Section icon={Landmark} title="Governance">
        <Muted>
          Elections open once at least half this company's shares are issued
          ({company.sharesIssued.toLocaleString()} of {company.totalShares.toLocaleString()} so far).
        </Muted>
      </Section>
    );
  }
  if (gov === null) {
    return (
      <Section icon={Landmark} title="Governance">
        {loadError ? <ErrorLine error={loadError} /> : <Muted>Loading governance…</Muted>}
      </Section>
    );
  }

  const hasGovernor = gov.governor !== ZERO;
  const hasKey = gov.operatingKey !== ZERO;
  const iAmGovernor = same(gov.governor, wallet.address);
  const iAmOperatingKey = hasKey && same(gov.operatingKey, wallet.address);
  const iAmCandidate = candidates?.some((c) => same(c.address, wallet.address));
  const standing = candidates?.filter((c) => !c.eliminated) || [];
  const lowGas = keyBalance !== null && keyBalance < LOW_GAS_WEI;
  const registerKey = (addr) => run(() => setOperatingKeyReal(wallet.signer, company.id, addr), async () => { setShowReplace(false); await load(); });
  const sortedByVotes = [...(candidates || [])].sort((a, b) => (b.votes > a.votes ? 1 : b.votes < a.votes ? -1 : 0));

  return (
    <Section icon={Landmark} title={gov.termNum === 0n ? "Governance · first election" : hasGovernor ? `Governance · term ${gov.termNum.toString()}` : `Governance · election for term ${(gov.termNum + 1n).toString()}`}>
      {hasGovernor ? (
        <div>
          {iAmOperatingKey && !termCountdown.passed && (
            <Notice color={C.ok}>
              <div className="flex items-center gap-1" style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>
                <KeyRound size={12} /> Acting as governor of {company.name}
              </div>
              This account is the registered operating key. Governor controls are in the Treasury section below.
              Gas balance: {fmtEth(keyBalance ?? 0n)} ETH.
              {lowGas && <div style={{ color: C.danger, marginTop: 6 }}>Balance is low. Send this account some ETH on Arbitrum One before taking governor actions.</div>}
            </Notice>
          )}

          <div className="mono" style={{ fontSize: 12, marginBottom: 6 }}>Governor: {short(gov.governor)}{iAmGovernor && " (you)"}</div>
          <div className="mono" style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>Operating key: {hasKey ? short(gov.operatingKey) : "not registered yet"}</div>
          <div className="mono flex items-center gap-1" style={{ fontSize: 11, opacity: 0.7, marginBottom: 10 }}>
            <Clock size={11} />
            {termCountdown.passed ? "Term over. Anyone can start the next election." : `Term ends in ${termCountdown.label}`}
          </div>

          {iAmGovernor && !hasKey && !termCountdown.passed && (
            <Notice>
              <div style={{ marginBottom: 8 }}>You're elected. Register an operating key to use governor controls this term.</div>
              <OperatingKeyForm governor={gov.governor} companyName={company.name} busy={busy} onSubmit={registerKey} submitLabel="Register operating key" />
            </Notice>
          )}

          {iAmGovernor && hasKey && !termCountdown.passed && (
            <Notice>
              <div style={{ marginBottom: 6 }}>
                Switch MetaMask to your operating-key account ({short(gov.operatingKey)}) to use governor controls.
                Gas balance there: {fmtEth(keyBalance ?? 0n)} ETH.
              </div>
              {lowGas && <div style={{ color: C.danger, marginBottom: 6 }}>That account is low on ETH. Send it some before taking governor actions.</div>}
              {!showReplace ? (
                <Button kind="outline" onClick={() => setShowReplace(true)}>Replace operating key</Button>
              ) : (
                <div style={{ marginTop: 8 }}>
                  <div style={{ marginBottom: 6 }}>Use this if the old account is lost or you think it's compromised. The old key stops working as soon as the new one is registered.</div>
                  <OperatingKeyForm governor={gov.governor} companyName={company.name} busy={busy} onSubmit={registerKey} submitLabel="Register new operating key" />
                </div>
              )}
            </Notice>
          )}

          {termCountdown.passed && (
            <Button kind="light" busy={busy} onClick={() => run(() => startNewTermReal(wallet.signer, company.id), load)}>Start the next election</Button>
          )}
        </div>
      ) : gov.round === 0n ? (
        /* Candidacy phase */
        <div>
          {myShares > 0n && !iAmCandidate && (
            <CandidacyForm company={company} wallet={wallet} myShares={myShares} rules={rules} candidateCount={candidates?.length || 0} onDone={load} />
          )}
          {myShares === 0n && <Muted style={{ marginBottom: 10 }}>Hold shares in this company to stand as a candidate or vote.</Muted>}

          {candidates && candidates.length > 0 ? (
            <>
              <div className="mono flex items-center gap-1" style={{ fontSize: 11, opacity: 0.75, marginBottom: 8 }}>
                <Users size={11} /> {candidates.length}{rules ? ` of ${rules.maxCandidates.toString()}` : ""} candidate{candidates.length === 1 ? "" : "s"}
              </div>
              {candidates.map((c) => <CandidateCard key={c.address} c={c} wallet={wallet} sharesIssued={company.sharesIssued} />)}
              <Muted style={{ margin: "10px 0 8px" }}>
                Anyone can open voting. It runs for 3 days, and no new candidates can join after that, so wait until everyone who wants to stand has declared.
                If nobody votes, voting simply reopens for another 3 days.
              </Muted>
              <Button kind="light" busy={busy} onClick={() => run(() => openGovernanceVoteReal(wallet.signer, company.id), load)}>Open voting</Button>
            </>
          ) : (
            <Muted>No candidates yet.</Muted>
          )}
        </div>
      ) : !votingCountdown.passed ? (
        /* Voting open */
        <div>
          <div className="mono flex items-center gap-1" style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>
            <Clock size={11} /> {standing.length === 2 && candidates.length > 2 ? "Runoff round" : "Voting"} closes in {votingCountdown.label}
          </div>
          <Muted style={{ marginBottom: 10 }}>
            A candidate with 51% of the votes cast wins. Otherwise the top two go to a runoff.
             Votes count the shares each wallet held when this round opened.
          </Muted>
          {myVoted ? (
            <Notice color={C.ok}>You've voted in this round with {count(myWeight, "share")}.</Notice>
          ) : myWeight > 0n ? (
            <Notice>You can vote with {count(myWeight, "share")}. Read the programs, then vote for one candidate.</Notice>
          ) : myShares > 0n ? (
            <Muted style={{ marginBottom: 10 }}>You got your shares after this round opened, so you can't vote in it. You'll be able to vote in later rounds.</Muted>
          ) : null}
          {sortedByVotes.map((c) => (
            <CandidateCard key={c.address} c={c} wallet={wallet} sharesIssued={company.sharesIssued} showVotes totalVotes={gov.totalVotesCast}>
              {!c.eliminated && myWeight > 0n && !myVoted && (
                <Button small busy={busy} onClick={() => run(() => voteReal(wallet.signer, company.id, c.address), load)}>Vote</Button>
              )}
            </CandidateCard>
          ))}
        </div>
      ) : (
        /* Closed, waiting for a tally */
        <div>
          <Muted style={{ marginBottom: 10 }}>
            {gov.totalVotesCast === 0n
              ? "Voting closed with no votes. Counting it reopens voting for another 3 days."
              : "Voting has closed. Anyone can count the votes: this elects a governor or starts a runoff between the top two."}
          </Muted>
          <Button kind="light" busy={busy} onClick={() => run(() => tallyRoundReal(wallet.signer, company.id), load)}>
            {gov.totalVotesCast === 0n ? "Reopen voting" : "Count the votes"}
          </Button>
        </div>
      )}

      <ErrorLine error={error} />
    </Section>
  );
}
