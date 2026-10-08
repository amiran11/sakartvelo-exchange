import { ethers } from "ethers";
import fs from "fs";
const art = (n) => JSON.parse(fs.readFileSync(`./art8/art_${n}.json`));
const P = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
const E = (n) => ethers.parseEther(String(n));
const accts = await P.listAccounts(); const S = await Promise.all(accts.map((a) => P.getSigner(a.address))); const owner = S[0];
const deploy = async (n, ...a) => { const c = await new ethers.ContractFactory(art(n).abi, art(n).bytecode, owner).deploy(...a); await c.waitForDeployment(); return c; };
const IT = await deploy("InvestToken", 1000); const RA = await deploy("RoundAuction", await IT.getAddress()); const ra = await RA.getAddress();
await (await IT.setAuthorizedSink(ra, true)).wait(); await (await IT.setRoundAuctionForTradability(ra)).wait();
const cits = S.slice(1, 101);
await (await IT.setVerifiedCitizens(cits.map((s) => s.address), true)).wait();
for (const s of cits) { await (await IT.connect(s).claim()).wait(); await (await IT.connect(s).approve(ra, ethers.MaxUint256)).wait(); }
const scen = [
  ["W1 100 bids in worst sort order (ascending)", 1_000_000, (i) => E(i + 1)],
  ["W2 300 shares to 100 distinct new holders", 1_000_000, (i) => (i === 0 ? E(1) : E(3))],
  ["W3 sellout refunding 98 of 100 bids", 2, (i) => E(1 + i * 0.01)],
  ["W4 100 equal bids, earliest-first ties", 1_000_000, () => E(2)],
];
let id = 0, worst = 0;
for (const [name, total, amt] of scen) {
  await (await RA.listCompany(id, "x", total, 86400)).wait();
  for (let i = 0; i < 100; i++) await (await RA.connect(cits[i]).placeBid(id, amt(i))).wait();
  await P.send("evm_increaseTime", [86401]); await P.send("evm_mine", []);
  const r = await (await RA.settleRound(id, { gasLimit: 32_000_000 })).wait();
  const g = Number(r.gasUsed) / 1e6; worst = Math.max(worst, g);
  console.log(`${name.padEnd(46)} ${g.toFixed(2)}M gas, ${(await RA.companies(id)).sharesIssued} shares`);
  id++;
}
console.log(`WORST ${worst.toFixed(2)}M of 32M limit (${(100 - worst / 32 * 100).toFixed(0)}% headroom)`);
