"use client";

import { useState, useEffect } from "react";

interface GitWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (finalUrl: string) => Promise<void>;
  currentUrl: string | null;
}

type AuthMethod = "ssh" | "https_pat" | "https_basic";

export function GitWizardModal({ isOpen, onClose, onSave, currentUrl }: GitWizardModalProps) {
  const [method, setMethod] = useState<AuthMethod>("ssh");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  // Initialize form based on currentUrl
  useEffect(() => {
    if (isOpen) {
      if (currentUrl) {
        if (currentUrl.startsWith("git@")) {
          setMethod("ssh");
          setUrl(currentUrl);
        } else if (currentUrl.includes("@")) {
          // HTTPS with embedded credentials
          setMethod("https_pat");
          try {
            const parsed = new URL(currentUrl);
            setUsername(parsed.username || "");
            setToken(parsed.password || "");
            parsed.username = "";
            parsed.password = "";
            setUrl(parsed.toString());
          } catch {
            setUrl(currentUrl);
          }
        } else {
          setMethod("https_basic");
          setUrl(currentUrl);
        }
      } else {
        setUrl("");
        setUsername("");
        setToken("");
      }
    }
  }, [isOpen, currentUrl]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    let finalUrl = url.trim();

    try {
      if (method === "https_pat" && finalUrl.startsWith("https://")) {
        const urlObj = new URL(finalUrl);
        if (username) urlObj.username = username;
        if (token) urlObj.password = token;
        finalUrl = urlObj.toString();
      }
      await onSave(finalUrl);
      onClose();
    } catch (error) {
      console.error("Failed to construct URL", error);
    } finally {
      setSaving(false);
    }
  };

  const isFormValid = () => {
    if (!url) return false;
    if (method === "https_pat") return !!token;
    return true;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-2xl w-[480px] max-w-[90vw] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 tracking-wide">
              Configure Context Vault
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Choose how Kontexta connects to your remote Git repository.
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn btn-icon-md" aria-label="Close dialog">✕</button>
        </div>

        <div className="p-6 flex flex-col gap-6">
          {/* Method Selection */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
              Authentication Method
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setMethod("ssh")}
                className={`btn btn-md ${method === "ssh" ? "border-[var(--accent)]" : ""}`}
              >
                SSH
              </button>
              <button
                onClick={() => setMethod("https_pat")}
                className={`btn btn-md ${method === "https_pat" ? "border-[var(--accent)]" : ""}`}
              >
                HTTPS + PAT
              </button>
              <button
                onClick={() => setMethod("https_basic")}
                className={`btn btn-md ${method === "https_basic" ? "border-[var(--accent)]" : ""}`}
              >
                HTTPS (CLI)
              </button>
            </div>
            
            {/* Helper Text */}
            <div className="mt-1 text-[11px] text-slate-500">
              {method === "ssh" && "Recommended. Uses your local machine's SSH keys. No passwords needed."}
              {method === "https_pat" && "Injects a GitHub Personal Access Token directly into the URL."}
              {method === "https_basic" && "Relies on GitHub CLI (gh auth login) or OS credential managers."}
            </div>
          </div>

          {/* Form Fields */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
                Repository URL
              </label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={
                  method === "ssh"
                    ? "git@github.com:username/repo.git"
                    : "https://github.com/username/repo.git"
                }
                className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:border-amber-accent transition-colors"
              />
            </div>

            {method === "https_pat" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    GitHub Username (Optional)
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. safiyu"
                    className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:border-amber-accent transition-colors"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    Personal Access Token (PAT)
                  </label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-3 py-2 text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:border-amber-accent transition-colors"
                  />
                </div>
              </>
            )}
          </div>
          {/* Single Vault Notice */}
          <div className="bg-amber-accent/10 border border-amber-accent/20 rounded-md p-3 flex gap-3 mt-2">
            <div className="text-amber-accent shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            </div>
            <div className="flex flex-col gap-1">
              <h4 className="text-[11px] font-bold text-amber-accent uppercase tracking-wider">Single Vault Architecture</h4>
              <p className="text-[10px] text-slate-600 dark:text-slate-400 leading-relaxed">
                You can use the <b>same repository URL</b> across all your projects. Kontexta automatically organizes your files into project-specific folders (e.g., <code className="bg-black/10 dark:bg-black/30 px-1 py-0.5 rounded text-[9px]">/backups/your-project-name</code>). 
                <br/><br/>
                <b>Note:</b> Kontexta exclusively synchronizes with the <code className="bg-black/10 dark:bg-black/30 px-1 py-0.5 rounded text-[9px] font-bold">main</code> branch.
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="btn btn-md"
          >
            CANCEL
          </button>
          <button
            onClick={handleSave}
            disabled={!isFormValid() || saving}
            className="btn btn-md"
          >
            {saving ? "SAVING..." : "SAVE CONFIGURATION"}
          </button>
        </div>
      </div>
    </div>
  );
}
