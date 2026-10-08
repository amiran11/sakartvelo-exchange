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
async function reverts(fn, text) { try { const tx = await fn(); await tx.wait(); return false; } catch (e) { const m = e.shortMessage + " " + (e.info?.error?.message || "") + " " + (e.reason || ""); if (m.includes(text)) return true; console.log("     got:", m.slice(0, 160)); return false; } }
const accts = await P.listAccounts();
const S = await Promise.all(accts.map((a) => P.getSigner(a.address)));
const owner = S[0];
const deploy = async (n, ...args) => { const f = new ethers.ContractFactory(art(n).abi, art(n).bytecode, owner); const c = await f.deploy(...args); await c.waitForDeployment(); return c; };

async function fresh() {
  const IT = await deploy("InvestToken", 1000);
  const RA = await deploy("RoundAuction", await IT.getAddress());
  const GOV = await deploy("MockGovernance");
  const ra = await RA.getAddress();
  await (await IT.setAuthorizedSink(ra, true)).wait();
  await (await IT.setAuthorizedSink(owner.address, true)).wait(); // owner plays "treasury" in tests
  await (await IT.setRoundAuctionForTradability(ra)).wait();
  await (await RA.setGovernance(await GOV.getAddress())).wait();
  await (await RA.setTreasury(owner.address)).wait();
  return { IT, RA, GOV, ra };
}
async function citizens(IT, ra, list) {
  await (await IT.setVerifiedCitizens(list.map((s) => s.address), true)).wait();
  for (const s of list) { await (await IT.connect(s).claim()).wait(); await (await IT.connect(s).approve(ra, ethers.MaxUint256)).wait(); }
}
// INVEST held by RoundAuction must equal everything it owes: capital + reinvest + host fees + active bids
async function invariant(IT, RA, ids) {
  let owed = await RA.hostFeeAccrued();
  for (const id of ids) {
    const c = await RA.companies(id); owed += c.capital + (await RA.reinvestableIncome(id));
    for (const b of await RA.getActiveBids(id)) owed += b.amount;
  }
  return (await IT.balanceOf(await RA.getAddress())) === owed;
}
const closeRound = async (RA, id) => { const c = await RA.companies(id); const t = await now(); if (Number(c.roundEnd) > t) await warp(Number(c.roundEnd) - t + 1); };
const settle = async (RA, id, gas = 32_000_000) => { await closeRound(RA, id); return (await RA.settleRound(id, { gasLimit: gas })).wait(); };

// ---------------------------------------------------------------
console.log("Size");
{ const code = await P.getCode(await (await fresh()).RA.getAddress()); ok((code.length - 2) / 2 <= 24576, `deploys under the 24,576-byte limit (${(code.length - 2) / 2} bytes)`); }

console.log("Proportional allocation and accounting");
{
  const { IT, RA, ra } = await fresh(); const [a, b, c] = S.slice(1, 4); await citizens(IT, ra, [a, b, c]);
  await (await RA.listCompany(0, "Co", 100, 3600)).wait();
  await (await RA.connect(a).placeBid(0, E(30))).wait();
  await (await RA.connect(b).placeBid(0, E(10))).wait();
  await (await RA.connect(c).placeBid(0, E(25))).wait();
  await settle(RA, 0);
  ok((await RA.companyShareCount(0, a.address)) === 3n && (await RA.companyShareCount(0, b.address)) === 1n && (await RA.companyShareCount(0, c.address)) === 3n, "entitlements 30/10=3, 10/10=1, ceil(25/10)=3");
  const co = await RA.companies(0);
  ok(co.sharesIssued === 7n && co.capital === E(65) * 99n / 100n && (await RA.hostFeeAccrued()) === E(65) / 100n, "7 shares issued, 99% to capital, 1% host fee");
  ok((await RA.activeBidCount(0)) === 0n, "all three bids filled and removed");
  ok(await invariant(IT, RA, [0]), "INVEST held == INVEST owed");
  ok((await RA.shareOrdinal(6)) === 7n && (await RA.shareCompany(6)) === 0n, "packed share info reads back correctly");
  const tokenUri = await RA.tokenURI(0); ok(tokenUri.startsWith("data:application/json;base64,"), "on-chain metadata still renders");
}

console.log("One active bid per wallet; cap counts active bids only");
{
  const { IT, RA, ra } = await fresh(); const cits = S.slice(1, 103); await citizens(IT, ra, cits);
  await (await RA.listCompany(0, "Co", 1_000_000, 3 * DAY)).wait();
  await (await RA.connect(cits[0]).placeBid(0, E(5))).wait();
  ok(await reverts(() => RA.connect(cits[0]).placeBid(0, E(5)), "already have active bid"), "second active bid from same wallet rejected");
  for (let i = 1; i < 100; i++) await (await RA.connect(cits[i]).placeBid(0, E(1 + (i % 7)))).wait();
  ok(await reverts(() => RA.connect(cits[100]).placeBid(0, E(1)), "active bid cap reached"), "101st active bid rejected");
  const r = await settle(RA, 0);
  console.log(`     settle with 100 mixed bids: ${(Number(r.gasUsed) / 1e6).toFixed(2)}M gas`);
  const left = await RA.activeBidCount(0);
  ok(left < 100n, `filled bids free their slots (${left} still active)`);
  await (await RA.connect(cits[100]).placeBid(0, E(1))).wait();
  ok(true, "new bidder accepted after settlement");
  let total = 101; // lifetime bids keep going past the old 500 lifetime cap
  for (let round = 0; round < 6; round++) {
    await settle(RA, 0);
    for (const s of cits) { if ((await RA.activeBidSlot(0, s.address)) === 0n && (await RA.activeBidCount(0)) < 100n && (await IT.balanceOf(s.address)) >= E(1)) { await (await RA.connect(s).placeBid(0, E(1))).wait(); total++; } }
  }
  ok(total > 500, `company keeps taking bids over its lifetime (${total} bids placed)`);
  ok(await invariant(IT, RA, [0]), "INVEST held == INVEST owed after many rounds");
}

console.log("Carry-forward and sellout refunds");
{
  const { IT, RA, ra } = await fresh(); const [a, b, c, d] = S.slice(1, 5); await citizens(IT, ra, [a, b, c, d]);
  await (await RA.listCompany(0, "Co", 5, 3600)).wait();
  await (await RA.connect(a).placeBid(0, E(500))).wait();  // entitlement 250 > 5
  await (await RA.connect(b).placeBid(0, E(4))).wait();    // ceil(4/2) = 2
  await (await RA.connect(c).placeBid(0, E(2))).wait();    // baseline, 1
  await settle(RA, 0);
  const aBid = (await RA.getActiveBids(0)).find((x) => x.bidder === a.address);
  ok(aBid && aBid.amount === E(500) && (await RA.activeBidCount(0)) === 1n, "oversized bid carries into next round untouched");
  ok((await RA.companies(0)).sharesIssued === 3n, "the bids that fit were filled (3 shares)");
  // round 2: a alone -> baseline 500, entitlement 1 -> fills; then d's bid with 1 share left
  await (await RA.connect(d).placeBid(0, E(500))).wait();
  const balD = await IT.balanceOf(d.address);
  await settle(RA, 0); // a (earlier) and d both ent 1, 2 shares left -> both fill, sold out
  ok((await RA.companies(0)).finalized && (await RA.companyShareCount(0, d.address)) === 1n, "equal bids both fill when shares allow");
  await (await RA.listCompany(1, "Co2", 1, 3600)).wait();
  await (await RA.connect(b).placeBid(1, E(10))).wait();
  await (await RA.connect(c).placeBid(1, E(10))).wait();   // tie: earlier bid (b) wins
  const balC = await IT.balanceOf(c.address);
  await settle(RA, 1);
  ok((await RA.companyShareCount(1, b.address)) === 1n && (await IT.balanceOf(c.address)) === balC + E(10), "tie goes to earliest bid; the other is refunded in full at sellout");
  ok(await invariant(IT, RA, [0, 1]), "INVEST held == INVEST owed");
}

console.log("Corporate investment, compensation and refunds");
{
  const { IT, RA, GOV, ra } = await fresh(); const cits = S.slice(1, 6); await citizens(IT, ra, cits);
  const [gov, key] = S.slice(30, 32);
  await (await RA.listCompany(0, "Origin", 1000, 3600)).wait();
  await (await RA.listCompany(1, "Target", 150, 3600)).wait();
  await (await GOV.set(0, gov.address, key.address, (await now()) + 30 * DAY, 1)).wait();
  // treasury (owner) credits real reinvestable income: tokens first, then the ledger call
  await (await IT.setVerifiedCitizen(owner.address, true)).wait(); await (await IT.claim()).wait();
  await (await IT.transfer(ra, E(400))).wait(); await (await RA.addReinvestableIncome(0, E(400))).wait();
  ok(await reverts(() => RA.connect(cits[0]).invest(0, 1, E(100)), "not operating key"), "only the operating key can invest");
  await (await RA.connect(key).invest(0, 1, E(300))).wait();
  await (await RA.connect(cits[0]).placeBid(1, E(2))).wait(); // baseline 2 -> corp ent 150 fits? 150 + 1 > 150...
  await settle(RA, 1);
  const corp = await RA.corporateHolder(0);
  const corpShares = await RA.companyShareCount(1, corp), govShares = await RA.companyShareCount(1, gov.address);
  ok(corpShares + govShares === 150n && govShares === 1n, `corporate win of 150 shares: 149 to company, 1 (1%) to governor`);
  ok((await RA.companies(1)).finalized && (await RA.reinvestableIncome(0)) === E(100), "sold out; reinvest pool shows the unspent 100");
  // the citizen's 2 INVEST bid didn't fit -> refunded; now test corporate refund at sellout
  await (await RA.listCompany(2, "T2", 1, 3600)).wait();
  await (await RA.connect(cits[1]).placeBid(2, E(50))).wait();
  await (await RA.connect(key).invest(0, 2, E(50))).wait(); // equal amount, later seq -> loses tie, refunded at sellout
  await settle(RA, 2);
  ok((await RA.reinvestableIncome(0)) === E(100), "losing corporate bid refunded into reinvestable income, not to a keyless address");
  const lockedToken = (await RA.nextTokenId()) - 1n;
  ok(await invariant(IT, RA, [0, 1, 2]), "INVEST held == INVEST owed with corporate flows");
  // compensation lock: governor's share can't move until origin term >= 3
  await warp(8 * DAY);
  let govToken = null; for (let t = 0n; t < await RA.nextTokenId(); t++) { if ((await RA.ownerOf(t)) === gov.address) { govToken = t; break; } }
  ok(await reverts(() => RA.connect(gov).transferFrom(gov.address, cits[2].address, govToken), "comp shares locked"), "compensation share locked during term 1");
  await (await GOV.set(0, gov.address, key.address, (await now()) + 30 * DAY, 3)).wait();
  await (await RA.connect(gov).transferFrom(gov.address, cits[2].address, govToken)).wait();
  ok((await RA.ownerOf(govToken)) === cits[2].address, "unlocks once origin company reaches term 3");
}

console.log("Share market");
{
  const { IT, RA, ra } = await fresh(); const [a, b, c, d] = S.slice(1, 5); await citizens(IT, ra, [a, b, c, d]);
  await (await RA.listCompany(0, "Co", 10, 3600)).wait();
  await (await RA.connect(a).placeBid(0, E(2))).wait();
  await settle(RA, 0);
  ok(await reverts(() => RA.connect(a).listShare(0, E(5)), "still locked"), "can't list during lock period");
  await warp(8 * DAY);
  await (await RA.connect(a).listShare(0, E(5))).wait();  // listing 0
  await (await RA.connect(a).listShare(0, E(6))).wait();  // duplicate listing 1
  await (await RA.connect(b).buyShare(0)).wait();
  ok((await RA.ownerOf(0)) === b.address, "first buyer gets the share");
  ok(await reverts(() => RA.connect(c).buyShare(1), "seller no longer owns share"), "duplicate listing can't take it from the first buyer (v7 allowed this)");
  await (await RA.connect(b).listShare(0, E(7))).wait();  // listing 2
  await (await RA.connect(b).transferFrom(b.address, d.address, 0)).wait();
  ok(await reverts(() => RA.connect(c).buyShare(2), "seller no longer owns share"), "stale listing after a transfer can't be bought (v7 allowed this)");
  ok((await RA.companyShareCount(0, d.address)) === 1n && (await RA.companyShareCount(0, b.address)) === 0n, "share counts follow transfers");
}

console.log("Balance history (for snapshot votes and dividends)");
{
  const { IT, RA, ra } = await fresh(); const [a, b] = S.slice(1, 3); await citizens(IT, ra, [a, b]);
  await (await RA.listCompany(0, "Co", 10, 3600)).wait();
  await (await RA.connect(a).placeBid(0, E(3))).wait();
  await settle(RA, 0);
  const t1 = await now(); await warp(8 * DAY);
  await (await RA.connect(a).transferFrom(a.address, b.address, 0)).wait(); const t2 = await now(); await warp(10);
  ok((await RA.shareCountAt(0, a.address, t1)) === 1n && (await RA.shareCountAt(0, b.address, t1)) === 0n, "balances as of an earlier moment are preserved");
  ok((await RA.shareCountAt(0, a.address, t2)) === 0n && (await RA.shareCountAt(0, b.address, t2)) === 1n, "and reflect the transfer afterwards");
  ok((await RA.sharesIssuedAt(0, t1)) === 1n && (await RA.sharesIssuedAt(0, t1 - 4000)) === 0n, "issued-share history recorded per settlement");
}

console.log("Admin wiring is one-time");
{
  const { RA } = await fresh();
  ok(await reverts(() => RA.setTreasury(S[5].address), "treasury already set"), "treasury can't be redirected");
  ok(await reverts(() => RA.setGovernance(S[5].address), "governance already set"), "governance can't be redirected");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
