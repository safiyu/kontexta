"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
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

  return (
    <Dialog open={open} onClose={onClose} title="Kontexta configuration" widthClass="max-w-6xl" hideHeader>
      <div className="-m-5 flex flex-col h-[85vh] overflow-hidden text-[#5C3D24] dark:text-[#F5C97A]">
        <div className="flex items-center border-b border-[var(--border)] pl-4 pr-12 bg-[var(--bg-secondary)] flex-shrink-0">
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
        </div>
        <div key={tab} className="flex-1 overflow-auto p-6 bg-[var(--bg-primary)] animate-fade-in">
          {tab === "tools" && <ToolsSection />}
          {tab === "install" && <InstallSection />}
          {tab === "builder" && <BuilderSection />}
          {tab === "journal" && <JournalPanel />}
        </div>
      </div>
    </Dialog>
  );
}
