"use client";

import { useState, useEffect } from "react";
import { X, AlertCircle } from "lucide-react";

interface FirstRunWizardProps {
  open: boolean;
  onClose: () => void;
  initialStep?: number;
  projects: any[];
  onSaved: () => void;
}

const AGENTS = [
  { id: "claude-code", name: "Claude Code" },
  { id: "cursor", name: "Cursor" },
  { id: "aider", name: "Aider" },
  { id: "continue", name: "Continue" },
  { id: "gemini", name: "Gemini" },
  { id: "copilot", name: "GitHub Copilot" },
  { id: "codex", name: "Codex" },
  { id: "generic", name: "Generic" },
];

interface ProfileSections {
  name: string;
  role: string;
  vision: string;
  roadmap: string;
  preferences: string;
  notes: string;
}

export function FirstRunWizard({ open, onClose, initialStep = 1, projects, onSaved }: FirstRunWizardProps) {
  const [step, setStep] = useState(initialStep);
  const [sections, setSections] = useState<ProfileSections>({
    name: "",
    role: "",
    vision: "",
    roadmap: "",
    preferences: "",
    notes: "",
  });
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when wizard opens
  useEffect(() => {
    if (open) {
      setStep(initialStep);
      setError(null);
      // Default to first project if multiple exist
      if (projects.length > 0 && !selectedProject) {
        setSelectedProject(projects[0].id);
      }
    }
  }, [open]);

  if (!open) return null;

  const handleSaveProfile = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections }),
      });
      if (!res.ok) throw new Error("Failed to save profile");
      setStep(2);
    } catch (error: any) {
      setError(error?.message || "Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  const handleOnboardAgent = async () => {
    if (!selectedAgent) {
      setError("Please select an agent");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const projectId = projects.length > 0 ? selectedProject : null;
      const res = await fetch("/api/projects/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: selectedAgent, project_id: projectId }),
      });
      if (!res.ok) throw new Error("Failed to onboard agent");
      onSaved();
      onClose();
    } catch (error: any) {
      setError(error?.message || "Failed to onboard agent");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-2xl rounded-xl border bg-white p-6 shadow-xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <X className="h-5 w-5" />
        </button>

        <h2 className="mb-4 text-xl font-semibold">
          {step === 1 ? "Set Up Your Profile" : "Onboard an Agent"}
        </h2>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {step === 1 ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Help AI agents understand you better by filling in your profile.
            </p>
            {(["name", "role", "vision", "roadmap", "preferences", "notes"] as const).map((field) => (
              <div key={field}>
                <label className="mb-1 block text-sm font-medium capitalize text-gray-700">
                  {field}
                </label>
                {field === "notes" ? (
                  <textarea
                    value={sections[field]}
                    onChange={(e) => setSections({ ...sections, [field]: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                    rows={3}
                    placeholder={`Enter your ${field}...`}
                  />
                ) : (
                  <input
                    type="text"
                    value={sections[field]}
                    onChange={(e) => setSections({ ...sections, [field]: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                    placeholder={`Enter your ${field}...`}
                  />
                )}
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-4">
              <button
                onClick={onClose}
                className="rounded-md border px-4 py-2 text-sm hover:bg-gray-50"
              >
                Skip
              </button>
              <button
                onClick={handleSaveProfile}
                disabled={saving}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Continue"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Select an AI coding agent to onboard with your kontexta setup.
            </p>
            {projects.length > 1 && (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Target project
                </label>
                <select
                  value={selectedProject ?? ""}
                  onChange={(e) => setSelectedProject(Number(e.target.value))}
                  className="w-full rounded-md border px-3 py-2 text-sm"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || `Project ${p.id}`}
                    </option>
                  ))}
                  <option value="">Knowledge Base (no project)</option>
                </select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {AGENTS.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgent(agent.id)}
                  className={`rounded-lg border p-3 text-left text-sm transition-colors ${
                    selectedAgent === agent.id
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <div className="font-medium">{agent.name}</div>
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button
                onClick={() => setStep(1)}
                className="rounded-md border px-4 py-2 text-sm hover:bg-gray-50"
              >
                Back
              </button>
              <button
                onClick={handleOnboardAgent}
                disabled={saving || !selectedAgent}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "Onboarding..." : "Onboard Agent"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
