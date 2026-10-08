// Shared visual pieces for the live (on-chain) screens, so the auction,
// election and treasury sections look the same.
import { Loader2 } from "lucide-react";
import { C } from "./liveUtils.js";

export function Button({ kind = "primary", busy, disabled, children, small, ...rest }) {
  const styles = {
    primary: { background: C.accent, color: C.ink, border: "none" },
    light: { background: C.text, color: "#1C1A16", border: "none" },
    outline: { background: "transparent", color: C.accent, border: `1px solid ${C.accent}` },
    quiet: { background: "transparent", color: C.text, border: `1px solid rgba(237,230,214,0.3)` },
  };
  const off = disabled || busy;
  return (
    <button
      {...rest}
      disabled={off}
      className="mono inline-flex items-center gap-1"
      style={{
        ...styles[kind], padding: small ? "4px 10px" : "7px 14px", borderRadius: 3, fontWeight: 700,
        fontSize: small ? 10.5 : 11.5, cursor: off ? "default" : "pointer", opacity: off ? 0.55 : 1,
      }}
    >
      {busy && <Loader2 size={11} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Input(props) {
  return (
    <input
      {...props}
      className="mono"
      style={{
        width: "100%", background: "rgba(237,230,214,0.08)", border: "1px solid rgba(237,230,214,0.2)",
        borderRadius: 3, padding: "7px 9px", color: C.text, fontSize: 11.5, ...(props.style || {}),
      }}
    />
  );
}

export function Select({ children, ...props }) {
  return (
    <select
      {...props}
      className="mono"
      style={{ width: "100%", background: "#1B2622", border: "1px solid rgba(237,230,214,0.2)", borderRadius: 3, padding: "7px 9px", color: C.text, fontSize: 11.5 }}
    >
      {children}
    </select>
  );
}

export function Field({ label, children, hint }) {
  return (
    <label className="mono" style={{ display: "block", fontSize: 10.5, marginBottom: 8 }}>
      <span style={{ opacity: 0.7, display: "block", marginBottom: 3 }}>{label}</span>
      {children}
      {hint && <span style={{ opacity: 0.5, display: "block", marginTop: 3 }}>{hint}</span>}
    </label>
  );
}

export function Notice({ color = C.accent, children }) {
  return (
    <div className="mono" style={{ background: `${color}1A`, border: `1px solid ${color}`, borderRadius: 4, padding: 12, marginBottom: 10, fontSize: 11, lineHeight: 1.55 }}>
      {children}
    </div>
  );
}

export function Muted({ children, style }) {
  return <div className="mono" style={{ fontSize: 11, opacity: 0.55, lineHeight: 1.55, ...style }}>{children}</div>;
}

export function ErrorLine({ error }) {
  if (!error) return null;
  return <div className="mono" style={{ fontSize: 11, color: C.danger, marginTop: 8, lineHeight: 1.5 }}>{error}</div>;
}

// A labelled block inside a company card.
export function Section({ icon: Icon, title, right, children }) {
  return (
    <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 14, paddingTop: 14 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <div className="flex items-center gap-2 mono" style={{ fontSize: 11.5, opacity: 0.75 }}>
          {Icon && <Icon size={12} />} {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// A row with a label on the left and a value on the right.
export function Row({ label, children }) {
  return (
    <div className="mono flex justify-between gap-3" style={{ fontSize: 11.5, padding: "3px 0" }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span style={{ textAlign: "right" }}>{children}</span>
    </div>
  );
}
