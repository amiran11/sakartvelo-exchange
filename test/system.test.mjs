import { ethers } from "ethers";
import fs from "fs";
const art = (n) => JSON.parse(fs.readFileSync(`./art8/art_${n}.json`));
const P = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); c ? pass++ : fail++; };
const warp = async (s) => { await P.send("evm_increaseTime", [s]); await P.send("evm_mine", []); };
const now = async () => (await P.getBlock("latest")).timestamp;
const w = async (p) => (await p).wait();
async function reverts(fn, text) { try { await (await fn()).wait(); return false; } catch (e) { const m = `${e.shortMessage} ${e.info?.error?.message || ""} ${e.reason || ""}`; if (m.includes(text)) return true; console.log("     got:", m.slice(0, 160)); return false; } }
const S = await Promise.all((await P.listAccounts()).map((a) => P.getSigner(a.address)));
const owner = S[0];
const deploy = async (n, ...a) => { const c = await new ethers.ContractFactory(art(n).abi, art(n).bytecode, owner).deploy(...a); await c.waitForDeployment(); return c; };

async function system(nCitizens = 30) {
  const IT = await deploy("InvestToken", 1000);
  const RA = await deploy("RoundAuction", await IT.getAddress());
  const GOV = await deploy("Governance", await RA.getAddress());
  const CT = await deploy("CompanyTreasury", await IT.getAddress(), await RA.getAddress(), await GOV.getAddress());
  const [ra, ct] = [await RA.getAddress(), await CT.getAddress()];
  await w(IT.setAuthorizedSink(ra, true)); await w(IT.setAuthorizedSink(ct, true));
  await w(IT.setRoundAuctionForTradability(ra));
  await w(RA.setGovernance(await GOV.getAddress())); await w(RA.setTreasury(ct));
  const cits = S.slice(1, 1 + nCitizens);
  await w(IT.setVerifiedCitizens(cits.map((s) => s.address), true));
  for (const s of cits) { await w(IT.connect(s).claim()); await w(IT.connect(s).approve(ra, ethers.MaxUint256)); await w(IT.connect(s).approve(ct, ethers.MaxUint256)); }
  return { IT, RA, GOV, CT, ra, ct, cits };
}
async function round(RA, id, bids) {
  { const c0 = await RA.companies(id); if (BigInt(await now()) >= c0.roundEnd) await w(RA.settleRound(id)); } // roll a stale round forward
  for (const [s, amt] of bids) await w(RA.connect(s).placeBid(id, E(amt)));
  const c = await RA.companies(id); const t = await now(); if (Number(c.roundEnd) > t) await warp(Number(c.roundEnd) - t + 1);
  await w(RA.settleRound(id, { gasLimit: 32_000_000 }));
}
async function elect(GOV, id, winner, voters = [winner]) {
  await w(GOV.connect(winner).declareCandidacy(id, "platform"));
  await warp(2); await w(GOV.openGovernanceVote(id));
  for (const v of voters) await w(GOV.connect(v).vote(id, winner.address));
  await warp(3 * DAY + 1); await w(GOV.tallyRound(id));
}
// what CompanyTreasury holds in INVEST must equal what it owes
async function ctInvariant(IT, CT, expectedOwed) { return (await IT.balanceOf(await CT.getAddress())) === expectedOwed; }

// =================================================================
console.log("Governance: eligibility and candidacy rules");
{
  const { RA, GOV, cits } = await system(30);
  await w(RA.listCompany(0, "Co", 10, 3600)); await round(RA, 0, [[cits[0], 1]]);
  ok(await reverts(async () => GOV.connect(cits[0]).declareCandidacy(0, "p"), "under 50% assigned"), "no candidacy below 50% issued");
  // min stake: 1,200 issued, small holder has 1 share (< 0.1%)
  await w(RA.listCompany(1, "Big", 2000, 3600));
  await round(RA, 1, [[cits[1], 299], [cits[2], 1]]);
  await round(RA, 1, [[cits[3], 299], [cits[4], 1]]);
  await round(RA, 1, [[cits[5], 299], [cits[6], 1]]);
  await round(RA, 1, [[cits[7], 299], [cits[8], 1]]);
  ok((await RA.companies(1)).sharesIssued === 1200n, "1,200 shares issued over 4 rounds");
  ok(await reverts(async () => GOV.connect(cits[2]).declareCandidacy(1, "p"), "stake below 0.1%"), "holder of 1 share (0.08%) can't stand");
  await w(GOV.connect(cits[1]).declareCandidacy(1, "p")); ok(true, "holder of 299 shares can stand");
  ok(await reverts(async () => GOV.connect(cits[3]).declareCandidacy(1, "x".repeat(4501)), "program too long"), "program limited to 4,500 bytes");
  // cap 20 + closed once voting opens
  await w(RA.listCompany(2, "Cap", 30, 3600)); const h = cits.slice(0, 25);
  await round(RA, 2, h.map((s) => [s, 1]));
  for (let i = 0; i < 20; i++) await w(GOV.connect(h[i]).declareCandidacy(2, "p"));
  ok(await reverts(async () => GOV.connect(h[20]).declareCandidacy(2, "p"), "candidates full"), "21st candidate rejected");
  await warp(2); await w(GOV.openGovernanceVote(2));
  for (let i = 0; i < 25; i++) await w(GOV.connect(h[i]).vote(2, h[i % 20].address));
  await warp(3 * DAY + 1);
  const g = await w(GOV.tallyRound(2));
  console.log(`     tally with 20 candidates: ${(Number(g.gasUsed) / 1e6).toFixed(2)}M gas`);
  ok(g.gasUsed < 2_000_000n, "tally stays cheap at the cap");
}

console.log("Governance: zero-vote rounds (Finding 9)");
{
  const { RA, GOV, cits } = await system(6);
  await w(RA.listCompany(0, "Two", 4, 3600)); await round(RA, 0, [[cits[0], 1], [cits[1], 1]]);
  await w(GOV.connect(cits[0]).declareCandidacy(0, "a")); await w(GOV.connect(cits[1]).declareCandidacy(0, "b"));
  await warp(2); await w(GOV.openGovernanceVote(0)); await warp(3 * DAY + 1);
  await w(GOV.tallyRound(0));
  ok((await GOV.governanceRound(0)) === 1n && (await GOV.governanceVoteEnd(0)) > BigInt(await now()), "empty round reopens instead of locking");
  await w(GOV.connect(cits[0]).vote(0, cits[1].address)); await warp(3 * DAY + 1); await w(GOV.tallyRound(0));
  ok((await GOV.companyGovernor(0)) === cits[1].address, "election completes once a vote is cast");
  await w(RA.listCompany(1, "Three", 6, 3600)); await round(RA, 1, [[cits[2], 1], [cits[3], 1], [cits[4], 1]]);
  for (const s of [cits[2], cits[3], cits[4]]) await w(GOV.connect(s).declareCandidacy(1, "p"));
  await warp(2); await w(GOV.openGovernanceVote(1)); await warp(3 * DAY + 1); await w(GOV.tallyRound(1));
  const el = await Promise.all([cits[2], cits[3], cits[4]].map((s) => GOV.eliminated(1, s.address)));
  ok(el.every((x) => !x), "with 3 candidates, nobody is eliminated by an empty round (v7 eliminated all)");
  for (const s of [cits[2], cits[3], cits[4]]) await w(GOV.connect(s).vote(1, s.address));
  await warp(3 * DAY + 1); await w(GOV.tallyRound(1));
  ok((await GOV.governanceRound(1)) === 2n, "1/1/1 split goes to a runoff round");
  await w(GOV.connect(cits[2]).vote(1, cits[2].address)); await warp(3 * DAY + 1); await w(GOV.tallyRound(1));
  ok((await GOV.companyGovernor(1)) === cits[2].address, "runoff elects a governor");
}

console.log("Governance: votes use balances from before the round opened");
{
  const { RA, GOV, cits } = await system(5);
  const [a, b, c, d] = cits;
  await w(RA.listCompany(0, "Co", 6, 3600)); await round(RA, 0, [[a, 2], [b, 1]]); // a: 2 shares, b: 1
  await w(GOV.connect(a).declareCandidacy(0, "a")); await w(GOV.connect(b).declareCandidacy(0, "b"));
  await warp(8 * DAY); // past the share transfer lock
  await warp(2); await w(GOV.openGovernanceVote(0));
  await w(GOV.connect(a).vote(0, b.address));
  await w(RA.connect(a).transferFrom(a.address, c.address, 0)); await w(RA.connect(a).transferFrom(a.address, c.address, 1));
  ok(await reverts(async () => GOV.connect(c).vote(0, a.address), "no shares at snapshot"), "shares moved to a second wallet mid-vote can't vote again");
  await round(RA, 0, [[d, 1]]); // d buys a new share after voting opened
  ok(await reverts(async () => GOV.connect(d).vote(0, a.address), "no shares at snapshot"), "shares acquired after the round opened don't count");
  await warp(3 * DAY + 1); await w(GOV.tallyRound(0));
  ok((await GOV.companyGovernor(0)) === b.address && (await GOV.roundVotes(0, 1, b.address)) === 2n, "result counts each share once (b elected with 2)");
}

console.log("Governance: terms and operating keys");
{
  const { RA, GOV, cits } = await system(4);
  const [a, key, x] = cits;
  await w(RA.listCompany(0, "Co", 2, 3600)); await round(RA, 0, [[a, 1]]);
  await elect(GOV, 0, a);
  ok(await reverts(async () => GOV.connect(x).setOperatingKey(0, key.address), "not governor"), "only the governor can register a key");
  await w(GOV.connect(a).setOperatingKey(0, key.address));
  ok(await reverts(async () => GOV.connect(x).voteAsCorporation(0, 0, a.address), "not operating key"), "corporate voting needs the operating key");
  ok(await reverts(async () => GOV.startNewTerm(0), "term not over"), "can't reset before the term ends");
  await warp(30 * DAY + 1); const end = await GOV.governorTermEnd(0);
  await w(GOV.startNewTerm(0));
  ok((await GOV.termEndedAt(0, 1)) === end && (await GOV.governorOperatingKey(0)) === ethers.ZeroAddress, "reset records when term 1 ended and clears the key");
  await w(GOV.connect(a).declareCandidacy(0, "again")); ok(true, "candidacy reopens for term 2");
}

// =================================================================
console.log("Treasury: custody and the 5% allowance");
{
  const { RA, GOV, CT, cits } = await system(4);
  const [a, key, x] = cits;
  const MOCK = await deploy("MockERC20", "MOCK"); const FEE = await deploy("FeeToken");
  await w(RA.listCompany(0, "Co", 2, 3600)); await round(RA, 0, [[a, 1]]); await elect(GOV, 0, a); await w(GOV.connect(a).setOperatingKey(0, key.address));
  await w(MOCK.mint(x.address, E(1000))); await w(MOCK.connect(x).approve(await CT.getAddress(), ethers.MaxUint256));
  await w(FEE.mint(x.address, E(100))); await w(FEE.connect(x).approve(await CT.getAddress(), ethers.MaxUint256));
  await w(CT.connect(x).depositToken(0, await MOCK.getAddress(), E(1000)));
  await w(CT.connect(x).depositToken(0, await FEE.getAddress(), E(100)));
  ok((await CT.companyTokenBalance(0, await FEE.getAddress())) === E(99), "fee-on-transfer deposit credits only the 99 that arrived");
  ok(await reverts(async () => CT.connect(a).withdrawToken(0, await MOCK.getAddress(), x.address, E(1)), "not operating key"), "governor's own wallet can't withdraw (needs operating key)");
  await w(CT.connect(key).withdrawToken(0, await MOCK.getAddress(), x.address, E(50)));
  ok(await reverts(async () => CT.connect(key).withdrawToken(0, await MOCK.getAddress(), x.address, E(1)), "over 5% free allowance"), "5% (50 of 1,000) per term, then blocked");
  ok((await CT.freeAllowanceLeft(0, await MOCK.getAddress())) === 0n, "allowance view shows 0 left");
}

console.log("Treasury: sealed-bid auction with claim-your-own refunds");
{
  const { IT, RA, GOV, CT, cits } = await system(6);
  const [g, key, a, b, c] = cits;
  const MOCK = await deploy("MockERC20", "MOCK"); const mock = await MOCK.getAddress();
  await w(RA.listCompany(0, "Co", 2, 3600)); await round(RA, 0, [[g, 1]]); await elect(GOV, 0, g); await w(GOV.connect(g).setOperatingKey(0, key.address));
  await w(MOCK.mint(g.address, E(1000))); await w(MOCK.connect(g).approve(await CT.getAddress(), ethers.MaxUint256)); await w(CT.connect(g).depositToken(0, mock, E(1000)));
  await w(CT.connect(key).openTreasuryAuction(0, mock, E(500)));
  const salt = ethers.id("salt");
  await w(CT.connect(a).commitBid(0, await CT.commitHashFor(0, E(30), salt, a.address)));
  await w(CT.connect(b).commitBid(0, await CT.commitHashFor(0, E(50), salt, b.address)));
  await w(CT.connect(c).commitBid(0, await CT.commitHashFor(0, E(80), salt, c.address)));
  await warp(2 * DAY + 1);
  ok(await reverts(async () => CT.connect(a).revealBid(0, E(31), salt), "hash mismatch"), "can't reveal a different amount");
  await w(CT.connect(a).revealBid(0, E(30), salt)); await w(CT.connect(b).revealBid(0, E(50), salt)); // c never reveals
  await warp(1 * DAY + 1);
  const capBefore = (await RA.companies(0)).capital;
  const st = await w(CT.settleTreasuryAuction(0));
  ok((await RA.companies(0)).capital === capBefore + E(60), "settle credits winning bid (50) + c's forfeited deposit (10) to capital");
  console.log(`     settle gas: ${st.gasUsed} (constant, no bidder loop)`);
  const balA = await IT.balanceOf(a.address);
  await w(CT.connect(a).claimTreasuryAuction(0)); await w(CT.connect(b).claimTreasuryAuction(0));
  ok((await IT.balanceOf(a.address)) === balA + E(40), "loser claims deposit + bid back (40)");
  ok((await MOCK.balanceOf(b.address)) === E(500), "winner claims the 500 auctioned tokens");
  ok(await reverts(async () => CT.connect(c).claimTreasuryAuction(0), "nothing to claim"), "non-revealer has nothing to claim");
  ok(await reverts(async () => CT.connect(b).claimTreasuryAuction(0), "already claimed"), "no double claim");
  ok(await ctInvariant(IT, CT, 0n), "treasury holds exactly 0 INVEST after everyone claimed");
  ok((await CT.companyTokenBalance(0, mock)) === E(500), "company keeps the 500 tokens it didn't auction");
}

console.log("Treasury: vendor payments need a 20% quorum");
{
  const { RA, GOV, CT, cits } = await system(6);
  const [g, key, h1, h2, vendor] = cits;
  const MOCK = await deploy("MockERC20", "MOCK"); const mock = await MOCK.getAddress();
  await w(RA.listCompany(0, "Co", 10, 3600));
  await round(RA, 0, [[g, 1], [h1, 5], [h2, 4]]); // g 1, h1 5, h2 4 = 10 shares
  await elect(GOV, 0, g, [g, h1]); await w(GOV.connect(g).setOperatingKey(0, key.address));
  await w(MOCK.mint(h1.address, E(1000))); await w(MOCK.connect(h1).approve(await CT.getAddress(), ethers.MaxUint256)); await w(CT.connect(h1).depositToken(0, mock, E(1000)));
  await w(CT.connect(key).proposeVendorPayment(0, mock, vendor.address, E(300)));
  await w(CT.connect(g).voteVendorPayment(0, true)); // governor alone: 1 of 10 = 10% turnout
  await warp(3 * DAY + 1); await w(CT.executeVendorPayment(0));
  ok((await MOCK.balanceOf(vendor.address)) === 0n && (await CT.companyTokenBalance(0, mock)) === E(1000), "governor voting alone (10%) fails quorum; funds return (v5 would have paid)");
  await w(CT.connect(key).proposeVendorPayment(0, mock, vendor.address, E(300)));
  await w(CT.connect(g).voteVendorPayment(1, true)); await w(CT.connect(h2).voteVendorPayment(1, true)); // 5 of 10 = 50% turnout, all yes
  await warp(3 * DAY + 1); await w(CT.executeVendorPayment(1));
  ok((await MOCK.balanceOf(vendor.address)) === E(300), "50% turnout, 100% yes: vendor paid");
  await w(CT.connect(key).proposeVendorPayment(0, mock, vendor.address, E(100)));
  await w(CT.connect(g).voteVendorPayment(2, true)); await w(CT.connect(h1).voteVendorPayment(2, false)); // 1 yes vs 5 no
  await warp(3 * DAY + 1); await w(CT.executeVendorPayment(2));
  ok((await MOCK.balanceOf(vendor.address)) === E(300), "quorum met but majority says no: not paid");
}

console.log("Treasury: end-of-term dividend with a record date");
{
  const { IT, RA, GOV, CT, cits } = await system(5);
  const [a, b, c] = cits;
  await w(RA.listCompany(0, "Co", 10, 3600)); await round(RA, 0, [[a, 300], [b, 100]]); // baseline 100: a 3, b 1 = 4 shares, capital 396
  await round(RA, 0, [[c, 100]]); // c 1 share -> 5 issued (50%)
  await elect(GOV, 0, a, [a, b]);
  ok(await reverts(async () => CT.openPolicyVote(0, 1), "term not concluded"), "can't open the dividend vote during the term");
  await warp(30 * DAY + 1);
  await w(CT.openPolicyVote(0, 1));
  const record = await CT.policyRecordDate(0, 1);
  ok(record === await GOV.governorTermEnd(0), "record date = the moment term 1 ended");
  await w(CT.connect(a).votePolicy(0, 1, true)); await w(CT.connect(c).votePolicy(0, 1, false));
  // after the record date, a moves all 3 shares to b
  for (let t = 0; t < 3; t++) await w(RA.connect(a).transferFrom(a.address, b.address, t));
  await warp(3 * DAY + 1);
  const cap = (await RA.companies(0)).capital;
  await w(CT.resolvePolicyVote(0, 1));
  const pool = cap / 100n;
  ok((await CT.dividendRemaining(0, 1)) === pool, `1% of capital set aside (${ethers.formatEther(pool)} INVEST)`);
  const balA = await IT.balanceOf(a.address), balB = await IT.balanceOf(b.address);
  await w(CT.connect(a).claimDividend(0, 1)); await w(CT.connect(b).claimDividend(0, 1)); await w(CT.connect(c).claimDividend(0, 1));
  const gotA = (await IT.balanceOf(a.address)) - balA, gotB = (await IT.balanceOf(b.address)) - balB;
  ok(gotA * 1n === gotB * 3n, "a paid for 3 shares, b for 1 — per record date, not current holdings");
  ok(await reverts(async () => CT.connect(b).claimDividend(0, 1), "already claimed"), "no second claim");
  const left = await CT.dividendRemaining(0, 1);
  ok(left >= 0n && left < 10n, `claims never exceed the pool (dust left: ${left} wei)`);
  ok(await ctInvariant(IT, CT, left), "treasury holds exactly the unclaimed dust");
}

console.log("Treasury: INVEST market");
{
  const { IT, RA, GOV, CT, cits } = await system(4);
  const [g, key, seller] = cits; const buyer = S[50];
  const USD = await deploy("MockERC20", "USD"); const usd = await USD.getAddress();
  await w(CT.setApprovedPaymentToken(usd, true));
  await w(USD.mint(buyer.address, E(1000))); await w(USD.connect(buyer).approve(await CT.getAddress(), ethers.MaxUint256));
  await w(CT.connect(seller).offerInvest(E(100), usd, E(25)));
  await w(CT.connect(buyer).buyInvest(0));
  ok((await IT.balanceOf(buyer.address)) === E(100) && (await USD.balanceOf(seller.address)) === E(25), "non-citizen buys 100 INVEST for 25 USD");
  await w(RA.listCompany(0, "Co", 2, 3600)); await round(RA, 0, [[g, 200]]); await elect(GOV, 0, g); await w(GOV.connect(g).setOperatingKey(0, key.address));
  const cap = (await RA.companies(0)).capital;
  await w(CT.connect(key).governorOfferInvest(0, E(50), usd, E(10)));
  ok((await RA.companies(0)).capital === cap - E(50), "company INVEST offer reserves capital");
  await w(CT.connect(key).cancelInvestOffer(1));
  ok((await RA.companies(0)).capital === cap, "cancelling returns it to capital");
  await w(CT.connect(key).governorOfferInvest(0, E(50), usd, E(10))); await w(CT.connect(buyer).buyInvest(2));
  ok((await CT.companyTokenBalance(0, usd)) === E(10), "sale proceeds land in the company's custody balance");
  ok(await ctInvariant(IT, CT, 0n), "treasury holds 0 INVEST with no open offers");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
