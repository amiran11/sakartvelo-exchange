// src/web3.js
//
// The REAL blockchain layer, entirely separate from the simulated game
// in App.jsx. Every chain-specific value flows from the config below.
//
// v8 is a complete fresh deployment (REDEPLOY_V8.md), done on Arbitrum
// One on 8 October 2026: new InvestToken, OpenVerifier, RoundAuction,
// Governance and CompanyTreasury, all owned by 0xD9fb…b2de0. ShareAuction
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
    addresses: {
      InvestToken: "0x99ED3761F8416342D814ad4CCAe81993c2Ab7e4a",
      OpenVerifier: "0x444653dDbBb24B24bcD8D674e30b371800Cc2ad2",
      RoundAuction: "0x9739e5dCcc76BD424BcD12e7f1ce56143e77b796",
      Governance: "0x5668F72F3dB11c4DA6aF682604d1184763bB971d",
      CompanyTreasury: "0xaD50c4726E78a8e8a18a1A188bd60E7ef0A501e8",
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
import CompanyTreasuryABI from "./contracts/CompanyTreasury.json";
import RoundAuctionABI from "./contracts/RoundAuction.json";
import OpenVerifierABI from "./contracts/OpenVerifier.json";
import GovernanceABI from "./contracts/Governance.json";

export const ABIS = {
  InvestToken: InvestTokenABI,
  CompanyTreasury: CompanyTreasuryABI,
  RoundAuction: RoundAuctionABI,
  OpenVerifier: OpenVerifierABI,
  Governance: GovernanceABI,
};

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
async function getEthers() {
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

async function sendTx(contract, method, ...args) {
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
  ["term expired", "The governor's term has ended, so governor actions are no longer allowed."],
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

// ---- Real auctions (Stage 2) ----

// Companies don't have a registry array on-chain — listCompany() is called
// per-id by the owner, whenever. We just probe a reasonable range of ids
// and keep whichever ones actually have totalShares > 0 (i.e. are real).
// 0-19 comfortably covers the 11-company roster with room to grow.
const COMPANY_ID_PROBE_RANGE = 20;

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
async function syncEventLogs(provider, address, topic0) {
  const key = logCacheKey(address, topic0);
  if (inflightSync.has(key)) return inflightSync.get(key);

  const job = (async () => {
    const latest = await provider.getBlockNumber();
    const settleTarget = latest - SETTLE_MARGIN;

    let cached = settledLogs.get(key) || readStoredLogs(key) || { settledBlock: DEPLOYMENT_BLOCK - 1, logs: [] };

    if (settleTarget > cached.settledBlock) {
      const fresh = await getLogsRange(provider, address, topic0, cached.settledBlock + 1, settleTarget);
      cached = { settledBlock: settleTarget, logs: cached.logs.concat(fresh) };
      writeStoredLogs(key, cached);
    }
    settledLogs.set(key, cached);

    const tailFrom = Math.max(cached.settledBlock + 1, DEPLOYMENT_BLOCK);
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
async function queryFilterChunked(contract, filter) {
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

// ---- Governance ----
//
// Elections, governors and operating keys live in the Governance contract;
// share balances (and the history that votes are weighted by) live in
// RoundAuction.

export async function getCompanyGovernance(companyId, provider) {
  const c = await getContract("Governance", provider);
  const [round, voteEnd, governor, termEnd, operatingKey, termNum] = await Promise.all([
    c.governanceRound(companyId),
    c.governanceVoteEnd(companyId),
    c.companyGovernor(companyId),
    c.governorTermEnd(companyId),
    c.governorOperatingKey(companyId),
    c.termNumber(companyId),
  ]);
  let totalVotesCast = 0n;
  let snapshot = 0n;
  if (round > 0n) {
    [totalVotesCast, snapshot] = await Promise.all([c.roundTotalVotesCast(companyId, round), c.roundSnapshot(companyId, round)]);
  }
  return { round, voteEnd, governor, termEnd, operatingKey, termNum, totalVotesCast, snapshot };
}

// Election limits, read from the contract so the site never disagrees
// with it: max candidates, and the minimum stake needed to stand.
export async function getElectionRules(provider) {
  const c = await getContract("Governance", provider);
  const [maxCandidates, minStakeBps] = await Promise.all([c.MAX_CANDIDATES(), c.MIN_CANDIDATE_STAKE_BPS()]);
  return { maxCandidates, minStakeBps };
}

// Candidates with their written programs (at most 20, read directly) and
// each one's current share stake, so voters can see who they vote for.
export async function getCandidates(companyId, provider) {
  const [c, s] = await Promise.all([getContract("Governance", provider), getContract("RoundAuction", provider)]);
  const [round, count] = await Promise.all([c.governanceRound(companyId), c.candidateCount(companyId)]);
  const addrs = await Promise.all(Array.from({ length: Number(count) }, (_, i) => c.candidateList(companyId, i)));
  const candidates = await Promise.all(
    addrs.map(async (address) => {
      const [info, isEliminated, votes, stake] = await Promise.all([
        c.candidates(companyId, address),
        c.eliminated(companyId, address),
        round > 0n ? c.roundVotes(companyId, round, address) : Promise.resolve(0n),
        s.companyShareCount(companyId, address),
      ]);
      return { address, program: info.program, registered: info.registered, eliminated: isEliminated, votes, stake };
    })
  );
  return candidates.filter((x) => x.registered);
}

export async function getMyShareCount(companyId, address, provider) {
  return (await getContract("RoundAuction", provider)).companyShareCount(companyId, address);
}

// Votes this wallet has in the current round: the shares it held one
// second before the round opened, not the shares it holds now.
export async function getMyVoteWeight(companyId, address, gov, provider) {
  if (gov.round === 0n) return 0n;
  return (await getContract("RoundAuction", provider)).shareCountAt(companyId, address, gov.snapshot);
}

export async function hasVotedThisRound(companyId, round, address, provider) {
  return (await getContract("Governance", provider)).roundHasVoted(companyId, round, address);
}

async function govWrite(signer, method, ...args) {
  return sendTx(await getContract("Governance", signer), method, ...args);
}

export const declareCandidacyReal = (signer, companyId, program) => govWrite(signer, "declareCandidacy", companyId, program);
export const openGovernanceVoteReal = (signer, companyId) => govWrite(signer, "openGovernanceVote", companyId);
export const voteReal = (signer, companyId, candidateAddress) => govWrite(signer, "vote", companyId, candidateAddress);
export const tallyRoundReal = (signer, companyId) => govWrite(signer, "tallyRound", companyId);
export const setOperatingKeyReal = (signer, companyId, operatingKeyAddress) => govWrite(signer, "setOperatingKey", companyId, operatingKeyAddress);
export const startNewTermReal = (signer, companyId) => govWrite(signer, "startNewTerm", companyId);

// A governor votes the shares their company holds in another company.
export const voteAsCorporationReal = (signer, fromCompanyId, toCompanyId, candidate) =>
  govWrite(signer, "voteAsCorporation", fromCompanyId, toCompanyId, candidate);

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

// ---- RoundAuction v8 ----

export async function getListedRoundCompanies(provider) {
  const roundAuction = await getContract("RoundAuction", provider);
  const ids = Array.from({ length: COMPANY_ID_PROBE_RANGE }, (_, i) => i);
  const results = await Promise.all(
    ids.map(async (id) => {
      const c = await roundAuction.companies(id);
      // Explicit field access, not a spread: spreading an ethers v6
      // Result silently drops its named fields.
      return {
        id,
        name: c.name,
        totalShares: c.totalShares,
        sharesIssued: c.sharesIssued,
        currentRound: c.currentRound,
        roundEnd: c.roundEnd,
        roundDuration: c.roundDuration,
        finalized: c.finalized,
        firstMintedAt: c.firstMintedAt,
        capital: c.capital,
      };
    })
  );
  return results.filter((c) => c.totalShares > 0n);
}

// v8 keeps only ACTIVE bids, readable in one call. No event scanning.
export async function getRoundBids(companyId, provider) {
  const roundAuction = await getContract("RoundAuction", provider);
  const list = await roundAuction.getActiveBids(companyId);
  return list.map((b) => ({ bidder: b.bidder, amount: b.amount, seq: b.seq, active: true }));
}

// Auction limits, read from the contract.
export async function getRoundAuctionRules(provider) {
  const c = await getContract("RoundAuction", provider);
  const [maxActiveBids, maxSharesPerRound, minBid, lockPeriod] = await Promise.all([
    c.MAX_ACTIVE_BIDS(), c.MAX_SHARES_PER_ROUND(), c.MIN_BID(), c.LOCK_PERIOD(),
  ]);
  return { maxActiveBids, maxSharesPerRound, minBid, lockPeriod };
}

export async function getRoundInvestAllowance(ownerAddress, provider) {
  const investToken = await getContract("InvestToken", provider);
  return investToken.allowance(ownerAddress, CONTRACT_ADDRESSES.RoundAuction);
}

export async function approveInvestForRound(signer, amount) {
  const investToken = await getContract("InvestToken", signer);
  const tx = await investToken.approve(CONTRACT_ADDRESSES.RoundAuction, amount);
  return tx.wait();
}

export async function placeRoundBid(signer, companyId, amount) {
  return sendTx(await getContract("RoundAuction", signer), "placeBid", companyId, amount);
}

// Permissionless: anyone can settle once a round's window closes.
export async function settleRoundReal(signer, companyId) {
  return sendTx(await getContract("RoundAuction", signer), "settleRound", companyId);
}

// A governor bids the company's reinvestable income into another company.
export async function investReal(signer, fromCompanyId, toCompanyId, amount) {
  return sendTx(await getContract("RoundAuction", signer), "invest", fromCompanyId, toCompanyId, amount);
}

// ---- Tokens and approvals (shared by the treasury and the INVEST market) ----

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

export async function formatAmount(raw, decimals = 18) {
  const { formatUnits } = await getEthers();
  return formatUnits(raw, decimals);
}

export async function parseAmount(text, decimals = 18) {
  const { parseUnits } = await getEthers();
  const v = parseUnits(String(text).trim(), decimals); // throws on bad input
  if (v <= 0n) throw new Error("Amount must be more than zero.");
  return v;
}

// Makes sure `spender` may move at least `needed` of a token from the
// signer. INVEST gets a one-time unlimited approval, the same pattern as
// bidding (INVEST has no value outside this closed system). Any other
// token is approved for exactly what this transaction needs.
async function ensureAllowance(signer, tokenAddress, spender, needed) {
  const { Contract, MaxUint256 } = await getEthers();
  const owner = await signer.getAddress();
  const t = new Contract(tokenAddress, ERC20_ABI, signer);
  const current = await t.allowance(owner, spender);
  if (current >= needed) return;
  const isInvest = tokenAddress.toLowerCase() === CONTRACT_ADDRESSES.InvestToken.toLowerCase();
  const tx = await t.approve(spender, isInvest ? MaxUint256 : needed);
  await tx.wait();
}

// ---- CompanyTreasury v6 ----

async function ct(signerOrProvider) {
  return getContract("CompanyTreasury", signerOrProvider);
}

// A company's money at a glance: INVEST capital and reinvestable income
// (both held in RoundAuction), plus every other token in its treasury.
// Tokens are discovered from deposits and from the INVEST market's
// accepted payment tokens (company sales are paid in those).
export async function getCompanyTreasury(companyId, provider) {
  const [treasury, ra] = await Promise.all([ct(provider), getContract("RoundAuction", provider)]);
  const [company, reinvestableIncome, deposits, payTokens] = await Promise.all([
    ra.companies(companyId),
    ra.reinvestableIncome(companyId),
    queryFilterChunked(treasury, treasury.filters.TokenDeposited(companyId)),
    getApprovedPaymentTokens(provider),
  ]);
  const candidates = new Set([...deposits.map((e) => e.args[1]), ...payTokens.map((t) => t.address)]);
  const tokens = [];
  for (const address of candidates) {
    const balance = await treasury.companyTokenBalance(companyId, address);
    if (balance === 0n) continue;
    tokens.push({ ...(await getTokenInfo(address, provider)), balance });
  }
  return { capital: company.capital, reinvestableIncome, tokens };
}

export async function depositTokenReal(signer, companyId, tokenAddress, amount) {
  const treasury = await ct(signer);
  await ensureAllowance(signer, tokenAddress, await treasury.getAddress(), amount);
  return sendTx(treasury, "depositToken", companyId, tokenAddress, amount);
}

export async function getFreeAllowanceLeft(companyId, tokenAddress, provider) {
  return (await ct(provider)).freeAllowanceLeft(companyId, tokenAddress);
}

export async function withdrawTokenReal(signer, companyId, tokenAddress, to, amount) {
  return sendTx(await ct(signer), "withdrawToken", companyId, tokenAddress, to, amount);
}

// ---- Treasury auctions (sealed bids: commit, then reveal) ----
//
// A sealed bid is committed as a hash of (auction, amount, secret, bidder).
// The secret is generated here and saved in this browser BEFORE the
// commit transaction is sent, so it can't be lost to a failed page load.
// It's also shown as a "reveal code" the bidder can copy and keep: without
// it the bid can't be revealed, and the 10 INVEST deposit is forfeited
// (the bid amount itself is only paid at reveal, so nothing more is lost).

function bidStorageKey(auctionId, bidder) {
  return `sx-sealed-bid:${ACTIVE_NETWORK.chainIdHex}:${CONTRACT_ADDRESSES.CompanyTreasury.toLowerCase()}:${auctionId}:${bidder.toLowerCase()}`;
}

export function getSavedBid(auctionId, bidder) {
  try {
    const raw = window.localStorage.getItem(bidStorageKey(auctionId, bidder));
    return raw ? JSON.parse(raw) : null; // { amount: "<wei>", salt: "0x..." }
  } catch {
    return null;
  }
}

function saveBid(auctionId, bidder, amount, salt) {
  try {
    window.localStorage.setItem(bidStorageKey(auctionId, bidder), JSON.stringify({ amount: amount.toString(), salt }));
  } catch {
    // Private browsing: the reveal code shown on screen is the backup.
  }
}

export function makeRevealCode(amount, salt) {
  return `${amount.toString()}-${salt}`;
}

export function parseRevealCode(code) {
  const m = String(code).trim().match(/^(\d+)-(0x[0-9a-fA-F]{64})$/);
  if (!m) return null;
  return { amount: BigInt(m[1]), salt: m[2] };
}

export async function computeCommitHash(auctionId, amount, salt, bidder) {
  const { keccak256, AbiCoder } = await getEthers();
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "bytes32", "address"], [auctionId, amount, salt, bidder]
  ));
}

export async function getTreasuryAuctions(companyId, me, provider) {
  const treasury = await ct(provider);
  const events = await queryFilterChunked(treasury, treasury.filters.TreasuryAuctionOpened(null, companyId));
  const list = await Promise.all(
    events.map(async (e) => {
      const id = e.args[0];
      const [a, mine] = await Promise.all([treasury.treasuryAuctions(id), treasury.treasuryBids(id, me)]);
      const token = await getTokenInfo(a.token, provider);
      return {
        id, token, amount: a.amount, commitEnd: a.commitEnd, revealEnd: a.revealEnd, deposit: a.deposit,
        committed: a.committed, revealed: a.revealed, leader: a.leader, leadingAmount: a.leadingAmount, settled: a.settled,
        mine: { committed: mine.commitHash !== "0x" + "0".repeat(64), revealed: mine.revealed, revealedAmount: mine.revealedAmount, claimed: mine.claimed },
      };
    })
  );
  return list.sort((x, y) => Number(y.id - x.id));
}

export async function openTreasuryAuctionReal(signer, companyId, tokenAddress, amount) {
  return sendTx(await ct(signer), "openTreasuryAuction", companyId, tokenAddress, amount);
}

// Returns the reveal code. The secret is saved before anything is sent.
export async function commitTreasuryBidReal(signer, auctionId, amount, deposit) {
  const { hexlify, randomBytes } = await getEthers();
  const bidder = await signer.getAddress();
  const salt = hexlify(randomBytes(32));
  saveBid(auctionId, bidder, amount, salt);
  const treasury = await ct(signer);
  await ensureAllowance(signer, CONTRACT_ADDRESSES.InvestToken, await treasury.getAddress(), deposit);
  const hash = await computeCommitHash(auctionId, amount, salt, bidder);
  await sendTx(treasury, "commitBid", auctionId, hash);
  return makeRevealCode(amount, salt);
}

export async function revealTreasuryBidReal(signer, auctionId, amount, salt) {
  const treasury = await ct(signer);
  await ensureAllowance(signer, CONTRACT_ADDRESSES.InvestToken, await treasury.getAddress(), amount);
  return sendTx(treasury, "revealBid", auctionId, amount, salt);
}

export const settleTreasuryAuctionReal = async (signer, auctionId) => sendTx(await ct(signer), "settleTreasuryAuction", auctionId);
export const claimTreasuryAuctionReal = async (signer, auctionId) => sendTx(await ct(signer), "claimTreasuryAuction", auctionId);

// ---- Vendor payments (shareholder vote, 20% quorum) ----

export async function getVendorPayments(companyId, me, provider) {
  const [treasury, ra] = await Promise.all([ct(provider), getContract("RoundAuction", provider)]);
  const [events, quorumBps] = await Promise.all([
    queryFilterChunked(treasury, treasury.filters.VendorPaymentProposed(null, companyId)),
    treasury.VENDOR_QUORUM_BPS(),
  ]);
  const list = await Promise.all(
    events.map(async (e) => {
      const id = e.args[0];
      const p = await treasury.vendorPayments(id);
      const [issued, myWeight, voted, passes, token] = await Promise.all([
        ra.sharesIssuedAt(companyId, p.snapshot),
        ra.shareCountAt(companyId, me, p.snapshot),
        treasury.vendorPaymentVoted(id, me),
        treasury.vendorPaymentPasses(id),
        getTokenInfo(p.token, provider),
      ]);
      return {
        id, token, to: p.to, amount: p.amount, voteEnd: p.voteEnd, yesWeight: p.yesWeight, noWeight: p.noWeight,
        executed: p.executed, issued, quorumNeeded: (issued * quorumBps + 9999n) / 10000n, myWeight, voted, passes,
      };
    })
  );
  return list.sort((x, y) => Number(y.id - x.id));
}

export const proposeVendorPaymentReal = async (signer, companyId, token, to, amount) =>
  sendTx(await ct(signer), "proposeVendorPayment", companyId, token, to, amount);
export const voteVendorPaymentReal = async (signer, paymentId, approve) =>
  sendTx(await ct(signer), "voteVendorPayment", paymentId, approve);
export const executeVendorPaymentReal = async (signer, paymentId) =>
  sendTx(await ct(signer), "executeVendorPayment", paymentId);

// ---- End-of-term dividend vote ----
//
// One row per finished term (most recent first, up to the last 6). The
// record date is the moment the term ended: votes and dividends are
// based on the shares held then.

export async function getDividendTerms(companyId, me, provider) {
  const [treasury, ra, gov] = await Promise.all([ct(provider), getContract("RoundAuction", provider), getContract("Governance", provider)]);
  const termNum = Number(await gov.termNumber(companyId));
  const terms = [];
  for (let t = termNum; t >= 1 && terms.length < 6; t--) {
    const endTime = await treasury.termEndTime(companyId, t);
    if (endTime === 0n) continue; // still running
    const [voteEnd, recordDate, resolved, divW, reinvW, hasVoted, perShare, remaining, claimed] = await Promise.all([
      treasury.policyVoteEnd(companyId, t),
      treasury.policyRecordDate(companyId, t),
      treasury.policyResolved(companyId, t),
      treasury.policyDividendWeight(companyId, t),
      treasury.policyReinvestWeight(companyId, t),
      treasury.policyHasVoted(companyId, t, me),
      treasury.dividendPerShare(companyId, t),
      treasury.dividendRemaining(companyId, t),
      treasury.claimedDividend(companyId, t, me),
    ]);
    const myWeight = await ra.shareCountAt(companyId, me, recordDate > 0n ? recordDate : endTime);
    const owed = resolved ? await treasury.dividendOwed(companyId, t, me) : 0n;
    terms.push({ term: t, endTime, voteEnd, recordDate, resolved, dividendWeight: divW, reinvestWeight: reinvW, hasVoted, perShare, remaining, claimed, myWeight, owed });
  }
  return terms;
}

export const openPolicyVoteReal = async (signer, companyId, term) => sendTx(await ct(signer), "openPolicyVote", companyId, term);
export const votePolicyReal = async (signer, companyId, term, wantsDividend) => sendTx(await ct(signer), "votePolicy", companyId, term, wantsDividend);
export const resolvePolicyVoteReal = async (signer, companyId, term) => sendTx(await ct(signer), "resolvePolicyVote", companyId, term);
export const claimDividendReal = async (signer, companyId, term) => sendTx(await ct(signer), "claimDividend", companyId, term);
export const claimDividendAsCorporationReal = async (signer, fromCompanyId, dividendCompanyId, term) =>
  sendTx(await ct(signer), "claimDividendAsCorporation", fromCompanyId, dividendCompanyId, term);

// Shares a company holds in each other listed company (built up through
// invest()), for the governor tools.
export async function getCorporateHoldings(companyId, companies, provider) {
  const ra = await getContract("RoundAuction", provider);
  const corp = await ra.corporateHolder(companyId);
  const counts = await Promise.all(companies.map((c) => ra.companyShareCount(c.id, corp)));
  return companies.map((c, i) => ({ companyId: c.id, name: c.name, shares: counts[i] })).filter((h) => h.shares > 0n);
}

// ---- INVEST market ----

export async function getApprovedPaymentTokens(provider) {
  const treasury = await ct(provider);
  const events = await queryFilterChunked(treasury, treasury.filters.PaymentTokenApprovalSet());
  const latest = new Map();
  for (const e of events) latest.set(e.args[0], e.args[1]);
  const approved = [...latest].filter(([, ok]) => ok).map(([a]) => a);
  return Promise.all(approved.map((a) => getTokenInfo(a, provider)));
}

export async function getInvestOffers(provider) {
  const treasury = await ct(provider);
  const events = await queryFilterChunked(treasury, treasury.filters.InvestOffered());
  const offers = await Promise.all(
    events.map(async (e) => {
      const id = e.args[0];
      const o = await treasury.investOffers(id);
      if (!o.active) return null;
      return {
        id, seller: o.seller, investAmount: o.investAmount, paymentAmount: o.paymentAmount,
        token: await getTokenInfo(o.paymentToken, provider), isCorporateOffer: o.isCorporateOffer, creditCompanyId: o.creditCompanyId,
      };
    })
  );
  return offers.filter(Boolean).sort((x, y) => Number(y.id - x.id));
}

export async function offerInvestReal(signer, investAmount, paymentToken, paymentAmount) {
  const treasury = await ct(signer);
  await ensureAllowance(signer, CONTRACT_ADDRESSES.InvestToken, await treasury.getAddress(), investAmount);
  return sendTx(treasury, "offerInvest", investAmount, paymentToken, paymentAmount);
}

export async function buyInvestReal(signer, offer) {
  const treasury = await ct(signer);
  await ensureAllowance(signer, offer.token.address, await treasury.getAddress(), offer.paymentAmount);
  return sendTx(treasury, "buyInvest", offer.id);
}

export const cancelInvestOfferReal = async (signer, offerId) => sendTx(await ct(signer), "cancelInvestOffer", offerId);
export const governorOfferInvestReal = async (signer, companyId, investAmount, paymentToken, paymentAmount) =>
  sendTx(await ct(signer), "governorOfferInvest", companyId, investAmount, paymentToken, paymentAmount);

export async function getInvestBalance(address, provider) {
  return (await getContract("InvestToken", provider)).balanceOf(address);
}
