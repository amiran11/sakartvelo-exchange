// src/web3.js
//
// The REAL blockchain layer, entirely separate from the simulated game
// in App.jsx. Originally built against Sepolia; now network-aware, with
// Arbitrum One prepared as the first real-money deployment target.
//
// To flip networks after the Arbitrum contracts are actually deployed:
// fill in NETWORKS.arbitrum.addresses + deploymentBlock, then change
// ACTIVE_NETWORK below. Nothing else in the app should need touching —
// every chain-specific value flows from this one config.
export const NETWORKS = {
  sepolia: {
    chainIdHex: "0xaa36a7", // 11155111
    chainName: "Sepolia",
    nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
    label: "Sepolia",
    isTestnet: true,
    deploymentBlock: 11377900,
    addresses: {
      InvestToken: "0xfA6b90eeDFaDd36A75Eb7DC9D1e87357166b3585",
      ShareAuction: "0x38E02e24Fddc1F34a8F5BDFD1cc308407627c766",
      CompanyTreasury: "0x475A8c0dC244cBEb4AB648b552c07ca7834b8BF9",
      RoundAuction: "0xbf41381a33D637AaB61AfDCfe269b463E2A13cff",
    },
  },
  arbitrum: {
    chainIdHex: "0xa4b1", // 42161
    chainName: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://arbiscan.io"],
    label: "Arbitrum One",
    isTestnet: false,
    // First deployment tx on Arbitrum One was InvestToken's constructor,
    // mined at block 500861978 — read directly off the deploy receipt.
    deploymentBlock: 500861978,
    addresses: {
      InvestToken: "0x14637417015D872d7117CfcE2Cdd9A7D5cc52FD1",
      ShareAuction: "0x10C6e7fA593Bb0F598611E094bd578e0DB482C0B",
      CompanyTreasury: "0xbEe04358Aa816e4Be951b0E7EDD997e7fb81a674",
      RoundAuction: "0x1e973B55e4Cc94E34B0eD38d6cDaCE3745B9F693",
    },
  },
};

// Live on Arbitrum One as of this deployment.
export const ACTIVE_NETWORK = NETWORKS.arbitrum;

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
import ShareAuctionABI from "./contracts/ShareAuction.json";
import CompanyTreasuryABI from "./contracts/CompanyTreasury.json";
import RoundAuctionABI from "./contracts/RoundAuction.json";

export const ABIS = {
  InvestToken: InvestTokenABI,
  ShareAuction: ShareAuctionABI,
  CompanyTreasury: CompanyTreasuryABI,
  RoundAuction: RoundAuctionABI,
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

// ---- RoundAuction (Stage 2, part 3 — the round-based proportional auction) ----

export async function getListedRoundCompanies(provider) {
  const roundAuction = await getContract("RoundAuction", provider);
  const ids = Array.from({ length: COMPANY_ID_PROBE_RANGE }, (_, i) => i);
  const results = await Promise.all(
    ids.map(async (id) => {
      const c = await roundAuction.companies(id);
      // Explicit field access, not a spread — same real bug fixed earlier
      // tonight in getListedCompanies() applies identically here.
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
      };
    })
  );
  return results.filter((c) => c.totalShares > 0n);
}

// Every bid ever placed, active or not — the same event-log + live-state
// pattern as getCompanyBids()/getCandidates(): the log tells us which
// indices exist, but only a fresh read of bids(companyId, index) tells us
// whether a given bid is still active, since settleRound() can flip that
// after the event fired.
export async function getRoundBids(companyId, provider) {
  const roundAuction = await getContract("RoundAuction", provider);
  const filter = roundAuction.filters.BidPlaced(companyId);
  const events = await queryFilterChunked(roundAuction, filter);
  const bids = await Promise.all(
    events.map(async (e) => {
      const bidIndex = e.args[3];
      const b = await roundAuction.bids(companyId, bidIndex);
      return {
        bidIndex,
        bidder: b.bidder,
        amount: b.amount,
        active: b.active,
      };
    })
  );
  return bids;
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
  const roundAuction = await getContract("RoundAuction", signer);
  const tx = await roundAuction.placeBid(companyId, amount);
  return tx.wait();
}

// Permissionless — anyone can trigger this once a round's window closes.
export async function settleRoundReal(signer, companyId) {
  const roundAuction = await getContract("RoundAuction", signer);
  const tx = await roundAuction.settleRound(companyId);
  return tx.wait();
}
