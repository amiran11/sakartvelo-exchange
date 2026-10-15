// src/web3.js
//
// The REAL blockchain layer, entirely separate from the simulated game
// in App.jsx. Every chain-specific value flows from the config below.
//
// v8 is a complete fresh deployment (REDEPLOY_V8.md), done on Arbitrum
// One on 8 October 2026: new InvestToken, OpenVerifier, RoundAuction,
// Governance and CompanyTreasury, owned by the site administrator (now via the timelock). ShareAuction
// is retired.
export const NETWORKS = {
  arbitrum: {
    chainIdHex: "0xa4b1", // 42161
    chainName: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://arbiscan.io"],
    label: "Arbitrum One",
    isTestnet: false,
    // From REDEPLOY_V8.md step 14. deploymentBlock = InvestToken's deploy
    // block, the first contract deployed, so no event can be earlier.
    deploymentBlock: 512862832, // InvestToken deploy, 8 Oct 2026
    v9DeploymentBlock: 514727826, // RoundAuctionV9 deploy, 14 Oct 2026
    addresses: {
      InvestToken: "0x99ED3761F8416342D814ad4CCAe81993c2Ab7e4a",
      OpenVerifier: "0x444653dDbBb24B24bcD8D674e30b371800Cc2ad2",
      RoundAuction: "0x9739e5dCcc76BD424BcD12e7f1ce56143e77b796",
      Governance: "0x5668F72F3dB11c4DA6aF682604d1184763bB971d",
      CompanyTreasury: "0xaD50c4726E78a8e8a18a1A188bd60E7ef0A501e8",
      // v9, deployed alongside v8 on 14 October 2026 (DEPLOY_V9.md).
      RoundAuctionV9: "0x65D37C51ec85584222aBA16e6B60B3Cd4BD6090f",
      GovernanceV9: "0x044213A8c8b7C83E6A00cac1BbC8962B4b0Ebe85",
      CompanyTreasuryV9: "0x70ffEeAabAaE49cB969ADC8137A3DeD94c8F1B75",
      CompanyDividendsV9: "0x641f3864F7dcbD6630D21247e8DA123A2A138023",
      OpenVerifierV2: "0xB055dB6E1291Ac08f581D3ce0a48791b4633AD5A",
      SakartveloTimelock: "0xBD357971d9935c68c39a2B7e4Fbf33ffC23adF6f",
    },
  },
};

// Local test chain (anvil), used only when the site is built with
// VITE_NETWORK=local. Lets the full site be tested against freshly
// deployed contracts before anything touches Arbitrum.
const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
if (env.VITE_NETWORK === "local") {
  NETWORKS.local = {
    chainIdHex: "0x7a69", // 31337
    chainName: "Local test chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["http://127.0.0.1:8545"],
    blockExplorerUrls: [],
    label: "Local test chain",
    isTestnet: true,
    deploymentBlock: 0,
    addresses: JSON.parse(env.VITE_LOCAL_ADDRESSES || "{}"),
  };
}

export const ACTIVE_NETWORK = NETWORKS.local || NETWORKS.arbitrum;

export const CONTRACT_ADDRESSES = ACTIVE_NETWORK.addresses;

export const SEPOLIA_CHAIN_ID = ACTIVE_NETWORK.chainIdHex; // kept for compatibility; now network-aware

// Rough but reliable-enough mobile detection — good enough to decide
// which error message and recovery path to show, not used for anything
// security-sensitive.
export function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// Opens the current page inside MetaMask's own in-app browser, which DOES
// inject window.ethereum, unlike regular mobile Safari/Chrome. This is the
// real fix for mobile — installing the MetaMask phone app alone does NOT
// help unless the site is actually opened through this link.
// Current official deep link format per MetaMask's own docs (verified
// July 2026) — note this occasionally misbehaves on some phone/OS
// combinations per MetaMask's own bug tracker, so it's the best available
// path today, not a guaranteed one.
export function getMetaMaskDeepLink() {
  const host = window.location.host + window.location.pathname;
  return `https://link.metamask.io/dapp/${host}`;
}

import InvestTokenABI from "./contracts/InvestToken.json";
import RoundAuctionABI from "./contracts/RoundAuction.json";
import OpenVerifierABI from "./contracts/OpenVerifier.json";
import RoundAuctionV9ABI from "./contracts/RoundAuctionV9.json";
import GovernanceV9ABI from "./contracts/GovernanceV9.json";
import CompanyTreasuryV9ABI from "./contracts/CompanyTreasuryV9.json";
import CompanyDividendsV9ABI from "./contracts/CompanyDividendsV9.json";
import OpenVerifierV2ABI from "./contracts/OpenVerifierV2.json";

export const ABIS = {
  InvestToken: InvestTokenABI,
  RoundAuction: RoundAuctionABI,
  OpenVerifier: OpenVerifierABI,
  RoundAuctionV9: RoundAuctionV9ABI,
  GovernanceV9: GovernanceV9ABI,
  CompanyTreasuryV9: CompanyTreasuryV9ABI,
  CompanyDividendsV9: CompanyDividendsV9ABI,
  OpenVerifierV2: OpenVerifierV2ABI,
};

// True once the v9 contracts are deployed and their addresses filled in.
export const V9_LIVE = !!CONTRACT_ADDRESSES.RoundAuctionV9;

// Just the ERC-20 functions the treasury screens need, for any token a
// company holds (not only INVEST).
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

// Lazily imports ethers only when actually needed — keeps it out of the
// main bundle for visitors who never connect a real wallet at all.
export async function getEthers() {
  return await import("ethers");
}

// Returns { provider, signer, address } or throws a clear error.
// Requests MetaMask connection and switches/adds Sepolia if needed.
export async function connectWallet() {
  if (!window.ethereum) {
    if (isMobileDevice()) {
      const err = new Error(
        "No wallet browser detected. On mobile, MetaMask only works if this page is opened INSIDE the MetaMask app's own browser — having the MetaMask app installed isn't enough on its own."
      );
      err.isMobileNoWallet = true;
      throw err;
    }
    throw new Error(
      "No wallet extension found. Install MetaMask as a browser extension at metamask.io, then refresh this page."
    );
  }

  const { BrowserProvider } = await getEthers();

  // Ask for account access
  await window.ethereum.request({ method: "eth_requestAccounts" });

  // Make sure we're on the active network — offer to switch, or add it
  // if it's never been added to this wallet before. All params flow from
  // ACTIVE_NETWORK, nothing chain-specific hardcoded here anymore.
  const currentChainId = await window.ethereum.request({ method: "eth_chainId" });
  if (currentChainId !== ACTIVE_NETWORK.chainIdHex) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ACTIVE_NETWORK.chainIdHex }],
      });
    } catch (switchError) {
      // 4902 = chain not added to this wallet yet
      if (switchError.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: ACTIVE_NETWORK.chainIdHex,
              chainName: ACTIVE_NETWORK.chainName,
              nativeCurrency: ACTIVE_NETWORK.nativeCurrency,
              rpcUrls: ACTIVE_NETWORK.rpcUrls,
              blockExplorerUrls: ACTIVE_NETWORK.blockExplorerUrls,
            },
          ],
        });
      } else {
        throw switchError;
      }
    }
  }

  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();

  return { provider, signer, address };
}

// A read-only connection for visitors without a wallet: everything on the
// site can be browsed from the chain before anyone connects.
let readProvider = null;
export async function getReadProvider() {
  if (readProvider) return readProvider;
  const { JsonRpcProvider, Network } = await getEthers();
  const network = Network.from(Number(BigInt(ACTIVE_NETWORK.chainIdHex)));
  readProvider = new JsonRpcProvider(ACTIVE_NETWORK.rpcUrls[0], network, { staticNetwork: network, batchMaxCount: 20 });
  return readProvider;
}

// Citizen numbers and whether INVEST can move freely between wallets.
export async function getPublicStats(provider) {
  const [it, ra] = await Promise.all([getContract("InvestToken", provider), getContract("RoundAuction", provider)]);
  const [citizenCount, maxCitizens, tradable] = await Promise.all([
    it.citizenCount(),
    it.maxCitizens(),
    ra.globalTradabilityUnlocked().catch(() => false),
  ]);
  const verifyOpen = await it.verifier(CONTRACT_ADDRESSES.OpenVerifier).catch(() => true);
  return { citizenCount, maxCitizens, tradable, verifyOpen };
}

// Returns an ethers Contract instance connected to a signer (for writes)
// or a provider (for reads only).
export async function getContract(name, signerOrProvider) {
  const address = CONTRACT_ADDRESSES[name];
  if (!address) {
    // Deliberate loud failure: the Arbitrum config ships with empty
    // addresses until the real deployment happens. Throwing here beats
    // ethers quietly constructing a Contract against a bad target.
    throw new Error(`${name} has no address configured for ${ACTIVE_NETWORK.label} yet.`);
  }
  const { Contract } = await getEthers();
  return new Contract(address, ABIS[name], signerOrProvider);
}

// ---- Sending transactions with a gas safety margin ----
//
// Wallets estimate gas against the latest block. On Arbitrum, blocks are
// a quarter-second apart, so the transaction often lands in a LATER second
// than the estimate. v8 keeps a per-second history of share balances: a
// transaction in a new second writes a new history entry, which costs
// more gas than updating one from the same second. Without a margin those
// transactions run out of gas (seen in testing). 25% + 100,000 covers it,
// capped at Arbitrum's 32,000,000 per-transaction limit. Unused gas is
// refunded, so the margin costs nothing extra in practice.
const GAS_CAP = 32_000_000n;

export async function sendTx(contract, method, ...args) {
  const estimate = await contract[method].estimateGas(...args);
  let gasLimit = (estimate * 125n) / 100n + 100_000n;
  if (gasLimit > GAS_CAP) gasLimit = GAS_CAP;
  const tx = await contract[method](...args, { gasLimit });
  return tx.wait();
}

// ---- Errors people can act on ----
//
// Contracts revert with short codes ("RA: ...", "GOV: ...", "CT: ...").
// These are the ones a person can actually hit from the site, rewritten
// to say what happened and what to do. Anything else falls back to the
// contract's own message.
const ERROR_TEXT = [
  ["RA: cooldown, round not open yet", "The next round hasn't opened yet. Bidding opens an hour after each settlement."],
  ["RA: book full, bid must beat the lowest", "The book is full. To get in, your bid needs a higher price per share than the lowest bid."],
  ["RA: max price below 1 INVEST", "The price limit must be at least 1 INVEST a share."],
  ["RA: withdraw only during cooldown", "A bid can only be withdrawn in the hour between rounds."],
  ["RA: no active bid", "This wallet has no active bid on this company."],
  ["RA: share still locked", "This share can't be moved or sold yet: a share is locked for 7 days after it is issued."],
  ["RA: comp shares locked", "Compensation shares are locked for 60 days."],
  ["RA: seller no longer owns share", "The seller no longer has this share, so the offer has ended."],
  ["RA: own listing", "That's your own offer."],
  ["RA: sold out", "This company is sold out."],
  ["GOV: under 50% issued at snapshot", "The election can open one day after half of the shares are sold: votes count shares as they were a day earlier."],
  ["GOV: election in progress", "An election is already under way."],
  ["GOV: governor in office", "The company has a CEO whose term isn't over."],
  ["GOV: candidacy not open", "Candidates can't declare or be backed at this stage."],
  ["GOV: already nominated someone", "You've already backed a candidate, so you can't stand in this election."],
  ["GOV: already nominated", "You've already backed a candidate in this election."],
  ["GOV: already declared", "You've already declared in this election."],
  ["GOV: candidacy period not over", "Voting can open only after the 5-day candidacy stage."],
  ["GOV: not on the ballot", "That candidate isn't on the ballot."],
  ["GOV: others nominated you; you can't withdraw", "Others have backed you, so you can't withdraw."],
  ["GOV: need 1% to open a recall", "Opening a recall needs at least 1% of the shares, held since yesterday."],
  ["GOV: recall cooldown", "A recall reached its turnout less than 7 days ago; a new one can open after that."],
  ["GOV: recall in progress", "A recall vote is already open."],
  ["GOV: recall vote still open", "The recall vote is still open."],
  ["GOV: not the proposed key", "This wallet isn't the operating key the CEO named."],
  ["GOV: voting closed", "Voting has closed."],
  ["CT: would outlast the term", "It's too late in the term: a proposal needs 3 days of voting, 5 days of waiting and room for a recall before the term ends."],
  ["CT: over 20% of the bucket this term", "That would take more than 20% of this balance out in one term."],
  ["CT: execution delay", "Approved proposals wait 5 days after the vote before they can be carried out."],
  ["CT: recall pending", "A recall vote is pending; this waits until it is resolved."],
  ["CT: recipient not allowed", "That recipient isn't allowed: it can't be the CEO, the operating key or the company itself."],
  ["CT: proposer can't vote", "The CEO and operating key can't vote on their own proposal."],
  ["CT: recipient can't vote", "The recipient of a payment can't vote on it."],
  ["CT: below reserve", "That bid is below the minimum price for this sale."],
  ["CT: reserve too small", "The minimum price is too small."],
  ["CT: token not approved", "That token isn't accepted by the treasury."],
  ["CT: voting closed", "Voting on this proposal has closed."],
  ["DV: that term's governor can't vote", "That term's CEO can't vote on its dividend."],
  ["DV: no shares at record date", "You held no shares when this term ended, so you can't vote on its dividend."],
  ["OV2: limit for this hour reached", "The 10 verifications for this hour are used up. Try again at the start of the next hour."],
  ["OV2: ordinary wallets only", "Only an ordinary wallet can verify, not a contract."],
  ["OV2: insufficient ETH balance", "This wallet needs at least 0.0083 ETH on Arbitrum One to verify. Nothing is taken."],
  ["OV2: paused", "Self-verification is switched off at the moment."],
  ["OV2: already verified", "This wallet is already verified."],
  ["already have active bid", "You already have an active bid on this company. It carries into every round until it wins or the company sells out."],
  ["active bid cap reached", "This company already has 100 active bids, the maximum. Try again after the next settlement."],
  ["bid below 1 INVEST", "The minimum bid is 1 INVEST."],
  ["RA: round closed", "This round has closed. Settle it to open the next round, then bid."],
  ["RA: round still open", "This round is still open. It can be settled once the countdown ends."],
  ["stake below 0.1%", "To stand as a candidate you need at least 0.1% of the shares issued so far."],
  ["candidates full", "This election already has 20 candidates, the maximum."],
  ["candidacy closed", "Candidacy is closed because voting has already opened."],
  ["GOV: no shares at snapshot", "You held no shares when this voting round opened, so you can't vote in it. You can vote in later rounds."],
  ["GOV: already voted", "You've already voted in this round."],
  ["CT: no shares at snapshot", "You held no shares when this payment was proposed, so you can't vote on it."],
  ["CT: no shares at record date", "You held no shares when this term ended, so you can't vote on its dividend."],
  ["over 5% free allowance", "That's more than the 5% you can withdraw freely this term. For larger amounts, use a treasury auction or a vendor payment."],
  ["hash mismatch", "The amount or reveal code doesn't match what was committed."],
  ["not reveal window", "Reveals are only accepted after bidding closes and before the reveal deadline."],
  ["commit window closed", "Bidding on this auction has closed."],
  ["not operating key", "This must be signed by the company's registered operating key. Switch MetaMask to that account."],
  ["term expired", "The CEO's term has ended, so CEO actions are no longer allowed."],
  ["nothing to claim", "There's nothing for this wallet to claim."],
  ["already claimed", "Already claimed."],
  ["insufficient balance", "The company doesn't hold that much of this token (or some of it is reserved by an auction or payment)."],
  ["no reinvest income", "The company doesn't have that much reinvestable income."],
  ["payment token not approved", "That payment token isn't accepted on the INVEST market."],
  ["closed loop", "INVEST can't be sent there yet: it can only go into the auction or treasury until trading unlocks."],
];

export function friendlyError(err) {
  if (err?.code === "ACTION_REJECTED" || err?.info?.error?.code === 4001) {
    return "You cancelled the transaction in MetaMask.";
  }
  const raw = err?.reason || err?.revert?.args?.[0] || err?.shortMessage || err?.message || "Transaction failed.";
  for (const [needle, text] of ERROR_TEXT) {
    if (raw.includes(needle)) return text;
  }
  return raw;
}

// Checks whether a wallet can call OpenVerifier.verifySelf() right now —
// specifically, whether it holds enough ETH to clear MIN_BALANCE. Read
// live rather than hardcoded, since MIN_BALANCE could change if
// OpenVerifier is ever redeployed with a different threshold.
export async function getVerifySelfEligibility(address, provider) {
  const openVerifier = await getContract("OpenVerifier", provider);
  const [minBalance, currentBalance] = await Promise.all([
    openVerifier.MIN_BALANCE(),
    provider.getBalance(address),
  ]);
  return {
    minBalance,
    currentBalance,
    eligible: currentBalance >= minBalance,
  };
}

// The real self-verification transaction. Anyone can call this for
// themselves (see OpenVerifier.sol) as long as their wallet clears
// MIN_BALANCE — no owner/verifier approval needed. Returns the receipt
// once mined; callers should re-check getClaimEligibility() afterward
// since verifiedCitizen only flips true once this is actually mined.
export async function verifySelfReal(signer) {
  const openVerifier = await getContract("OpenVerifier", signer);
  const tx = await openVerifier.verifySelf();
  const receipt = await tx.wait();
  return receipt;
}

// Real read-only checks against InvestToken — used to show accurate
// state before someone attempts a real transaction, so the UI can
// explain *why* claim() would fail instead of just letting it revert.
export async function getClaimEligibility(address, provider) {
  const investToken = await getContract("InvestToken", provider);
  const [isVerified, alreadyClaimed, citizenCount, maxCitizens] = await Promise.all([
    investToken.verifiedCitizen(address),
    investToken.claimed(address),
    investToken.citizenCount(),
    investToken.maxCitizens(),
  ]);
  return {
    isVerified,
    alreadyClaimed,
    citizenCount,
    maxCitizens,
    canClaim: isVerified && !alreadyClaimed && citizenCount < maxCitizens,
  };
}

// The real claim — an actual transaction, not a simulated state update.
// Returns the transaction receipt once mined.
export async function claimReal(signer) {
  const investToken = await getContract("InvestToken", signer);
  const tx = await investToken.claim();
  const receipt = await tx.wait();
  return receipt;
}

// The redeployed contracts went live within roughly the last 85,000
// blocks — using this as fromBlock instead of 0 avoids exceeding the
// ~10,000-block range cap many RPC providers enforce on eth_getLogs.
// Confirmed live: querying from genesis threw "range 11461200 exceeds
// limit of 10000" on every single event-log read tonight, for every
// company — silently breaking "Loading bid history..." forever, and
// making a genuinely successful bid look like a failure in the UI,
// since the post-bid refresh call was throwing right after.
const DEPLOYMENT_BLOCK = ACTIVE_NETWORK.deploymentBlock;

// ---- Event-log reading, cached ----
//
// Bids and candidates are found by scanning the event log. Scanning from
// the deploy block on every page load meant ~80 RPC requests per company
// card on day one, growing every day. Instead, each event type is scanned
// ONCE for the whole contract (all companies together), the result is
// saved in this browser, and later visits only scan the new blocks since
// the last visit. Per-company lookups then filter that shared list locally.
//
// The newest SETTLE_MARGIN blocks are never saved, only read fresh each
// time, so a short chain reorganisation can't leave a stale log behind.

const LOG_CHUNK = 9000; // safely under the common 10,000-block RPC cap
const LOG_PARALLEL = 4;
const SETTLE_MARGIN = 1000; // ~4 minutes of Arbitrum blocks
const LOG_CACHE_VERSION = 1;

const settledLogs = new Map(); // cacheKey -> { settledBlock, logs }
const inflightSync = new Map(); // cacheKey -> Promise, so ten cards share one scan

function logCacheKey(address, topic0) {
  return `sx-logs:v${LOG_CACHE_VERSION}:${ACTIVE_NETWORK.chainIdHex}:${address.toLowerCase()}:${topic0}:${DEPLOYMENT_BLOCK}`;
}

function readStoredLogs(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.settledBlock !== "number" || !Array.isArray(parsed.logs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredLogs(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked (private browsing): the in-memory copy still
    // works for this visit; the next visit just rescans.
  }
}

async function getLogsRange(provider, address, topic0, fromBlock, toBlock) {
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    ranges.push([start, Math.min(start + LOG_CHUNK - 1, toBlock)]);
  }
  // Read up to LOG_PARALLEL chunks at a time: much faster on a first visit,
  // while staying gentle enough for public RPC rate limits.
  const results = new Array(ranges.length);
  let next = 0;
  const worker = async () => {
    while (next < ranges.length) {
      const i = next++;
      const [start, end] = ranges[i];
      results[i] = await provider.getLogs({ address, topics: [topic0], fromBlock: start, toBlock: end });
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOG_PARALLEL, ranges.length) }, worker));
  return results.flat().map((l) => ({ topics: [...l.topics], data: l.data, blockNumber: l.blockNumber, index: l.index }));
}

// Returns every log of one event type on one contract, from the deploy
// block to the latest block.
// v9 contracts can't have events before RoundAuctionV9 existed, so their
// history scan starts there instead of at the v8 start (2M fewer blocks).
const V9_NAMES = ["RoundAuctionV9", "GovernanceV9", "CompanyTreasuryV9", "CompanyDividendsV9", "OpenVerifierV2"];
function startBlockFor(address) {
  const a = address.toLowerCase();
  const v9 = V9_NAMES.some((n) => (CONTRACT_ADDRESSES[n] || "").toLowerCase() === a);
  return v9 && ACTIVE_NETWORK.v9DeploymentBlock ? ACTIVE_NETWORK.v9DeploymentBlock : DEPLOYMENT_BLOCK;
}

async function syncEventLogs(provider, address, topic0) {
  const key = logCacheKey(address, topic0);
  const START = startBlockFor(address);
  if (inflightSync.has(key)) return inflightSync.get(key);

  const job = (async () => {
    const latest = await provider.getBlockNumber();
    const settleTarget = latest - SETTLE_MARGIN;

    let cached = settledLogs.get(key) || readStoredLogs(key) || { settledBlock: START - 1, logs: [] };

    if (settleTarget > cached.settledBlock) {
      const fresh = await getLogsRange(provider, address, topic0, cached.settledBlock + 1, settleTarget);
      cached = { settledBlock: settleTarget, logs: cached.logs.concat(fresh) };
      writeStoredLogs(key, cached);
    }
    settledLogs.set(key, cached);

    const tailFrom = Math.max(cached.settledBlock + 1, START);
    const tail = tailFrom <= latest ? await getLogsRange(provider, address, topic0, tailFrom, latest) : [];
    return cached.logs.concat(tail);
  })();

  inflightSync.set(key, job);
  try {
    return await job;
  } finally {
    inflightSync.delete(key);
  }
}

function topicMatches(wanted, actual) {
  if (wanted === null || wanted === undefined) return true;
  const options = Array.isArray(wanted) ? wanted : [wanted];
  return options.some((w) => w === null || (actual && w.toLowerCase() === actual.toLowerCase()));
}

// Drop-in replacement for the old chunked queryFilter: same filter in,
// same { args } events out, but served from the shared cached scan.
export async function queryFilterChunked(contract, filter) {
  const provider = contract.runner.provider;
  const address = await contract.getAddress();
  const topics = await filter.getTopicFilter();
  const all = await syncEventLogs(provider, address, topics[0]);
  return all
    .filter((l) => topics.slice(1).every((t, i) => topicMatches(t, l.topics[i + 1])))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
    .map((l) => {
      const parsed = contract.interface.parseLog({ topics: l.topics, data: l.data });
      return { args: parsed.args, blockNumber: l.blockNumber };
    });
}

// ETH balance of any address: used to warn a governor when their
// operating-key account doesn't have enough ETH to pay for gas.
export async function getEthBalance(address, provider) {
  return provider.getBalance(address);
}

// Checks an address someone pasted. Returns the checksummed form, or null
// if it isn't a valid address.
export async function normalizeAddress(input) {
  const { getAddress } = await getEthers();
  try {
    return getAddress(input.trim());
  } catch {
    return null;
  }
}

// ---- Tokens and approvals ----

const tokenInfoCache = new Map();

export async function getTokenInfo(tokenAddress, provider) {
  const key = tokenAddress.toLowerCase();
  if (tokenInfoCache.has(key)) return tokenInfoCache.get(key);
  const { Contract } = await getEthers();
  const t = new Contract(tokenAddress, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    t.symbol().catch(() => tokenAddress.slice(0, 6) + "…"),
    t.decimals().catch(() => 18n),
  ]);
  const info = { address: tokenAddress, symbol, decimals: Number(decimals) };
  tokenInfoCache.set(key, info);
  return info;
}

export async function parseAmount(text, decimals = 18) {
  const { parseUnits } = await getEthers();
  const v = parseUnits(String(text).trim(), decimals); // throws on bad input
  if (v <= 0n) throw new Error("Amount must be more than zero.");
  return v;
}

// Makes sure `spender` may move at least `needed` of a token from the
// signer. INVEST gets a one-time unlimited approval, the same pattern as
// bidding (INVEST is closed-loop until tradability unlocks). Any other
// token is approved for exactly what this transaction needs.
export async function ensureAllowance(signer, tokenAddress, spender, needed) {
  const { Contract, MaxUint256 } = await getEthers();
  const owner = await signer.getAddress();
  const t = new Contract(tokenAddress, ERC20_ABI, signer);
  const current = await t.allowance(owner, spender);
  if (current >= needed) return;
  const isInvest = tokenAddress.toLowerCase() === CONTRACT_ADDRESSES.InvestToken.toLowerCase();
  const tx = await t.approve(spender, isInvest ? MaxUint256 : needed);
  await tx.wait();
}

// ---- INVEST balance ----

export async function getInvestBalance(address, provider) {
  return (await getContract("InvestToken", provider)).balanceOf(address);
}
