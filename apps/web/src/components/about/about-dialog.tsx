"use client";

import { useEffect, useState } from "react";
import { MarkdownViewer } from "../content/markdown-viewer";
import { AnimatedLogo } from "../layout/animated-logo";

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

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 pt-[10vh]"
      onClick={handleOverlayClick}
    >
      <div className="w-[480px] max-h-[80vh] mx-auto bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-2xl flex flex-col">
        {/* Header */}
        <div className="p-6 text-center border-b border-[var(--border-color)]">
          <div className="flex justify-center -mb-3">
            <AnimatedLogo size="lg" />
          </div>
          <h1 className="text-3xl font-bold text-[#D4903A] tracking-[4px] font-[family-name:var(--font-title)]">
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
        <div className="flex-1 overflow-y-auto prose-sm">
          {loading && (
            <div className="p-6 space-y-3">
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-4 w-5/6" />
              <div className="skeleton h-4 w-4/6" />
            </div>
          )}
          {!loading && data?.changelog && (
            <MarkdownViewer content={data.changelog} className="p-6 prose-sm text-[#5C3D24] marker:text-[#5C3D24] [&_*]:!text-[#5C3D24] dark:text-[#F5C97A] dark:marker:text-[#F5C97A] dark:[&_*]:!text-[#F5C97A]" />
          )}
          {!loading && !data?.changelog && (
            <div className="p-6 text-center text-[var(--text-secondary)]">
              No changelog available
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-[var(--border-color)] text-center">
          <button
            onClick={onClose}
            className="btn btn-md"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
