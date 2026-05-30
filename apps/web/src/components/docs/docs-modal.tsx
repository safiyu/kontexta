"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { ToolsSection } from "@/app/docs/tools/tools-section";
import { InstallSection } from "@/app/docs/install/install-section";
import { BuilderSection } from "@/app/docs/builder/builder-section";
import { JournalPanel } from "@/app/docs/journal/journal-panel";

type Tab = "tools" | "install" | "builder" | "journal";
const TABS: { id: Tab; label: string }[] = [
  { id: "install", label: "MCP SERVER CONFIG" },
  { id: "journal", label: "JOURNAL CONFIG" },
  { id: "builder", label: "HANDS TOOLS" },
  { id: "tools", label: "MCP DOCUMENTATION" },
];

interface DocsModalProps {
  open: boolean;
  onClose: () => void;
}

export function DocsModal({ open, onClose }: DocsModalProps) {
  const [tab, setTab] = useState<Tab>("install");

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-label="Kontexta Configuration"
      className="fixed inset-0 z-50 bg-black/50 flex flex-col items-center justify-center p-4 sm:p-8"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden text-[#5C3D24] dark:text-[#F5C97A] animate-fade-in">
        <div className="flex items-center border-b border-[var(--border)] px-4 bg-[var(--bg-secondary)] flex-shrink-0">
          <div role="tablist" className="flex gap-1 flex-1 overflow-x-auto hide-scrollbar">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-3 transition font-mono font-bold uppercase tracking-wider whitespace-nowrap border-b-2 ${
                  tab === t.id
                    ? "bg-[var(--accent)] text-black border-transparent"
                    : "border-transparent text-[#5C3D24] dark:text-[#F5C97A] hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="ml-2 px-3 py-1 text-sm rounded transition text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black active:bg-[var(--accent)] active:text-black flex-shrink-0"
            aria-label="Close Configure"
            title="Close"
          >
            ✕
          </button>
        </div>
        <div key={tab} className="flex-1 overflow-auto p-6 bg-[var(--bg-primary)] animate-fade-in">
          {tab === "tools" && <ToolsSection />}
          {tab === "install" && <InstallSection />}
          {tab === "builder" && <BuilderSection />}
          {tab === "journal" && <JournalPanel />}
        </div>
      </div>
    </div>,
    document.body
  );
}
