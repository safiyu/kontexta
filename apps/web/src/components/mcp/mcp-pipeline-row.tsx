export type MCPPipelineRowStatus = "active" | "idle";

export interface MCPPipelineRowProps {
  label: string;
  result: string;
  status: MCPPipelineRowStatus;
}

export function MCPPipelineRow({ label, result, status }: MCPPipelineRowProps) {
  const isActive = status === "active";
  const dotStyle: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: isActive ? "var(--accent)" : "var(--border)",
    boxShadow: isActive ? "0 0 8px rgba(180,120,30,0.6)" : "none",
    flexShrink: 0,
  };
  const lineStyle: React.CSSProperties = {
    flex: 1,
    height: 1,
    background: isActive
      ? "linear-gradient(90deg, var(--accent), var(--border))"
      : "var(--border)",
  };
  const labelStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: 12,
    color: isActive ? "var(--text-primary)" : "var(--muted)",
  };
  const resultStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: 12,
    color: isActive ? "var(--accent)" : "var(--muted)",
  };

  return (
    <div
      data-status={status}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 0",
      }}
    >
      <span style={dotStyle} aria-hidden="true" />
      <span style={labelStyle}>{label}</span>
      <span style={lineStyle} aria-hidden="true" />
      <span style={resultStyle}>{result}</span>
    </div>
  );
}
