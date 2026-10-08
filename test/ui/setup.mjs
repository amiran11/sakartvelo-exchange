// Deploys v8 on a local chain and builds a realistic state for the browser test.
import { ethers } from "ethers";
import fs from "fs";
const ART = process.env.ART;
const art = (n) => JSON.parse(fs.readFileSync(`${ART}/${n}.art.json`));
const P = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1, pollingInterval: 50 });
const E = (n) => ethers.parseEther(String(n));
const w = async (p) => (await p).wait();
const warp = async (s) => { await P.send("evm_increaseTime", [s]); await P.send("evm_mine", []); };
const S = await Promise.all((await P.listAccounts()).map((a) => P.getSigner(a.address)));
const [owner, A, B, Cc, KEY, V, D, NEWBIE] = S;
const deploy = async (n, ...a) => { const c = await new ethers.ContractFactory(art(n).abi, art(n).bytecode, owner).deploy(...a); await c.waitForDeployment(); return c; };

const IT = await deploy("InvestToken", 1000);
const it = await IT.getAddress();
const RA = await deploy("RoundAuction", it);
const GOV = await deploy("Governance", await RA.getAddress());
const CT = await deploy("CompanyTreasury", it, await RA.getAddress(), await GOV.getAddress());
const OV = await deploy("OpenVerifier", it);
const GEL = await deploy("MockERC20", "GEL");
const [ra, ct, gel] = [await RA.getAddress(), await CT.getAddress(), await GEL.getAddress()];
await w(RA.setGovernance(await GOV.getAddress())); await w(RA.setTreasury(ct));
await w(IT.setAuthorizedSink(ra, true)); await w(IT.setAuthorizedSink(ct, true)); await w(IT.setRoundAuctionForTradability(ra));
await w(IT.setVerifier(await OV.getAddress(), true)); // as in REDEPLOY_V8 step 8
await w(CT.setApprovedPaymentToken(gel, true));

const cits = [A, B, Cc, V, D];
await w(IT.setVerifiedCitizens(cits.map((s) => s.address), true));
for (const s of cits) { await w(IT.connect(s).claim()); await w(IT.connect(s).approve(ra, ethers.MaxUint256)); await w(IT.connect(s).approve(ct, ethers.MaxUint256)); }
const settle = async (id) => { const c = await RA.companies(id); const now = (await P.getBlock("latest")).timestamp; if (Number(c.roundEnd) > now) await warp(Number(c.roundEnd) - now + 1); await w(RA.settleRound(id)); };

// Company 0: sold past 50%, governor elected, treasury in use.
await w(RA.listCompany(0, "Bolnisi Gold Mines", 10, 3600));
// Company 3: past 50%, candidates declared, voting open (V can vote).
await w(RA.listCompany(3, "Batumi Sea Port", 10, 3600));
for (const [s, amt] of [[A, 30], [B, 10], [V, 15]]) await w(RA.connect(s).placeBid(0, E(amt)));
for (const [s, amt] of [[B, 40], [D, 20], [V, 40]]) await w(RA.connect(s).placeBid(3, E(amt))); // 2 + 1 + 2 = 5 of 10
await settle(0); await settle(3);

await w(GOV.connect(A).declareCandidacy(0, "Keep the mine running."));
await w(GOV.connect(B).declareCandidacy(0, "Pay dividends."));
await warp(2); await w(GOV.openGovernanceVote(0));
await w(GOV.connect(A).vote(0, A.address)); await w(GOV.connect(V).vote(0, A.address)); await w(GOV.connect(B).vote(0, B.address));
await warp(3 * 86400 + 1); await w(GOV.tallyRound(0));
await w(GOV.connect(A).setOperatingKey(0, KEY.address));
await w(owner.sendTransaction({ to: KEY.address, value: E(0.01) }));

const longProgram = [
  "Batumi Sea Port should earn its keep before it pays anyone.",
  "",
  "1. Publish the port's accounts every month, on-chain, so every shareholder can check them.",
  "2. Sell the idle container cranes through a sealed-bid auction and put the proceeds into Georgian Railway, which moves our cargo.",
  "3. No dividend in my first term. From the second term on, propose a dividend whenever capital grows more than 5% in a term.",
  "4. Any payment above the 5% limit goes to a shareholder vote with a full invoice attached.",
].join("\n");
await w(GOV.connect(B).declareCandidacy(3, longProgram));
await w(GOV.connect(D).declareCandidacy(3, "Lower port fees to win traffic from Poti. Reinvest everything until volumes double."));
await warp(2); await w(GOV.openGovernanceVote(3));
await w(GOV.connect(D).vote(3, D.address));

// Treasury activity on company 0.
await w(GEL.mint(Cc.address, E(1000))); await w(GEL.connect(Cc).approve(ct, E(1000))); await w(CT.connect(Cc).depositToken(0, gel, E(1000)));
await w(CT.connect(KEY).openTreasuryAuction(0, gel, E(200)));
await w(CT.connect(KEY).proposeVendorPayment(0, gel, Cc.address, E(100)));

// INVEST market: B sells 50 INVEST for 20 GEL; the viewer has GEL to buy with.
await w(CT.connect(B).offerInvest(E(50), gel, E(20)));
await w(GEL.mint(V.address, E(100)));

// Companies with open rounds, listed last so their rounds are still open.
await w(RA.listCompany(1, "Georgian Railway", 1000, 7200));
await w(RA.listCompany(2, "Enguri Hydropower Plant", 100000, 7200));
await w(RA.connect(A).placeBid(1, E(50))); await w(RA.connect(V).placeBid(1, E(20)));

const chainNow = (await P.getBlock("latest")).timestamp;
fs.writeFileSync("state.json", JSON.stringify({
  addresses: { InvestToken: it, RoundAuction: ra, Governance: await GOV.getAddress(), CompanyTreasury: ct, OpenVerifier: await OV.getAddress() },
  gel, newbie: NEWBIE.address, viewer: V.address, key: KEY.address, candidateB: B.address, cc: Cc.address,
  offsetMs: chainNow * 1000 - Date.now(),
}, null, 2));
console.log("setup done; chain is", Math.round((chainNow * 1000 - Date.now()) / 3600000), "hours ahead of wall clock");
