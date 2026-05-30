"use client";
import { useState } from "react";

export function InstallSnippetView({ body }: { body: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await navigator.clipboard.writeText(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative">
      <pre className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded p-3 text-xs overflow-x-auto whitespace-pre">{body}</pre>
      <button onClick={onCopy} className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
