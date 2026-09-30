"use client";

import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AgentInfo, AgentsState, McpApproval, McpOutcome } from "@/hooks/use-agents";

type McpAction = (id: string, action: "install" | "uninstall", approval?: McpApproval) => Promise<{ ok: boolean; outcome?: McpOutcome; error?: string }>;

const LEVELS: Array<{ value: McpApproval; label: string }> = [
  { value: "prompt", label: "Ask for each tool (default)" },
  { value: "safe", label: "Allow safe tools" },
  { value: "all", label: "Allow all tools" },
];

function describe(o: McpOutcome | undefined, fallback: string | undefined, verb: "connect" | "disconnect"): string {
  if (!o) return fallback ?? "Request failed.";
  if (!o.ok) return `${verb === "connect" ? "Connect" : "Disconnect"} failed: ${o.error}`;
  const base = verb === "connect" ? (o.changed ? "MCP connected." : "MCP already up to date.") : (o.changed ? "MCP disconnected." : "Nothing to disconnect.");
  return o.notes.length > 0 ? `${base} ${o.notes.join(" ")}` : base;
}

export function McpControls({ agent: a, state, mcpAction }: { agent: AgentInfo; state: AgentsState; mcpAction: McpAction }) {
  const [level, setLevel] = useState<McpApproval>(a.mcp_approval ?? "prompt");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { setLevel(a.mcp_approval ?? "prompt"); }, [a.mcp_approval]);

  async function run(action: "install" | "uninstall", approval: McpApproval) {
    setBusy(true);
    const r = await mcpAction(a.id, action, approval);
    setMessage(describe(r.outcome, r.error, action === "install" ? "connect" : "disconnect"));
    setBusy(false);
  }

  const onConnect = () => { if (level === "all") setConfirming(true); else void run("install", level); };
  const dockerBase = state.mcp_docker_commands?.[a.id];
  const dockerCmd = dockerBase ? (level === "prompt" ? dockerBase : `${dockerBase} --approval ${level}`) : null;

  const managed = a.mcp_installed;
  const hasEntry = a.mcp_installed || !!a.mcp_present;
  const status = !managed && a.mcp_present ? "MCP connected (configured by hand)" : a.mcp_installed ? `MCP connected${a.mcp_current ? "" : " (out of date)"}${a.mcp_approval !== "prompt" ? ` · ${LEVELS.find((l) => l.value === a.mcp_approval)?.label.toLowerCase()}` : ""}` : "MCP not connected";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-[var(--text-secondary)]">{status}</span>
        {a.mcp_approval_supported ? (
          <select
            aria-label={`MCP approval for ${a.name}`}
            className="rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-primary)]"
            value={level}
            onChange={(e) => setLevel(e.target.value as McpApproval)}
          >
            {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        ) : (
          <span className="text-[var(--text-secondary)]">Approve kxta tools in the app itself (no config-file allowlist).</span>
        )}
        {!dockerCmd && (
          <span className="flex gap-2">
            <button className="btn btn-sm" disabled={busy} aria-label={`${hasEntry ? "Update" : "Connect"} MCP for ${a.name}`} onClick={onConnect}>
              {hasEntry ? "Update MCP" : "Connect MCP"}
            </button>
            {a.mcp_installed && (
              <button className="btn btn-sm btn-destructive" disabled={busy} aria-label={`Disconnect MCP for ${a.name}`} onClick={() => void run("uninstall", "prompt")}>Disconnect</button>
            )}
          </span>
        )}
      </div>
      {dockerCmd && (
        <div className="space-y-1">
          {dockerCmd.includes("<DATA_DIR>") && <p className="text-xs text-[var(--text-secondary)]">Replace &lt;DATA_DIR&gt; with the absolute path of your data folder (the one mounted at /app/data).</p>}
          {level === "all" && <p className="text-xs text-[var(--danger)]">This allows every kxta tool without asking, including delete tools.</p>}
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto text-xs bg-[var(--bg-secondary)] p-2 rounded">{dockerCmd}</pre>
            <button
              className="btn btn-icon-sm btn-outline"
              aria-label={`Copy MCP command for ${a.name}`}
              onClick={async () => { try { await navigator.clipboard.writeText(dockerCmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ } }}
            >
              {copied ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
            </button>
          </div>
        </div>
      )}
      {message && <p className="text-xs text-[var(--text-secondary)]" role="status">{message}</p>}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); void run("install", "all"); }}
        title={`Allow every kxta tool for ${a.name}?`}
        message={
          <>
            <p>{a.name} will call every kxta tool without asking, including the ones that delete or overwrite data: <strong>{state.destructive_tools.join(", ")}</strong>. It also covers per-project hands tools, which run scripts.</p>
            <p className="mt-2">You can switch back to asking at any time.</p>
          </>
        }
        confirmLabel="Allow all"
        destructive
      />
    </div>
  );
}
