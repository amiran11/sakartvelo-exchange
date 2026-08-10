import { useState, useEffect } from "react";

const CONSENT_KEY = "sakartvelo_analytics_consent"; // "granted" | "denied"
const GA_MEASUREMENT_ID = "G-2CHEJDL9S9";

// Actually loads GA — only ever called after real, explicit consent.
// Dynamically injecting these is fine under the existing CSP: the policy
// checks the script's source domain, not how the tag entered the DOM, and
// googletagmanager.com is already allowlisted in vercel.json.
function loadAnalytics() {
  if (document.getElementById("ga-script")) return; // already loaded, don't double-inject

  const gtagScript = document.createElement("script");
  gtagScript.id = "ga-script";
  gtagScript.async = true;
  gtagScript.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(gtagScript);

  const initScript = document.createElement("script");
  initScript.src = "/gtag-init.js";
  document.head.appendChild(initScript);
}

export default function ConsentBanner() {
  const [choice, setChoice] = useState(undefined); // undefined = still checking

  useEffect(() => {
    const saved = localStorage.getItem(CONSENT_KEY);
    setChoice(saved || null);
    if (saved === "granted") loadAnalytics();
  }, []);

  const handleAccept = () => {
    localStorage.setItem(CONSENT_KEY, "granted");
    setChoice("granted");
    loadAnalytics();
  };

  const handleDecline = () => {
    localStorage.setItem(CONSENT_KEY, "denied");
    setChoice("denied");
    // Deliberately nothing else happens here — GA never loads at all.
  };

  // Still checking localStorage, or a choice already exists — no banner.
  if (choice === undefined || choice !== null) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        background: "#1B2622",
        borderTop: "1px solid rgba(237,230,214,0.15)",
        padding: "16px 20px",
        boxShadow: "0 -8px 24px rgba(0,0,0,0.3)",
      }}
    >
      <div
        style={{
          maxWidth: 900,
          margin: "0 auto",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ color: "#EDE6D6", fontSize: 12.5, lineHeight: 1.5, flex: "1 1 400px" }}>
          This site uses Google Analytics to understand engagement — nothing loads until you
          choose. Declining doesn't limit anything else on the site.
        </div>
        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          <button
            onClick={handleDecline}
            className="mono"
            style={{
              background: "transparent",
              color: "#EDE6D6",
              border: "1px solid rgba(237,230,214,0.3)",
              padding: "8px 18px",
              borderRadius: 3,
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            DECLINE
          </button>
          <button
            onClick={handleAccept}
            className="mono"
            style={{
              background: "#C98A3E",
              color: "#141B18",
              border: "none",
              padding: "8px 18px",
              borderRadius: 3,
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            ACCEPT
          </button>
        </div>
      </div>
    </div>
  );
}
