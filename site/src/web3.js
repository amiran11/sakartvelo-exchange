// src/web3.js
//
// The REAL blockchain layer, entirely separate from the simulated game
// in App.jsx. This is Stage 1 of connecting the site to the actual
// deployed Sepolia contracts: wallet connection + a real claim().
//
// Deployed addresses (Sepolia testnet, deployed and wired by hand
// through Remix — see /contracts/README.md for the full deploy log):
export const CONTRACT_ADDRESSES = {
  InvestToken: "0xfA6b90eeDFaDd36A75Eb7DC9D1e87357166b3585",
  ShareAuction: "0x22D7725DB9239fF7E4F5fe5F096e65f105674086",
  CompanyTreasury: "0xa88931fa78a9CA6281733b3Bc297cdaF58A6f7B0",
};

export const SEPOLIA_CHAIN_ID = "0xaa36a7"; // 11155111 in hex, what MetaMask expects

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
import ShareAuctionABI from "./contracts/ShareAuction.json";
import CompanyTreasuryABI from "./contracts/CompanyTreasury.json";

export const ABIS = {
  InvestToken: InvestTokenABI,
  ShareAuction: ShareAuctionABI,
  CompanyTreasury: CompanyTreasuryABI,
};

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

  // Make sure we're on Sepolia — offer to switch, or add it if it's
  // never been added to this wallet before.
  const currentChainId = await window.ethereum.request({ method: "eth_chainId" });
  if (currentChainId !== SEPOLIA_CHAIN_ID) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_CHAIN_ID }],
      });
    } catch (switchError) {
      // 4902 = chain not added to this wallet yet
      if (switchError.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: SEPOLIA_CHAIN_ID,
              chainName: "Sepolia",
              nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
              blockExplorerUrls: ["https://sepolia.etherscan.io"],
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
  const { Contract } = await getEthers();
  return new Contract(CONTRACT_ADDRESSES[name], ABIS[name], signerOrProvider);
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
const DEPLOYMENT_BLOCK = 11377900;

async function queryFilterChunked(contract, filter, fromBlock = DEPLOYMENT_BLOCK) {
  const latest = await contract.runner.provider.getBlockNumber();
  const CHUNK = 9000; // safely under the common 10,000-block RPC cap
  let events = [];
  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latest);
    const chunk = await contract.queryFilter(filter, start, end);
    events = events.concat(chunk);
  }
  return events;
}

export async function getListedCompanies(provider) {
  const shareAuction = await getContract("ShareAuction", provider);
  const ids = Array.from({ length: COMPANY_ID_PROBE_RANGE }, (_, i) => i);
  const results = await Promise.all(
    ids.map(async (id) => {
      const c = await shareAuction.companies(id);
      // Explicit field access, NOT { ...c } — spreading an ethers v6
      // struct Result silently drops every named property (confirmed by
      // direct reproduction), leaving totalShares etc. as undefined and
      // making the filter below always exclude every company, always,
      // regardless of real on-chain state. This is the actual fix for
      // "correctly listed on-chain, permanently invisible on the site."
      return {
        id,
        name: c.name,
        totalShares: c.totalShares,
        sharesIssued: c.sharesIssued,
        auctionEnd: c.auctionEnd,
        mintedAt: c.mintedAt,
        finalized: c.finalized,
        capital: c.capital,
      };
    })
  );
  return results.filter((c) => c.totalShares > 0n);
}

// Bids aren't stored with a public "how many are there" getter — the
// correct way to read an unbounded on-chain array like this is the event
// log, not guessing/probing indices until a call reverts.
export async function getCompanyBids(companyId, provider) {
  const shareAuction = await getContract("ShareAuction", provider);
  const filter = shareAuction.filters.BidPlaced(companyId);
  const events = await queryFilterChunked(shareAuction, filter);
  return events
    .map((e) => ({ bidder: e.args[1], amount: e.args[2] }))
    .sort((a, b) => (b.amount > a.amount ? 1 : -1));
}

export async function getInvestAllowance(ownerAddress, provider) {
  const investToken = await getContract("InvestToken", provider);
  return investToken.allowance(ownerAddress, CONTRACT_ADDRESSES.ShareAuction);
}

export async function approveInvest(signer, amount) {
  const investToken = await getContract("InvestToken", signer);
  const tx = await investToken.approve(CONTRACT_ADDRESSES.ShareAuction, amount);
  return tx.wait();
}

export async function placeBidReal(signer, companyId, amount) {
  const shareAuction = await getContract("ShareAuction", signer);
  const tx = await shareAuction.placeBid(companyId, amount);
  return tx.wait();
}

// Anyone can call this once the auction window closes — not owner-gated.
export async function finalizeAuctionReal(signer, companyId) {
  const shareAuction = await getContract("ShareAuction", signer);
  const tx = await shareAuction.finalize(companyId);
  return tx.wait();
}

// ---- Real governance (Stage 2, part 2) ----

export async function getCompanyGovernance(companyId, provider) {
  const shareAuction = await getContract("ShareAuction", provider);
  const [round, voteEnd, governor, termEnd, operatingKey, termNum] = await Promise.all([
    shareAuction.governanceRound(companyId),
    shareAuction.governanceVoteEnd(companyId),
    shareAuction.companyGovernor(companyId),
    shareAuction.governorTermEnd(companyId),
    shareAuction.governorOperatingKey(companyId),
    shareAuction.termNumber(companyId),
  ]);
  return { round, voteEnd, governor, termEnd, operatingKey, termNum };
}

// Same event-log pattern as bids — candidateList is a public array with no
// length getter, so the correct way to enumerate it is CandidateDeclared,
// not probing indices. eliminated() and registered status are then read
// fresh from the contract per-candidate, since elimination happens after
// the declaration event and wouldn't show up in the log itself.
export async function getCandidates(companyId, provider) {
  const shareAuction = await getContract("ShareAuction", provider);
  const filter = shareAuction.filters.CandidateDeclared(companyId);
  const events = await queryFilterChunked(shareAuction, filter);
  const round = await shareAuction.governanceRound(companyId);
  const seen = new Set();
  const candidates = [];
  for (const e of events) {
    const addr = e.args[1];
    if (seen.has(addr)) continue;
    seen.add(addr);
    const [isEliminated, votes] = await Promise.all([
      shareAuction.eliminated(companyId, addr),
      round > 0n ? shareAuction.roundVotes(companyId, round, addr) : Promise.resolve(0n),
    ]);
    candidates.push({ address: addr, program: e.args[2], eliminated: isEliminated, votes });
  }
  return candidates;
}

export async function getMyShareCount(companyId, address, provider) {
  const shareAuction = await getContract("ShareAuction", provider);
  return shareAuction.companyShareCount(companyId, address);
}

export async function hasVotedThisRound(companyId, round, address, provider) {
  const shareAuction = await getContract("ShareAuction", provider);
  return shareAuction.roundHasVoted(companyId, round, address);
}

export async function declareCandidacyReal(signer, companyId, program) {
  const shareAuction = await getContract("ShareAuction", signer);
  const tx = await shareAuction.declareCandidacy(companyId, program);
  return tx.wait();
}

export async function openGovernanceVoteReal(signer, companyId) {
  const shareAuction = await getContract("ShareAuction", signer);
  const tx = await shareAuction.openGovernanceVote(companyId);
  return tx.wait();
}

export async function voteReal(signer, companyId, candidateAddress) {
  const shareAuction = await getContract("ShareAuction", signer);
  const tx = await shareAuction.vote(companyId, candidateAddress);
  return tx.wait();
}

export async function tallyRoundReal(signer, companyId) {
  const shareAuction = await getContract("ShareAuction", signer);
  const tx = await shareAuction.tallyRound(companyId);
  return tx.wait();
}

export async function setOperatingKeyReal(signer, companyId, operatingKeyAddress) {
  const shareAuction = await getContract("ShareAuction", signer);
  const tx = await shareAuction.setOperatingKey(companyId, operatingKeyAddress);
  return tx.wait();
}

export async function startNewTermReal(signer, companyId) {
  const shareAuction = await getContract("ShareAuction", signer);
  const tx = await shareAuction.startNewTerm(companyId);
  return tx.wait();
}

// Generates a fresh keypair client-side for a newly-elected governor to
// register as their term's operating key — same pattern as the citizen
// browser wallet, just not persisted to localStorage, since whoever calls
// this needs to see and save the private key themselves, once, right now.
export async function generateOperatingKeypair() {
  const { Wallet } = await getEthers();
  return Wallet.createRandom(); // has .address and .privateKey
}
