"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";

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
        toast.success(`Onboarded ${projectName}`);
        onOnboarded();
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || `Onboarding failed: HTTP ${res.status}`);
      }
    } catch (e) {
      toast.error("Failed to connect to server");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} title="Onboard agent" widthClass="max-w-[500px]">
      <div className="space-y-4">
        <div className="text-sm text-[var(--text-secondary)] leading-relaxed">
          Scaffold workflow rules for <strong>{projectName}</strong>. This writes a context file (like <code>.aider/kontexta.md</code>) to the project root.
        </div>

        <div className="space-y-2">
          <label className="block text-[10px] font-bold text-[#475569] dark:text-[#94A3B8] tracking-widest uppercase">Target agent</label>
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
            <strong>Aider note:</strong> Integration is file-based. After onboarding, ensure your <code>.aider.conf.yml</code> reads the new file.
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-md"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleOnboard}
            disabled={loading}
            className="btn btn-md min-w-[140px]"
          >
            {loading ? "Onboarding…" : "Onboard agent"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
