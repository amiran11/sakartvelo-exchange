// Rehearses REDEPLOY_V8.md (from-scratch version) step by step on a local
// chain: same order, same constructor values, same read-back check after
// every transaction. Then a new citizen verifies, claims, bids and gets shares.
import { ethers } from "ethers";
import fs from "fs";
const ART = process.env.ART;
const art = (n) => JSON.parse(fs.readFileSync(`${ART}/${n}.art.json`));
const P = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1, pollingInterval: 50 });
const E = (n) => ethers.parseEther(String(n));
const w = async (p) => (await p).wait();
let step = 0, fail = 0;
const check = (cond, what) => { console.log(`  ${cond ? "CHECK ok " : "CHECK FAIL"} ${what}`); if (!cond) fail++; };
const title = (t) => console.log(`Step ${++step}. ${t}`);
const S = await Promise.all((await P.listAccounts()).map((a) => P.getSigner(a.address)));
const owner = S[0];
const deploy = async (n, ...a) => { const c = await new ethers.ContractFactory(art(n).abi, art(n).bytecode, owner).deploy(...a); const r = await c.deploymentTransaction().wait(); return [c, r.blockNumber]; };
const has = (c, fn) => c.interface.getFunction(fn) !== null;

const MAX_CITIZENS = 1000;
const COMPANIES = JSON.parse(process.env.COMPANIES || "null") || [
  ["Bolnisi Gold Mines", 100], ["Tkibuli Coal", 200], ["Racha Timber", 300], ["Chiatura Manganese", 400], ["Zestafoni Ferroalloys", 500],
  ["Enguri Hydropower Plant", 600], ["Georgian Railway", 700], ["Batumi Sea Port", 800], ["Anaklia Deep Sea Port", 900], ["Georgian Post", 1000],
];
const ROUND_SECONDS = 3600;

title("Deploy InvestToken");
const [IT, firstBlock] = await deploy("InvestToken", MAX_CITIZENS);
const it = await IT.getAddress();
check((await IT.symbol()) === "INVEST" && (await IT.maxCitizens()) === BigInt(MAX_CITIZENS) && (await IT.owner()) === owner.address, `symbol INVEST, maxCitizens ${MAX_CITIZENS}, owner is you (block ${firstBlock})`);

title("Deploy OpenVerifier");
const [OV] = await deploy("OpenVerifier", it);
check((await OV.investToken()) === it, "investToken reads the new InvestToken");

title("Deploy RoundAuction v8");
const [RA] = await deploy("RoundAuction", it);
const ra = await RA.getAddress();
check(has(RA, "getActiveBids") && has(RA, "setGovernance") && has(RA, "shareCountAt"), "v8 functions present (not stale bytecode)");
check((await RA.investToken()) === it, "investToken reads the new InvestToken");

title("Deploy Governance");
const [GOV] = await deploy("Governance", ra);
const gov = await GOV.getAddress();
check((await GOV.shares()) === ra && has(GOV, "lastRoundId"), "shares reads the new RoundAuction");

title("Deploy CompanyTreasury v6");
const [CT] = await deploy("CompanyTreasury", it, ra, gov);
const ct = await CT.getAddress();
check((await CT.investToken()) === it && (await CT.roundAuction()) === ra && (await CT.governance()) === gov, "all three constructor addresses read back");
check(has(CT, "claimTreasuryAuction") && !CT.interface.getFunction("distribute"), "v6: claimTreasuryAuction present, distribute removed");

title("RoundAuction.setGovernance");
await w(RA.setGovernance(gov));
check((await RA.governance()) === gov, "governance reads the new Governance");

title("RoundAuction.setTreasury");
await w(RA.setTreasury(ct));
check((await RA.treasury()) === ct, "treasury reads the new CompanyTreasury");

title("InvestToken.setVerifier(OpenVerifier, true)");
await w(IT.setVerifier(await OV.getAddress(), true));
check(await IT.verifier(await OV.getAddress()), "verifier(OpenVerifier) is true");

title("InvestToken.setAuthorizedSink for RoundAuction and CompanyTreasury");
await w(IT.setAuthorizedSink(ra, true));
await w(IT.setAuthorizedSink(ct, true));
check((await IT.authorizedSink(ra)) && (await IT.authorizedSink(ct)), "both are authorized sinks");

title("InvestToken.setRoundAuctionForTradability");
await w(IT.setRoundAuctionForTradability(ra));
check((await IT.roundAuctionForTradability()) === ra, "points at the new RoundAuction");
check((await IT.auctionHouse()) === ethers.ZeroAddress, "auctionHouse left unset (ShareAuction retired)");

title(`List ${COMPANIES.length} companies`);
for (let i = 0; i < COMPANIES.length; i++) await w(RA.listCompany(i, COMPANIES[i][0], COMPANIES[i][1], ROUND_SECONDS));
check((await RA.companiesListed()) === BigInt(COMPANIES.length), `companiesListed = ${COMPANIES.length}`);
const c9 = await RA.companies(COMPANIES.length - 1);
check(c9.name === COMPANIES.at(-1)[0] && c9.totalShares === BigInt(COMPANIES.at(-1)[1]), "last company reads back with the right name and share count");

console.log("Smoke test: a brand-new citizen");
const [you, other] = [S[1], S[2]];
const notYet = await IT.verifiedCitizen(you.address);
await w(OV.connect(you).verifySelf());
check(!notYet && (await IT.verifiedCitizen(you.address)), "verifySelf on OpenVerifier makes you a verified citizen");
await w(IT.connect(you).claim());
check((await IT.balanceOf(you.address)) === E(1000) && (await IT.citizenCount()) === 1n, "claim gives 1,000 INVEST; citizenCount 1");
try { await w(IT.connect(you).claim()); check(false, "second claim refused"); } catch { check(true, "second claim refused"); }
try { await w(IT.connect(you).transfer(other.address, E(1))); check(false, "closed loop"); } catch { check(true, "INVEST can't be sent to another wallet (closed loop holds)"); }
await w(OV.connect(other).verifySelf()); await w(IT.connect(other).claim());
for (const s of [you, other]) await w(IT.connect(s).approve(ra, ethers.MaxUint256));
await w(RA.connect(you).placeBid(0, E(30)));
await w(RA.connect(other).placeBid(0, E(20)));
await P.send("evm_increaseTime", [ROUND_SECONDS + 1]); await P.send("evm_mine", []);
await w(RA.connect(other).settleRound(0));
check((await RA.companyShareCount(0, you.address)) === 2n && (await RA.balanceOf(you.address)) === 2n, "your 30 INVEST bid against a 20 baseline won 2 share NFTs");
check((await RA.companies(0)).capital === E(50) * 99n / 100n, "company capital = 99% of the 50 INVEST bid");

fs.writeFileSync(process.env.OUT || "rehearsal-addresses.json", JSON.stringify({ firstBlock, InvestToken: it, OpenVerifier: await OV.getAddress(), RoundAuction: ra, Governance: gov, CompanyTreasury: ct }, null, 2));
console.log(`\n${fail === 0 ? "Rehearsal passed" : `${fail} CHECK FAILED`}: ${step} steps.`);
process.exit(fail ? 1 : 0);
