export type MCPPipelineRowStatus = "active" | "idle";

export interface MCPPipelineRowProps {
  label: string;
  result: string;
  status: MCPPipelineRowStatus;
}

export function MCPPipelineRow({ label, result, status }: MCPPipelineRowProps) {
  const isActive = status === "active";

  return (
    <div data-status={status} className="flex items-center gap-2 py-1.5">
      <span
        className={`w-2 h-2 rounded-full bp-keep-round flex-shrink-0 ${
          isActive
            ? "bg-[var(--accent)] shadow-[0_0_8px_color-mix(in_srgb,var(--accent)_60%,transparent)]"
            : "bg-[var(--border)]"
        }`}
        aria-hidden="true"
      />
      <span
        className={`font-mono text-xs ${
          isActive ? "text-[var(--text-primary)]" : "text-[var(--muted)]"
        }`}
      >
        {label}
      </span>
      <span
        className={`flex-1 h-px ${
          isActive
            ? "bg-gradient-to-r from-[var(--accent)]/60 to-transparent"
            : "bg-[var(--border)]"
        }`}
        aria-hidden="true"
      />
      <span
        className={`font-mono text-xs ${
          isActive ? "text-[var(--accent)]" : "text-[var(--muted)]"
        }`}
      >
        {result}
      </span>
    </div>
  );
}
