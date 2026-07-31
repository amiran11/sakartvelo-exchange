// src/web3.js
//
// The REAL blockchain layer, entirely separate from the simulated game
// in App.jsx. This is Stage 1 of connecting the site to the actual
// deployed Sepolia contracts: wallet connection + a real claim().
//
// Deployed addresses (Sepolia testnet, deployed and wired by hand
// through Remix — see /contracts/README.md for the full deploy log):
export const CONTRACT_ADDRESSES = {
  InvestToken: "0xb5121076157730F5E553D5165bd57515506DeCA1",
  ShareAuction: "0x2670068BD3A4D3902D329A2735D5A0ee6aFe3D04",
  CompanyTreasury: "0xfe74f145e959c07D38064f08c83f523db2a43D40",
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

export async function getListedCompanies(provider) {
  const shareAuction = await getContract("ShareAuction", provider);
  const ids = Array.from({ length: COMPANY_ID_PROBE_RANGE }, (_, i) => i);
  const results = await Promise.all(
    ids.map(async (id) => {
      const c = await shareAuction.companies(id);
      return { id, ...c };
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
  const events = await shareAuction.queryFilter(filter, 0, "latest");
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
