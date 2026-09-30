"use client";

import { useState, useEffect } from "react";
import { AlertCircle, Copy, Check } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { useAgents, type ToggleResult } from "@/hooks/use-agents";

interface FirstRunWizardProps {
  open: boolean;
  onClose: () => void;
  initialStep?: number;
  projects: any[];
  onSaved: () => void;
}

interface ProfileSections { name: string; role: string; vision: string; roadmap: string; preferences: string; sessionCodingStyle: string; teamMembersAndRoles: string; notes: string }

const TITLES: Record<number, string> = {
  1: "Which coding agents do you use?",
  2: "Install hooks",
  3: "Set Up Your Profile",
};
const DESCRIPTIONS: Record<number, string> = {
  1: "Pick the agents you use. Kontexta installs hooks for them so your conversations and shell commands reach the journal — agents you leave off are ignored everywhere.",
  2: "Result of installing hooks for each agent you selected.",
  3: "Help AI agents understand you better by filling in your profile.",
};
const FIELD = "w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]";
const PRIMARY = "btn btn-md btn-primary";
const SECONDARY = "btn btn-md btn-outline";

export function FirstRunWizard({ open, onClose, initialStep = 1, onSaved }: FirstRunWizardProps) {
  const { state, setEnabled, hooksAction } = useAgents();
  const [step, setStep] = useState(initialStep);
  const [sections, setSections] = useState<ProfileSections>({ name: "", role: "", vision: "", roadmap: "", preferences: "", sessionCodingStyle: "", teamMembersAndRoles: "", notes: "" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [results, setResults] = useState<Record<string, ToggleResult>>({});
  const [retryErrors, setRetryErrors] = useState<Record<string, string | null>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the wizard opens
  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
    setError(null);
  }, [open, initialStep]);

  useEffect(() => {
    if (state && !seeded) { setSelected(new Set(state.agents.filter((a) => a.enabled).map((a) => a.id))); setSeeded(true); }
  }, [state, seeded]);

  const agents = state?.agents ?? [];

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const applyAgents = async () => {
    setSaving(true); setError(null);
    const next: Record<string, ToggleResult> = {};
    for (const a of agents) {
      const want = selected.has(a.id);
      if (want === a.enabled) continue;
      const r = await setEnabled(a.id, want);
      if (!r) { setError(`Could not ${want ? "enable" : "disable"} ${a.name}`); setSaving(false); return; }
      if (want) next[a.id] = r;
    }
    setResults(next);
    setSaving(false);
    setStep(2);
  };

  const retry = async (id: string) => {
    const r = await hooksAction(id, "install");
    setRetryErrors((e) => ({ ...e, [id]: r.outcome?.ok ? null : (r.outcome?.error ?? r.error ?? "Install failed") }));
  };

  const copy = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); } catch { /* clipboard unavailable */ }
  };

  const handleSaveProfile = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sections }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to save profile");
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Failed to save profile");
    } finally { setSaving(false); }
  };

  const hooksRow = (id: string) => {
    const a = agents.find((x) => x.id === id);
    if (!a) return null;
    const r = results[id];
    const retryErr = retryErrors[id];
    const failure = retryErr !== undefined ? retryErr : (r?.install && !r.install.ok ? `Install failed: ${r.install.error}` : null);
    const dockerCmd = r?.docker_command ?? state?.docker_commands[id] ?? null;
    let body: React.ReactNode;
    if (!a.hooks_supported) body = <span className="text-[var(--text-secondary)]">MCP capture only — this agent has no hook API.</span>;
    else if (state?.install_mode === "docker" && dockerCmd) body = (
      <div className="space-y-1">
        {dockerCmd.includes("<DATA_DIR>") && (
          <p className="text-xs text-[var(--text-secondary)]">Replace &lt;DATA_DIR&gt; with the absolute path of your data folder (the one mounted at /app/data).</p>
        )}
        <div className="flex items-start gap-2">
          <pre className="flex-1 overflow-x-auto text-xs bg-[var(--bg-primary)] p-2 rounded">{dockerCmd}</pre>
          <button className="btn btn-icon-sm btn-outline" aria-label={`Copy install command for ${a.name}`} onClick={() => void copy(id, dockerCmd)}>
            {copied === id ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
          </button>
        </div>
      </div>
    );
    else if (failure) body = (
      <span className="flex items-center gap-2 text-[var(--danger)]">
        {failure}
        <button className="btn btn-sm btn-outline" aria-label={`Retry ${a.name}`} onClick={() => void retry(id)}>Retry</button>
      </span>
    );
    else if (a.hooks_installed) body = <span>{a.name} installed ✓</span>;
    else body = <span className="text-[var(--text-secondary)]">Not installed yet.</span>;
    return <li key={id} className="rounded-md border border-[var(--border)] p-3 text-sm"><div className="font-medium mb-1">{a.name}</div>{body}</li>;
  };

  return (
    <Dialog open={open} onClose={onClose} title={TITLES[step]} description={DESCRIPTIONS[step]} widthClass="max-w-2xl">
      <div className="overflow-y-auto p-6 text-[var(--text-primary)]">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-md bg-[var(--danger-soft)] p-3 text-sm text-[var(--danger)]" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {agents.map((a) => (
                <label key={a.id} className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-3 text-sm hover:bg-[var(--bg-tertiary)] cursor-pointer">
                  <input type="checkbox" aria-label={a.name} checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                  <span>
                    <span className="font-medium">{a.name}</span>
                    {!a.hooks_supported && <span className="block text-xs text-[var(--text-secondary)]">MCP capture only</span>}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button className={SECONDARY} onClick={() => setStep(3)}>Skip for now</button>
              <button className={PRIMARY} onClick={() => void applyAgents()} disabled={saving || !state}>{saving ? "Applying…" : "Continue"}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <ul className="space-y-2">
              {[...selected].map((id) => hooksRow(id))}
              {selected.size === 0 && <li className="text-sm text-[var(--text-secondary)]">No agents enabled — you can enable them later from Configure → AGENTS.</li>}
            </ul>
            <div className="flex justify-end gap-2 pt-4">
              <button className={SECONDARY} onClick={() => setStep(1)}>Back</button>
              <button className={PRIMARY} onClick={() => setStep(3)}>Continue</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            {([
              { key: "name", label: "Name", multiline: false, placeholder: "e.g. Alex" },
              { key: "role", label: "Role", multiline: false, placeholder: "e.g. Full-stack engineer" },
              { key: "vision", label: "Vision", multiline: false, placeholder: "e.g. Improve API performance and developer workflows" },
              { key: "roadmap", label: "Roadmap", multiline: false, placeholder: "e.g. Q3 auth refactor; performance benchmarking" },
              { key: "preferences", label: "Preferences", multiline: false, placeholder: "e.g. TypeScript, concise explanations, TDD" },
              { key: "sessionCodingStyle", label: "Session coding style", multiline: true, placeholder: "e.g. one-line comments only; no auto push to git; ask before migrations" },
              { key: "teamMembersAndRoles", label: "Team members & roles", multiline: true, placeholder: "e.g. Alice — Product Manager\nBob — DevOps / SRE" },
              { key: "notes", label: "Notes", multiline: true, placeholder: "Free-form scratch space." },
            ] as const).map(({ key, label, multiline, placeholder }) => (
              <div key={key}>
                <label htmlFor={`wizard-${key}`} className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">{label}</label>
                {multiline ? (
                  <textarea id={`wizard-${key}`} value={sections[key]} onChange={(e) => setSections({ ...sections, [key]: e.target.value })} className={FIELD} rows={3} placeholder={placeholder} />
                ) : (
                  <input id={`wizard-${key}`} type="text" value={sections[key]} onChange={(e) => setSections({ ...sections, [key]: e.target.value })} className={FIELD} placeholder={placeholder} />
                )}
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-4">
              <button className={SECONDARY} onClick={onClose}>Skip</button>
              <button className={PRIMARY} onClick={() => void handleSaveProfile()} disabled={saving}>{saving ? "Saving..." : "Finish & Launch"}</button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
