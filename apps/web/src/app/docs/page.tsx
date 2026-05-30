"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useCallback } from "react";
import { ToolsSection } from "./tools/tools-section";
import { InstallSection } from "./install/install-section";
import { BuilderSection } from "./builder/builder-section";

type Tab = "tools" | "install" | "builder";
const TABS: { id: Tab; label: string }[] = [
  { id: "tools", label: "MCP TOOLS DOC" },
  { id: "install", label: "MCP SERVER CONFIG" },
  { id: "builder", label: "HAND TOOLS CONFIG" },
];

export default function DocsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-[var(--text-secondary)]">Loading…</div>}>
      <DocsPageInner />
    </Suspense>
  );
}

function DocsPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("tab");
  const tab: Tab = raw === "install" || raw === "builder" ? raw : "tools";
  const setTab = useCallback(
    (t: Tab) => {
      const sp = new URLSearchParams(params.toString());
      sp.set("tab", t);
      router.replace(`/docs?${sp.toString()}`);
    },
    [params, router],
  );

  return (
    <div className="flex flex-col h-full text-[#5C3D24] dark:text-[#F5C97A]">
      <div className="flex items-center border-b border-[var(--border)] px-4">
        <div role="tablist" className="flex gap-1 flex-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 transition font-mono font-bold uppercase tracking-wider ${
                tab === t.id
                  ? "bg-[var(--accent)] text-black"
                  : "text-[#5C3D24] dark:text-[#F5C97A] hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => router.push("/")}
          className="ml-2 px-3 py-1 text-sm rounded transition text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black active:bg-[var(--accent)] active:text-black"
          aria-label="Close Configure"
          title="Back to app"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {tab === "tools" && <ToolsSection />}
        {tab === "install" && <InstallSection />}
        {tab === "builder" && <BuilderSection />}
      </div>
    </div>
  );
}
