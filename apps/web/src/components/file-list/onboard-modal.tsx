"use client";

import { useState } from "react";

interface OnboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
  projectName: string;
  onOnboarded: () => void;
}

const AGENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "aider", label: "Aider" },
  { id: "continue", label: "Continue" },
  { id: "gemini", label: "Gemini / Antigravity" },
  { id: "copilot", label: "GitHub Copilot" },
  { id: "codex", label: "Codex" },
  { id: "generic", label: "Generic JSON" },
];

export function OnboardModal({ isOpen, onClose, projectId, projectName, onOnboarded }: OnboardModalProps) {
  const [targetAgent, setTargetAgent] = useState("aider");
  const [loading, setLoading] = useState(false);

  const handleOnboard = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetAgent }),
      });
      if (res.ok) {
        onOnboarded();
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || `Onboarding failed: HTTP ${res.status}`);
      }
    } catch (e) {
      alert("Failed to connect to server");
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="w-[500px] bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-2xl overflow-hidden animate-fade-in">
        <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <h3 className="text-lg font-bold text-amber-accent uppercase tracking-wider">ONBOARD AGENT</h3>
          <button type="button" onClick={onClose} className="btn btn-icon-md" aria-label="Close dialog">✕</button>
        </div>

        <div className="p-6 space-y-4">
          <div className="text-sm text-[var(--text-secondary)] leading-relaxed">
            Scaffold workflow rules for <strong>{projectName}</strong>. This writes a context file (like <code>.aider/kontexta.md</code>) to the project root.
          </div>

          <div className="space-y-2">
            <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest uppercase">TARGET AGENT</label>
            <select
              value={targetAgent}
              onChange={(e) => setTargetAgent(e.target.value)}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-amber-accent/50 cursor-pointer"
            >
              {AGENTS.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>

          {targetAgent === "aider" && (
            <div className="p-3 bg-amber-500/5 border border-amber-500/20 rounded text-[11px] text-amber-600 dark:text-amber-400 leading-normal">
              <strong>Aider Note:</strong> Integration is file-based. After onboarding, ensure your <code>.aider.conf.yml</code> reads the new file.
            </div>
          )}
        </div>

        <div className="px-6 py-4 bg-[var(--bg-secondary)]/50 border-t border-[var(--border)] flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-md"
            disabled={loading}
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={handleOnboard}
            disabled={loading}
            className="btn btn-md min-w-[140px]"
          >
            {loading ? "ONBOARDING..." : "ONBOARD AGENT"}
          </button>
        </div>
      </div>
    </div>
  );
}
