// Drives the SITE'S OWN web3.js against freshly deployed v8 contracts.
import { ethers } from "ethers";
import fs from "fs";
const ART = process.env.ART;
const art = (n) => JSON.parse(fs.readFileSync(`${ART}/${n}.art.json`));
const P = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1, polling: true, pollingInterval: 50 });
const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); c ? pass++ : fail++; };
const warp = async (s) => { await P.send("evm_increaseTime", [s]); await P.send("evm_mine", []); };
const w = async (p) => (await p).wait();
const S = await Promise.all((await P.listAccounts()).map((a) => P.getSigner(a.address)));
const owner = S[0];
const deploy = async (n, ...a) => { const c = await new ethers.ContractFactory(art(n).abi, art(n).bytecode, owner).deploy(...a); await c.waitForDeployment(); return c; };

// --- deploy + wire exactly as REDEPLOY_V8.md ---
const IT = await deploy("InvestToken", 1000);
const RA = await deploy("RoundAuction", await IT.getAddress());
const GOV = await deploy("Governance", await RA.getAddress());
const CT = await deploy("CompanyTreasury", await IT.getAddress(), await RA.getAddress(), await GOV.getAddress());
const MOCK = await deploy("MockERC20", "GEL");
const [ra, ct, gov] = [await RA.getAddress(), await CT.getAddress(), await GOV.getAddress()];
await w(RA.setGovernance(gov)); await w(RA.setTreasury(ct));
await w(IT.setAuthorizedSink(ra, true)); await w(IT.setAuthorizedSink(ct, true)); await w(IT.setRoundAuctionForTradability(ra));
await w(RA.listCompany(0, "Bolnisi Gold Mines", 10, 3600));
await w(RA.listCompany(1, "Georgian Railway", 1000, 3600));
const cits = S.slice(1, 8);
await w(IT.setVerifiedCitizens(cits.map((s) => s.address), true));
for (const s of cits) await w(IT.connect(s).claim());

globalThis.__ENV__ = { VITE_NETWORK: "local", VITE_LOCAL_ADDRESSES: JSON.stringify({ InvestToken: await IT.getAddress(), RoundAuction: ra, Governance: gov, CompanyTreasury: ct }) };
const W = await import("./web3.bundle.mjs");
const [a, b, c, key, buyer] = cits;

console.log("Auction");
{
  const companies = await W.getListedRoundCompanies(P);
  ok(companies.length === 2 && companies[0].name === "Bolnisi Gold Mines" && companies[0].capital === 0n, "reads both listed companies, including capital");
  const rules = await W.getRoundAuctionRules(P);
  ok(rules.maxActiveBids === 100n && rules.maxSharesPerRound === 300n && rules.minBid === E(1), "reads auction limits from the contract (100 bids, 300 shares, 1 INVEST)");
  await W.approveInvestForRound(a, ethers.MaxUint256);
  await W.placeRoundBid(a, 0, E(30));
  try { await W.placeRoundBid(a, 0, E(5)); ok(false, "second bid rejected"); }
  catch (e) { ok(W.friendlyError(e).startsWith("You already have an active bid"), `second bid rejected with a readable message: "${W.friendlyError(e).slice(0, 45)}…"`); }
  for (const s of [b, c]) { await W.approveInvestForRound(s, ethers.MaxUint256); await W.placeRoundBid(s, 0, E(10)); }
  const bids = await W.getRoundBids(0, P);
  ok(bids.length === 3 && bids[0].bidder === a.address && bids[0].amount === E(30), "active bids come straight from the contract");
  await warp(3601);
  await W.settleRoundReal(b, 0); // gas margin path
  const co = (await W.getListedRoundCompanies(P))[0];
  ok(co.sharesIssued === 5n && (await W.getRoundBids(0, P)).length === 0, "settled through the site helper: 5 shares issued, bids cleared");
  ok((await W.getMyShareCount(0, a.address, P)) === 3n, "share count read for Governance-mode companies");
}

console.log("Election");
{
  const rules = await W.getElectionRules(P);
  ok(rules.maxCandidates === 20n && rules.minStakeBps === 10n, "reads election limits (20 candidates, 0.1% stake)");
  await W.declareCandidacyReal(a, 0, "Reinvest mine income into rail; quarterly reports.");
  await W.declareCandidacyReal(b, 0, "Pay dividends every term.");
  let cands = await W.getCandidates(0, P);
  ok(cands.length === 2 && cands[0].program.startsWith("Reinvest") && cands[0].stake === 3n && cands[1].stake === 1n, "candidates listed with their full programs and share stakes");
  await warp(2);
  await W.openGovernanceVoteReal(c, 0);
  const g = await W.getCompanyGovernance(0, P);
  ok(g.round === 1n && g.snapshot > 0n, "governance state includes the round's balance snapshot");
  ok((await W.getMyVoteWeight(0, a.address, g, P)) === 3n, "vote weight = shares held when the round opened");
  try { await W.declareCandidacyReal(c, 0, "late"); ok(false, "late candidacy"); }
  catch (e) { ok(W.friendlyError(e).startsWith("Candidacy is closed"), "late candidacy blocked with a readable message"); }
  await W.voteReal(a, 0, a.address);
  await W.voteReal(b, 0, a.address);
  ok(await W.hasVotedThisRound(0, g.round, a.address, P), "voted flag readable");
  cands = await W.getCandidates(0, P);
  ok(cands.find((x) => x.address === a.address).votes === 4n, "live vote totals shown on candidates");
  await warp(3 * DAY + 1);
  await W.tallyRoundReal(c, 0);
  await W.setOperatingKeyReal(a, 0, key.address);
  const g2 = await W.getCompanyGovernance(0, P);
  ok(g2.governor === a.address && g2.operatingKey === key.address && g2.termNum === 1n, "governor elected and operating key registered via the site helpers");
}

console.log("Treasury: custody and withdrawals");
{
  await w(MOCK.mint(c.address, E(1000)));
  await W.depositTokenReal(c, 0, await MOCK.getAddress(), E(1000)); // approve + deposit
  let t = await W.getCompanyTreasury(0, P);
  ok(t.tokens.length === 1 && t.tokens[0].symbol === "GEL" && t.tokens[0].balance === E(1000) && t.capital > 0n, "treasury overview: GEL 1,000 discovered from deposits, plus INVEST capital");
  ok((await W.getFreeAllowanceLeft(0, await MOCK.getAddress(), P)) === E(50), "free allowance shows 50 (5%)");
  await W.withdrawTokenReal(key, 0, await MOCK.getAddress(), b.address, E(20));
  ok((await W.getFreeAllowanceLeft(0, await MOCK.getAddress(), P)) === E(30), "after withdrawing 20, 30 left");
  try { await W.withdrawTokenReal(key, 0, await MOCK.getAddress(), b.address, E(31)); ok(false, "over allowance"); }
  catch (e) { ok(W.friendlyError(e).startsWith("That's more than the 5%"), "over-allowance blocked with a readable message"); }
  try { await W.withdrawTokenReal(a, 0, await MOCK.getAddress(), b.address, E(1)); ok(false, "own wallet"); }
  catch (e) { ok(W.friendlyError(e).includes("operating key"), "governor's own wallet told to switch to the operating key"); }
}

console.log("Treasury: sealed-bid auction");
{
  await W.openTreasuryAuctionReal(key, 0, await MOCK.getAddress(), E(400));
  let list = await W.getTreasuryAuctions(0, b.address, P);
  ok(list.length === 1 && list[0].amount === E(400) && list[0].token.symbol === "GEL" && !list[0].mine.committed, "auction listed for the company");
  const id = list[0].id;
  const salt = ethers.hexlify(ethers.randomBytes(32));
  ok((await W.computeCommitHash(id, E(25), salt, b.address)) === (await CT.commitHashFor(id, E(25), salt, b.address)), "site's commit hash matches the contract's exactly");
  const codeB = await W.commitTreasuryBidReal(b, id, E(25), list[0].deposit);
  const codeC = await W.commitTreasuryBidReal(c, id, E(40), list[0].deposit);
  ok(W.parseRevealCode(codeB)?.amount === E(25), "reveal code round-trips (amount + secret)");
  ok(W.parseRevealCode("garbage") === null, "a malformed reveal code is rejected");
  list = await W.getTreasuryAuctions(0, b.address, P);
  ok(list[0].mine.committed && list[0].committed === 2n, "my commit and the commit count show up");
  await warp(2 * DAY + 1);
  const pb = W.parseRevealCode(codeB), pc = W.parseRevealCode(codeC);
  await W.revealTreasuryBidReal(b, id, pb.amount, pb.salt);
  await W.revealTreasuryBidReal(c, id, pc.amount, pc.salt);
  await warp(1 * DAY + 1);
  await W.settleTreasuryAuctionReal(a, id);
  const balB = await IT.balanceOf(b.address);
  await W.claimTreasuryAuctionReal(b, id); await W.claimTreasuryAuctionReal(c, id);
  ok((await MOCK.balanceOf(c.address)) === E(400) && (await IT.balanceOf(b.address)) === balB + E(35), "settle + claims: winner gets 400 GEL, loser gets 25 + 10 deposit back");
  list = await W.getTreasuryAuctions(0, c.address, P);
  ok(list[0].settled && list[0].leader === c.address && list[0].mine.claimed, "auction state after settlement reads correctly");
  const t = await W.getCompanyTreasury(0, P);
  ok(t.reinvestableIncome === E(40), "sale proceeds (40) show as reinvestable income");
}

console.log("Treasury: vendor payment");
{
  await W.proposeVendorPaymentReal(key, 0, await MOCK.getAddress(), buyer.address, E(100));
  let vp = await W.getVendorPayments(0, b.address, P);
  ok(vp.length === 1 && vp[0].issued === 5n && vp[0].quorumNeeded === 1n && vp[0].myWeight === 1n, "payment listed with quorum (20% of 5 = 1 share) and my snapshot weight");
  await W.voteVendorPaymentReal(b, vp[0].id, true);
  vp = await W.getVendorPayments(0, b.address, P);
  ok(vp[0].voted && vp[0].yesWeight === 1n && vp[0].passes, "vote recorded; 'would pass' indicator true");
  await warp(3 * DAY + 1);
  await W.executeVendorPaymentReal(a, vp[0].id);
  ok((await MOCK.balanceOf(buyer.address)) === E(100), "executed: vendor paid 100 GEL");
}

console.log("Dividends");
{
  let terms = await W.getDividendTerms(0, a.address, P);
  ok(terms.length === 0, "no dividend rows while term 1 is still running");
  await warp(30 * DAY + 1);
  terms = await W.getDividendTerms(0, a.address, P);
  ok(terms.length === 1 && terms[0].term === 1 && terms[0].voteEnd === 0n && terms[0].myWeight === 3n, "term 1 appears once it ends, with my record-date weight (3)");
  await W.openPolicyVoteReal(c, 0, 1);
  await W.votePolicyReal(a, 0, 1, true);
  await warp(3 * DAY + 1);
  await W.resolvePolicyVoteReal(c, 0, 1);
  terms = await W.getDividendTerms(0, a.address, P);
  ok(terms[0].resolved && terms[0].owed > 0n && !terms[0].claimed, `resolved; I'm owed ${ethers.formatEther(terms[0].owed)} INVEST`);
  const owed = terms[0].owed, bal = await IT.balanceOf(a.address);
  await W.claimDividendReal(a, 0, 1);
  ok((await IT.balanceOf(a.address)) === bal + owed && (await W.getDividendTerms(0, a.address, P))[0].claimed, "claimed exactly what was shown");
}

console.log("INVEST market");
{
  await w(CT.setApprovedPaymentToken(await MOCK.getAddress(), true));
  const toks = await W.getApprovedPaymentTokens(P);
  ok(toks.length === 1 && toks[0].symbol === "GEL", "accepted payment tokens listed (GEL)");
  await W.offerInvestReal(b, E(100), await MOCK.getAddress(), E(30));
  let offers = await W.getInvestOffers(P);
  ok(offers.length === 1 && offers[0].seller === b.address && offers[0].token.symbol === "GEL", "my offer is listed");
  await w(MOCK.mint(buyer.address, E(50)));
  const before = await W.getInvestBalance(buyer.address, P), gelB = await MOCK.balanceOf(b.address);
  await W.buyInvestReal(buyer, offers[0]); // approve GEL + buy
  ok((await W.getInvestBalance(buyer.address, P)) === before + E(100) && (await MOCK.balanceOf(b.address)) === gelB + E(30) && (await W.getInvestOffers(P)).length === 0, "buyer gets 100 INVEST, seller gets 30 GEL; offer disappears");
  await W.offerInvestReal(b, E(10), await MOCK.getAddress(), E(3));
  offers = await W.getInvestOffers(P);
  await W.cancelInvestOfferReal(b, offers[0].id);
  ok((await W.getInvestOffers(P)).length === 0, "cancelling removes the offer");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
