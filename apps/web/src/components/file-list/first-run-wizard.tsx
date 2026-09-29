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

interface ProfileSections { name: string; role: string; vision: string; roadmap: string; preferences: string; notes: string }

const TITLES: Record<number, string> = {
  1: "Which coding agents do you use?",
  2: "Install hooks",
  3: "Set Up Your Profile",
  4: "Onboard an Agent",
};
const DESCRIPTIONS: Record<number, string> = {
  1: "Pick the agents you use. Kontexta installs hooks for them so your conversations and shell commands reach the journal — agents you leave off are ignored everywhere.",
  2: "Result of installing hooks for each agent you selected.",
  3: "Help AI agents understand you better by filling in your profile.",
  4: "Select an AI coding agent to onboard with your kontexta setup.",
};
const FIELD = "w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]";
const PRIMARY = "btn btn-md btn-primary";
const SECONDARY = "btn btn-md btn-outline";

export function FirstRunWizard({ open, onClose, initialStep = 1, projects, onSaved }: FirstRunWizardProps) {
  const { state, setEnabled, hooksAction } = useAgents();
  const [step, setStep] = useState(initialStep);
  const [sections, setSections] = useState<ProfileSections>({ name: "", role: "", vision: "", roadmap: "", preferences: "", notes: "" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [results, setResults] = useState<Record<string, ToggleResult>>({});
  const [retryErrors, setRetryErrors] = useState<Record<string, string | null>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the wizard opens or its inputs change while open, so async-arriving projects aren't ignored.
  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
    setError(null);
    if (projects.length > 0 && !selectedProject) setSelectedProject(projects[0].id);
  }, [open, initialStep, projects, selectedProject]);

  useEffect(() => {
    if (state && !seeded) { setSelected(new Set(state.agents.filter((a) => a.enabled).map((a) => a.id))); setSeeded(true); }
  }, [state, seeded]);

  const agents = state?.agents ?? [];
  const onboardChoices = (() => {
    const enabled = agents.filter((a) => a.enabled && a.onboardable);
    return enabled.length > 0 ? enabled : agents.filter((a) => a.onboardable);
  })();

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
      if (!res.ok) throw new Error("Failed to save profile");
      setStep(4);
    } catch (e: any) {
      setError(e?.message || "Failed to save profile");
    } finally { setSaving(false); }
  };

  const handleOnboardAgent = async () => {
    if (!selectedAgent) { setError("Please select an agent"); return; }
    setSaving(true); setError(null);
    try {
      const projectId = projects.length > 0 ? selectedProject : null;
      const res = await fetch("/api/projects/onboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: selectedAgent, project_id: projectId }) });
      if (!res.ok) throw new Error("Failed to onboard agent");
      onSaved(); onClose();
    } catch (e: any) {
      setError(e?.message || "Failed to onboard agent");
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
            {(["name", "role", "vision", "roadmap", "preferences", "notes"] as const).map((field) => (
              <div key={field}>
                <label htmlFor={`wizard-${field}`} className="mb-1 block text-sm font-medium capitalize text-[var(--text-secondary)]">{field}</label>
                {field === "notes" ? (
                  <textarea id={`wizard-${field}`} value={sections[field]} onChange={(e) => setSections({ ...sections, [field]: e.target.value })} className={FIELD} rows={3} placeholder={`Enter your ${field}...`} />
                ) : (
                  <input id={`wizard-${field}`} type="text" value={sections[field]} onChange={(e) => setSections({ ...sections, [field]: e.target.value })} className={FIELD} placeholder={`Enter your ${field}...`} />
                )}
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-4">
              <button className={SECONDARY} onClick={onClose}>Skip</button>
              <button className={PRIMARY} onClick={() => void handleSaveProfile()} disabled={saving}>{saving ? "Saving..." : "Continue"}</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            {projects.length > 1 && (
              <div>
                <label htmlFor="wizard-project" className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">Target project</label>
                <select id="wizard-project" value={selectedProject ?? ""} onChange={(e) => setSelectedProject(Number(e.target.value))} className={FIELD}>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name || `Project ${p.id}`}</option>)}
                  <option value="">Knowledge Base (no project)</option>
                </select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {onboardChoices.map((a) => (
                <button
                  key={a.id}
                  aria-pressed={selectedAgent === a.id}
                  onClick={() => setSelectedAgent(a.id)}
                  className={`rounded-lg border p-3 text-left text-sm transition-colors ${selectedAgent === a.id ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] hover:bg-[var(--bg-tertiary)]"}`}
                >
                  <div className="font-medium">{a.name}</div>
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button className={SECONDARY} onClick={() => setStep(3)}>Back</button>
              <button className={PRIMARY} onClick={() => void handleOnboardAgent()} disabled={saving || !selectedAgent}>{saving ? "Onboarding..." : "Onboard Agent"}</button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
