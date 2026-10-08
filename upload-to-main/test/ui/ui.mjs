// Drives the real built site in Chromium against the local chain.
import { chromium } from "playwright";
import { ethers } from "ethers";
import fs from "fs";
const SP = process.env.SP;
const ART = process.env.ART;
const st = JSON.parse(fs.readFileSync("state.json"));
const P = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
const abi = (n) => JSON.parse(fs.readFileSync(`${ART}/${n}.abi.json`));
const RA = new ethers.Contract(st.addresses.RoundAuction, abi("RoundAuction"), P);
const GOV = new ethers.Contract(st.addresses.Governance, abi("Governance"), P);
const CT = new ethers.Contract(st.addresses.CompanyTreasury, abi("CompanyTreasury"), P);
const IT = new ethers.Contract(st.addresses.InvestToken, abi("InvestToken"), P);
const GEL = new ethers.Contract(st.gel, abi("MockERC20"), P);
const E = (n) => ethers.parseEther(String(n));
const SHOTS = `${SP}/shots`; fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); c ? pass++ : fail++; };
const problems = [];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

async function openAs(account) {
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 } });
  page.on("pageerror", (e) => problems.push(`[${account.slice(0, 6)}] page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`[${account.slice(0, 6)}] console: ${m.text().slice(0, 200)}`); });
  // Stand-in for MetaMask: forwards requests to the local chain, whose dev
  // accounts are unlocked. Also aligns the page clock with the chain clock
  // (the setup fast-forwarded the chain by a few days).
  await page.addInitScript(({ account, offsetMs }) => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + offsetMs;
    window.ethereum = {
      isMetaMask: true,
      on() {}, removeListener() {},
      async request({ method, params }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: (window.__rpcId = (window.__rpcId || 0) + 1), method, params: params || [] }) });
        const j = await r.json();
        if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
        return j.result;
      },
    };
  }, { account, offsetMs: st.offsetMs });
  await page.goto("http://127.0.0.1:4173/live");
  await page.getByText("CONNECT REAL WALLET").click();
  try {
    await page.getByText("Round Auctions").waitFor({ timeout: 20000 });
  } catch (e) {
    await page.screenshot({ path: `${SHOTS}/fail-connect.png`, fullPage: true });
    console.log("PAGE TEXT:\n" + (await page.locator("body").innerText()).slice(0, 2500));
    console.log("PROBLEMS:\n" + problems.join("\n"));
    throw e;
  }
  await page.getByText("Georgian Railway").waitFor({ timeout: 20000 });
  return page;
}
const card = (page, name) => page.locator(`xpath=//div[contains(@class,'zilla') and normalize-space(text())='${name}']/ancestor::div[2]`);
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };

// ------------------------------------------------------------- new citizen
console.log("As a brand-new wallet (REDEPLOY_V8 step 15)");
{
  const npage = await openAs(st.newbie);
  ok(!(await IT.verifiedCitizen(st.newbie)), "starts unverified");
  await npage.getByText("VERIFY THIS WALLET (REAL TRANSACTION)").click();
  await npage.getByText("CLAIM 1000 INVEST (REAL TRANSACTION)").waitFor({ timeout: 20000 });
  ok(await IT.verifiedCitizen(st.newbie), "the page's verify button made it a citizen (via OpenVerifier)");
  await npage.getByText("CLAIM 1000 INVEST (REAL TRANSACTION)").click();
  await npage.getByText("Claimed for real.").waitFor({ timeout: 20000 });
  ok((await IT.balanceOf(st.newbie)) === E(1000), "the page's claim button delivered 1,000 INVEST");
  ok((await npage.locator("body").innerText()).indexOf("ShareAuction") === -1, "no ShareAuction section or address on the page");
  await npage.screenshot({ path: `${SHOTS}/00-new-citizen.png` });
  await npage.close();
}

// ------------------------------------------------------------- shareholder
console.log("As a shareholder");
const page = await openAs(st.viewer);
await page.screenshot({ path: `${SHOTS}/01-page-top.png` });

const rail = card(page, "Georgian Railway");
await rail.getByText("Your bid: 20 INVEST").waitFor({ timeout: 15000 });
ok(true, "Georgian Railway card shows my existing 20 INVEST bid and what it's worth");
ok(await rail.getByText("2 of 100 active bids").isVisible(), "shows active bids against the 100 limit");

const enguri = card(page, "Enguri Hydropower Plant");
await enguri.getByPlaceholder("INVEST to bid (min. 1)").fill("5");
await enguri.getByRole("button", { name: "Bid" }).click();
await enguri.getByText("Your bid: 5 INVEST").waitFor({ timeout: 20000 });
const eb = await RA.getActiveBids(2);
ok(eb.length === 1 && eb[0].bidder === st.viewer && eb[0].amount === E(5), "bidding through the page placed a real 5 INVEST bid");
await enguri.screenshot({ path: `${SHOTS}/02-auction-card.png` });

const port = card(page, "Batumi Sea Port");
await port.getByText("Read full program").waitFor({ timeout: 15000 });
ok(await port.getByText("Batumi Sea Port should earn its keep").isVisible(), "candidate programs are visible before voting");
await port.getByText("Read full program").click();
ok(await port.getByText("Publish the port's accounts every month").isVisible(), "'Read full program' expands the whole text");
ok(await port.getByText("You can vote with 2 shares").isVisible(), "shows my vote weight from when the round opened (2)");
ok(await port.getByText("Governance · first election").isVisible(), "a company that never had a governor says 'first election', not 'term 0'");
ok(await port.getByText("holds 1 share (").isVisible() && await port.getByText(/^1 vote \(/).isVisible(), "singular forms: '1 share', '1 vote'");
await port.screenshot({ path: `${SHOTS}/03-election-candidates.png` });
const bCard = port.locator("xpath=.//div[contains(text(),'Batumi Sea Port should earn')]/parent::div");
await bCard.getByRole("button", { name: "Vote" }).click();
await port.getByText("You've voted in this round with 2 shares.").waitFor({ timeout: 20000 });
const round = await GOV.governanceRound(3);
ok((await GOV.roundVotes(3, round, st.candidateB)) === 2n, "my vote landed on the chain for the candidate I chose");

const mine = card(page, "Bolnisi Gold Mines");
ok(await mine.getByText(/Governor: 0x/).isVisible(), "company with an elected governor shows them");
await mine.getByRole("button", { name: "Show" }).click();
await mine.getByText("Reinvestable income").waitFor({ timeout: 15000 });
ok(await mine.locator("text=GEL").first().isVisible() && await mine.getByText("700").first().isVisible(), "treasury holdings: 700 GEL (1,000 minus 200 at auction and 100 pending payment)");
ok(!(await mine.getByRole("button", { name: "Governor tools" }).isVisible()), "no governor tools for an ordinary shareholder");
await mine.screenshot({ path: `${SHOTS}/04-treasury-holdings.png` });

await mine.getByRole("button", { name: "Auctions" }).click();
await mine.getByPlaceholder("Your bid in INVEST").fill("25");
await mine.getByRole("button", { name: "Place sealed bid" }).click();
await mine.getByText("Save your reveal code.").waitFor({ timeout: 20000 });
const sb = await CT.treasuryBids(0, st.viewer);
ok(sb.commitHash !== ethers.ZeroHash, "sealed bid committed on chain; reveal code shown to save");
const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("sx-sealed-bid")).length);
ok(saved === 1, "the bid's secret was also saved in the browser");
await mine.screenshot({ path: `${SHOTS}/05-treasury-auction.png` });

await mine.getByRole("button", { name: "Payments" }).click();
await mine.getByRole("button", { name: /Approve \(2 shares\)/ }).click();
await mine.getByText("You've voted on this payment.").waitFor({ timeout: 20000 });
ok((await CT.vendorPayments(0)).yesWeight === 2n, "payment approval recorded on chain with my 2 shares");
await mine.screenshot({ path: `${SHOTS}/06-treasury-payments.png` });

const before = await IT.balanceOf(st.viewer);
const market = page.locator("xpath=//div[contains(@class,'zilla') and normalize-space(text())='INVEST Market']/ancestor::div[2]");
await market.getByRole("button", { name: "Buy" }).click();
await market.getByText("No open offers.").waitFor({ timeout: 20000 });
ok((await IT.balanceOf(st.viewer)) === before + E(50), "bought 50 INVEST on the market through the page");
await market.screenshot({ path: `${SHOTS}/07-market.png` });

// ------------------------------------------------------------- governor
console.log("As the governor's operating key");
const gpage = await openAs(st.key);
const gmine = card(gpage, "Bolnisi Gold Mines");
await gmine.getByText("Acting as governor of Bolnisi Gold Mines").waitFor({ timeout: 20000 });
ok(true, "operating key sees the 'Acting as governor' notice");
await gmine.getByRole("button", { name: "Show" }).click();
await gmine.getByRole("button", { name: "Governor tools" }).click();
const wcard = gmine.locator("xpath=.//div[normalize-space(text())='Withdraw (up to 5% per term)']/parent::div");
await wcard.locator("select").selectOption({ index: 1 }); // 0 = "Choose a token…", 1 = GEL
await wcard.getByText(/You can still withdraw 35 GEL/).waitFor({ timeout: 15000 });
ok(true, "withdraw form shows the remaining 5% allowance (35 of 700 GEL)");
await wcard.getByPlaceholder("0x…").fill(st.cc);
await wcard.locator("input[type=number]").fill("10");
const gelBefore = await GEL.balanceOf(st.cc);
await wcard.getByRole("button", { name: "Withdraw" }).click();
ok(await until(async () => (await GEL.balanceOf(st.cc)) === gelBefore + E(10)), "governor withdrew 10 GEL through the page");
await wcard.getByText(/You can still withdraw 25 GEL/).waitFor({ timeout: 15000 });
ok(true, "remaining allowance refreshes after the withdrawal (35 -> 25)");
await wcard.getByPlaceholder("0x…").fill(st.cc);
await wcard.locator("input[type=number]").fill("30");
await wcard.getByRole("button", { name: "Withdraw" }).click();
await wcard.getByText(/more than the 5% you can withdraw/).waitFor({ timeout: 15000 });
ok(true, "going over the 5% limit shows a readable explanation");
await gmine.screenshot({ path: `${SHOTS}/08-governor-tools.png` });

await browser.close();
console.log(problems.length ? `\nBrowser problems:\n  ${problems.join("\n  ")}` : "\nNo page errors or console errors.");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail || problems.length ? 1 : 0);
