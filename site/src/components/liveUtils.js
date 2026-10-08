// Shared values and hooks for the live (on-chain) screens. The matching
// visual pieces are in ui.jsx.
import { useState, useEffect, useCallback } from "react";
import { friendlyError } from "../web3.js";

export const C = {
  text: "#EDE6D6",
  ink: "#141B18",
  accent: "#C98A3E",
  danger: "#C97D6F",
  ok: "#7FA37A",
  line: "rgba(237,230,214,0.1)",
};

export const ZERO = "0x0000000000000000000000000000000000000000";
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
// "1 share", "2 shares": a count (number or bigint) with the right noun.
export const count = (n, one, many = one + "s") => `${n.toLocaleString()} ${BigInt(n) === 1n ? one : many}`;
export const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Whole-number display for 18-decimal amounts, with up to `places` decimals.
export function fmt(raw, decimals = 18, places = 2) {
  if (raw === null || raw === undefined) return "…";
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = "";
  if (places > 0) {
    const f = (v % base) * 10n ** BigInt(places) / base;
    frac = f === 0n ? "" : "." + f.toString().padStart(places, "0").replace(/0+$/, "");
  }
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + frac;
}

export function fmtDate(seconds) {
  if (!seconds) return "";
  return new Date(Number(seconds) * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Ticking countdown to a unix timestamp (seconds, bigint or number).
export function useCountdown(endSeconds) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const end = Number(endSeconds || 0);
  const remaining = Math.max(0, end - now);
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  return { passed: end > 0 && remaining === 0, label: d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s` };
}

// One busy flag and one error line per section. `run(fn, after)` runs a
// transaction, shows a readable error if it fails, then calls `after`.
export function useTx() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (fn, after) => {
    setError("");
    setBusy(true);
    try {
      const out = await fn();
      if (after) await after(out);
      return out;
    } catch (err) {
      setError(friendlyError(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
