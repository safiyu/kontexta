"use client";

import { useEffect, useState } from "react";
import { MarkdownViewer } from "../content/markdown-viewer";
import { AnimatedLogo } from "../layout/animated-logo";
import { Dialog } from "../ui/dialog";

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

interface AboutData {
  name: string;
  author: string;
  version: string;
  changelog: string;
}

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const [data, setData] = useState<AboutData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && !data) {
      setLoading(true);
      fetch("/api/about")
        .then((res) => res.json())
        .then((aboutData) => {
          setData(aboutData);
        })
        .catch((error) => {
          console.error("Failed to fetch about data:", error);
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [open, data]);

  return (
    <Dialog open={open} onClose={onClose} title="About Kontexta" widthClass="max-w-xl" hideHeader>
      <div className="-m-5 flex flex-col max-h-[75vh] overflow-hidden">
        {/* Header */}
        <div className="p-6 text-center border-b border-[var(--border)] shrink-0">
          <div className="flex justify-center -mb-3">
            <AnimatedLogo size="lg" />
          </div>
          <h1 className="text-3xl font-extrabold tracking-[4px] font-[family-name:var(--font-title)] text-[var(--accent)] dark:text-[#F4F3EF] drop-shadow-[0_0_14px_rgba(180,120,30,0.55)] dark:drop-shadow-none">
            KONTEXTA
          </h1>
          <p className="text-sm font-medium text-[var(--text-secondary)] mt-2">
            by {data?.author || "Safiyu"} • v{data?.version || "0.1.0"}
          </p>
          <p className="text-sm text-[var(--text-secondary)] mt-2">
            A modern context management system for AI-assisted development
          </p>
        </div>

        {/* Changelog */}
        <div className="flex-1 min-h-0 overflow-y-auto prose-sm">
          {loading && (
            <div className="p-6 space-y-3">
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-4 w-5/6" />
              <div className="skeleton h-4 w-4/6" />
            </div>
          )}
          {!loading && data?.changelog && (
            <MarkdownViewer
              content={data.changelog}
              className="p-6 prose-sm text-[var(--accent)] marker:text-[var(--accent)] [&_*]:!text-[var(--accent)]"
            />
          )}
          {!loading && !data?.changelog && (
            <div className="p-6 text-center text-[var(--text-secondary)]">
              No changelog available
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[var(--border)] text-center shrink-0">
          <button
            onClick={onClose}
            className="btn btn-md"
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
