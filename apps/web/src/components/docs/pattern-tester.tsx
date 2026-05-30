"use client";
import { useEffect, useState } from "react";

export function PatternTester({ pattern }: { pattern: string }) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<{ matches?: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (!pattern) { setResult(null); return; }
    const t = setTimeout(() => {
      fetch("/api/hands/test-pattern", { method: "POST", body: JSON.stringify({ pattern, value }) })
        .then((r) => r.json())
        .then((j) => setResult(j.valid ? { matches: j.matches } : { error: j.error }))
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [pattern, value]);

  return (
    <div className="flex items-center gap-2 mt-1">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="sample value"
        className="px-2 py-0.5 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded font-mono"
      />
      {result?.error && <span className="text-xs text-red-500">invalid pattern</span>}
      {result?.matches === true && <span className="text-xs text-green-500">✓ matches</span>}
      {result?.matches === false && <span className="text-xs text-[var(--text-secondary)]">no match</span>}
    </div>
  );
}
