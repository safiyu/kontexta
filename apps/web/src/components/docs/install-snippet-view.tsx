"use client";
import { useState } from "react";

export function InstallSnippetView({ body, configPath, notes }: { body: string; configPath?: string; notes?: string[] }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(body);
      } else {
        // Fallback for contexts where clipboard API is unavailable (e.g. HTTP)
        const textarea = document.createElement("textarea");
        textarea.value = body;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
    } catch {
      // Silently fail — user can still manually select and copy
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex flex-col gap-3">
      {configPath && (
        <div className="p-3 bg-[var(--bg-secondary)] border border-[var(--accent-opacity)] rounded text-xs">
          <div className="text-[var(--text-secondary)] mb-1 uppercase tracking-wider font-bold">Configuration Path</div>
          <div className="font-mono break-all">{configPath}</div>
        </div>
      )}
      <div className="relative">
        <pre className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded p-3 text-xs overflow-x-auto whitespace-pre">{body}</pre>
        <button onClick={onCopy} className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded hover:border-[var(--accent)] transition-colors">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {notes && notes.length > 0 && (
        <div className="text-xs text-[var(--text-secondary)] px-1">
          <ul className="list-disc list-inside space-y-1">
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
