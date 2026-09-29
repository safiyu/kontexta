"use client";

import { useEffect, useMemo, useState } from "react";
import { Folder } from "lucide-react";
import { InstallSnippetView } from "@/components/docs/install-snippet-view";
import { useAgents } from "@/hooks/use-agents";

const CLIENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini" },
  { id: "antigravity", label: "Antigravity" },
  { id: "continue", label: "Continue" },
  { id: "aider", label: "Aider" },
  { id: "cline", label: "Cline" },
  { id: "copilot", label: "GitHub Copilot (VS Code Insider)" },
  { id: "hermes", label: "Hermes Agent" },
  { id: "generic", label: "Generic JSON" },
];
const INSTALLS = [
  { id: "docker", label: "Docker" },
  { id: "npm", label: "npm (npx)" },
  { id: "source", label: "Source build" },
];

export function InstallSection() {
  const [client, setClient] = useState("claude-code");
  const [install, setInstall] = useState("docker");
  const [snippet, setSnippet] = useState<{ body: string; configPath?: string; notes?: string[] } | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const [dataDirInfo, setDataDirInfo] = useState<{ dataDir: string; isDefaultDir: boolean; defaultDirDisplay: string } | null>(null);

  const { state: agentsState } = useAgents();
  const enabledIds = useMemo(() => new Set((agentsState?.agents ?? []).filter((a) => a.enabled).map((a) => a.id)), [agentsState]);
  // Fail open: with no agents state we cannot tell what is enabled, so show everything.
  const visibleClients = useMemo(
    () => (agentsState ? CLIENTS.filter((c) => c.id === "generic" || enabledIds.has(c.id)) : CLIENTS),
    [agentsState, enabledIds],
  );
  const nothingEnabled = !!agentsState && enabledIds.size === 0;

  useEffect(() => {
    if (!visibleClients.some((c) => c.id === client)) setClient(visibleClients[0].id);
  }, [visibleClients, client]);

  useEffect(() => {
    fetch(`/api/install-snippets?client=${client}&install=${install}&t=${Date.now()}`)
      .then((r) => r.json())
      .then((j) => {
        setSnippet(j);
        if (j.detectedInstall && !detected) setDetected(j.detectedInstall);
        if (j.dataDir) setDataDirInfo({ dataDir: j.dataDir, isDefaultDir: j.isDefaultDir, defaultDirDisplay: j.defaultDirDisplay });
      })
      .catch(() => {});
  }, [client, install, detected]);

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex gap-3 mb-4">
        <label className="flex flex-col text-xs">
          <span className="mb-1 text-[var(--text-secondary)]">AI client</span>
          <select aria-label="AI client" value={client} onChange={(e) => setClient(e.target.value)} className="px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded">
            {visibleClients.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs">
          <span className="mb-1 text-[var(--text-secondary)]">Install method</span>
          <select aria-label="Install method" value={install} onChange={(e) => setInstall(e.target.value)} className="px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded">
            {INSTALLS.map((i) => <option key={i.id} value={i.id}>{i.label}{detected === i.id ? " (current)" : ""}</option>)}
          </select>
        </label>
      </div>
      {nothingEnabled && (
        <p className="mb-3 text-xs text-[var(--text-secondary)]">No agents enabled yet — enable the agents you use in the AGENTS tab to see their config here.</p>
      )}
      {agentsState && !nothingEnabled && (
        <p className="mb-3 text-xs text-[var(--text-secondary)]">Missing an agent? Enable it in the AGENTS tab.</p>
      )}
      {dataDirInfo && (
        <div className="mb-3 text-xs text-[var(--text-secondary)] flex items-center gap-1.5">
          <Folder className="w-3.5 h-3.5 opacity-60" aria-hidden />
          <span>
            Data directory:{" "}
            <code className="text-[var(--text-primary)] font-mono">
              {dataDirInfo.isDefaultDir ? dataDirInfo.defaultDirDisplay : dataDirInfo.dataDir}
            </code>
            {dataDirInfo.isDefaultDir && (
              <span className="ml-1 opacity-60">(OS default)</span>
            )}
          </span>
        </div>
      )}
      {snippet && (
        <InstallSnippetView
          body={snippet.body}
          configPath={snippet.configPath}
          notes={snippet.notes}
        />
      )}
    </div>
  );
}
