import { useState } from "react";
import { Wallet as WalletIcon, ExternalLink, Loader2 } from "lucide-react";
import { connectWallet, getClaimEligibility, claimReal, CONTRACT_ADDRESSES, ACTIVE_NETWORK, isMobileDevice, getMetaMaskDeepLink } from "../web3.js";
import RealAuctions from "./RealAuctions.jsx";
import RealRoundAuctions from "./RealRoundAuctions.jsx";

// This screen talks to the REAL deployed contracts on Arbitrum One — not
// the simulated game. Kept as its own component, deliberately separate
// from App.jsx's simulation, so it's obvious which one is real.
export default function RealExchange({ onBack }) {
  const [wallet, setWallet] = useState(null); // { provider, signer, address }
  const [eligibility, setEligibility] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | connecting | checking | claiming | claimed | error
  const [errorMsg, setErrorMsg] = useState("");
  const [isMobileWalletError, setIsMobileWalletError] = useState(false);
  const [txHash, setTxHash] = useState(null);

  const handleConnect = async () => {
    setStatus("connecting");
    setErrorMsg("");
    setIsMobileWalletError(false);
    try {
      const w = await connectWallet();
      setWallet(w);
      setStatus("checking");
      const e = await getClaimEligibility(w.address, w.provider);
      setEligibility(e);
      setStatus("idle");
    } catch (err) {
      setErrorMsg(err.message || "Connection failed.");
      setIsMobileWalletError(!!err.isMobileNoWallet);
      setStatus("error");
    }
  };

  const handleClaim = async () => {
    if (!wallet) return;
    setStatus("claiming");
    setErrorMsg("");
    try {
      const receipt = await claimReal(wallet.signer);
      setTxHash(receipt.hash);
      setStatus("claimed");
      const e = await getClaimEligibility(wallet.address, wallet.provider);
      setEligibility(e);
    } catch (err) {
      setErrorMsg(err.shortMessage || err.message || "Transaction failed.");
      setStatus("error");
    }
  };

  return (
    <div style={{ fontFamily: "Inter, sans-serif", background: "linear-gradient(180deg,#141B18,#1B2622)", minHeight: "100vh", color: "#EDE6D6" }}>
      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid rgba(237,230,214,0.15)" }}>
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" width="26" height="26" style={{ borderRadius: 6 }} />
          <div className="zilla" style={{ fontSize: 20, fontWeight: 700 }}>SAKARTVELO EXCHANGE — LIVE ({ACTIVE_NETWORK.label})</div>
        </div>
        <button onClick={onBack} className="mono" style={{ fontSize: 11, background: "rgba(237,230,214,0.08)", border: "none", color: "#EDE6D6", cursor: "pointer", padding: "8px 14px", borderRadius: 3 }}>
          ← BACK TO DEMO
        </button>
      </div>

      <div className="px-6 py-12" style={{ maxWidth: 640, margin: "0 auto" }}>
        <div style={{ background: "rgba(201,138,62,0.12)", border: "1px solid #C98A3E", borderRadius: 4, padding: "14px 16px", marginBottom: 32 }}>
          <div className="mono" style={{ fontSize: 11, fontWeight: 700, color: "#C98A3E", marginBottom: 4 }}>
            {ACTIVE_NETWORK.isTestnet ? "⚠ REAL TRANSACTIONS, TEST NETWORK" : "⚠ REAL TRANSACTIONS, REAL MONEY"}
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, opacity: 0.85 }}>
            {ACTIVE_NETWORK.isTestnet ? (
              <>
                This screen calls the actual deployed contracts on {ACTIVE_NETWORK.label} — real transactions, real gas,
                real confirmations. {ACTIVE_NETWORK.label} ETH has no monetary value, but the mechanism itself is fully real,
                not simulated. You'll need a verified wallet and a small amount of {ACTIVE_NETWORK.label} ETH for gas.
              </>
            ) : (
              <>
                This screen calls the actual deployed contracts on {ACTIVE_NETWORK.label} — a real network where
                gas costs real money and every transaction is permanent and irreversible. Gas fees here are
                small (typically well under a cent per action), but they are real. You'll need a verified
                wallet and a small amount of ETH on {ACTIVE_NETWORK.label} to participate. INVEST itself remains
                part of a fictional simulation — not a real financial product or investment.
              </>
            )}
          </div>
        </div>

        {!wallet ? (
          <div>
            {isMobileDevice() && (
              <div className="mono" style={{ fontSize: 11.5, opacity: 0.6, marginBottom: 12, lineHeight: 1.6 }}>
                On mobile: this only works from inside the MetaMask app's own browser — having MetaMask
                installed as a phone app isn't enough by itself. If "Connect" doesn't work below, use the
                "open in MetaMask app" button that appears.
              </div>
            )}
            <button
              onClick={handleConnect}
              disabled={status === "connecting"}
              className="mono flex items-center gap-2"
              style={{ background: "#EDE6D6", color: "#1C1A16", border: "none", padding: "12px 28px", borderRadius: 3, fontWeight: 700, cursor: "pointer", fontSize: 13 }}
            >
              {status === "connecting" ? <Loader2 size={14} className="animate-spin" /> : <WalletIcon size={14} />}
              {status === "connecting" ? "CONNECTING..." : "CONNECT REAL WALLET"}
            </button>
          </div>
        ) : (
          <div>
            <div className="mono" style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>
              Connected: {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
            </div>

            {status === "checking" && <div className="mono" style={{ fontSize: 12, opacity: 0.6 }}>Checking claim eligibility on-chain…</div>}

            {eligibility && (
              <div style={{ background: "rgba(237,230,214,0.05)", border: "1px solid rgba(237,230,214,0.15)", borderRadius: 6, padding: 20, marginBottom: 20 }}>
                <div className="mono" style={{ fontSize: 11, opacity: 0.5, marginBottom: 10 }}>ON-CHAIN STATUS</div>
                <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                  Verified citizen: <strong>{eligibility.isVerified ? "yes" : "no"}</strong><br/>
                  Already claimed: <strong>{eligibility.alreadyClaimed ? "yes" : "no"}</strong><br/>
                  Citizens so far: <strong>{eligibility.citizenCount.toString()} / {eligibility.maxCitizens.toString()}</strong>
                </div>

                {eligibility.canClaim ? (
                  <button
                    onClick={handleClaim}
                    disabled={status === "claiming"}
                    className="mono flex items-center gap-2"
                    style={{ marginTop: 16, background: "#C98A3E", color: "#141B18", border: "none", padding: "10px 22px", borderRadius: 3, fontWeight: 700, cursor: "pointer", fontSize: 13 }}
                  >
                    {status === "claiming" ? <Loader2 size={14} className="animate-spin" /> : null}
                    {status === "claiming" ? "CONFIRMING ON-CHAIN..." : "CLAIM 1000 INVEST (REAL TRANSACTION)"}
                  </button>
                ) : !eligibility.isVerified ? (
                  <div className="mono" style={{ marginTop: 16, fontSize: 12, color: "#C97D6F" }}>
                    This wallet isn't verified yet. The contract owner needs to call setVerifiedCitizen() for this address first.
                  </div>
                ) : eligibility.alreadyClaimed ? (
                  <div className="mono" style={{ marginTop: 16, fontSize: 12, opacity: 0.6 }}>Already claimed — nothing left to do here.</div>
                ) : null}
              </div>
            )}

            {status === "claimed" && txHash && (
              <div style={{ background: "rgba(79,122,82,0.15)", border: "1px solid #4F7A52", borderRadius: 6, padding: 16 }}>
                <div className="mono" style={{ fontSize: 12, marginBottom: 6 }}>✅ Claimed for real.</div>
                <a
                  href={`${ACTIVE_NETWORK.blockExplorerUrls[0]}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mono flex items-center gap-1"
                  style={{ fontSize: 11, color: "#7FAF8E" }}
                >
                  View on Etherscan <ExternalLink size={11} />
                </a>
              </div>
            )}

            <RealAuctions wallet={wallet} />

            <RealRoundAuctions wallet={wallet} />
          </div>
        )}

        {status === "error" && (
          <div style={{ marginTop: 16 }}>
            <div className="mono" style={{ fontSize: 12, color: "#C97D6F", marginBottom: isMobileWalletError ? 12 : 0 }}>
              {errorMsg}
            </div>
            {isMobileWalletError && (
              <a
                href={getMetaMaskDeepLink()}
                className="mono flex items-center gap-2"
                style={{ display: "inline-flex", background: "#EDE6D6", color: "#1C1A16", border: "none", padding: "10px 20px", borderRadius: 3, fontWeight: 700, cursor: "pointer", fontSize: 12.5, textDecoration: "none" }}
              >
                <WalletIcon size={13} /> OPEN THIS PAGE IN THE METAMASK APP
              </a>
            )}
          </div>
        )}

        <div className="mono" style={{ fontSize: 10, opacity: 0.4, marginTop: 40, lineHeight: 1.6 }}>
          Contract addresses ({ACTIVE_NETWORK.label}):<br/>
          InvestToken: {CONTRACT_ADDRESSES.InvestToken}<br/>
          ShareAuction: {CONTRACT_ADDRESSES.ShareAuction}<br/>
          CompanyTreasury: {CONTRACT_ADDRESSES.CompanyTreasury}<br/>
          RoundAuction: {CONTRACT_ADDRESSES.RoundAuction}
        </div>
      </div>
    </div>
  );
}
