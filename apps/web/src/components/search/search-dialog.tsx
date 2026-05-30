"use client";

import { useEffect, useState, useRef } from "react";

interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
  onSelectFile: (result: SearchResult) => void;
}

export interface SearchResult {
  id: number;
  title: string;
  storage_type: string;
  path: string;
  project_id: number | null;
}

export function SearchDialog({ open, onClose, onSelectFile }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelectedIdx(0);
      // Auto-focus input
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!open || !query.trim()) {
      setResults([]);
      setSelectedIdx(0);
      return;
    }

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    const controller = new AbortController();

    searchTimeoutRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (response.ok) {
          const data = await response.json();
          if (!controller.signal.aborted) {
            setResults(data || []);
            setSelectedIdx(0);
          }
        }
      } catch (error: any) {
        if (error?.name === "AbortError") return;
        console.error("Search failed:", error);
        setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      controller.abort();
    };
  }, [query, open]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && results.length > 0) {
      e.preventDefault();
      onSelectFile(results[selectedIdx]);
    }
  };

  const handleSelectResult = (result: SearchResult) => {
    onSelectFile(result);
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm pt-[20vh] animate-fade-in"
      onClick={handleOverlayClick}
    >
      <div className="w-[560px] mx-auto bg-[var(--bg-primary)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden animate-scale-in">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search context files..."
            className="w-full px-6 py-5 text-base bg-transparent border-b border-[var(--border)] outline-none text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:ring-1 focus:ring-amber-accent/30 transition-all"
          />
        </div>

        <div className="max-h-[400px] overflow-y-auto scrollbar-thin">
          {loading && (
            <div className="p-6 space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex flex-col gap-2 px-1">
                  <div className="skeleton h-4 w-3/4 opacity-20" />
                  <div className="skeleton h-3 w-1/4 opacity-10" />
                </div>
              ))}
            </div>
          )}

          {!loading && query && results.length === 0 && (
            <div className="flex flex-col items-center py-12 text-[var(--text-secondary)] gap-3">
              <span className="text-4xl opacity-30">🔍</span>
              <p className="text-sm font-medium">No results found</p>
              <p className="text-xs opacity-60 italic">Try a different search term</p>
            </div>
          )}

          {!loading && results.length > 0 && (
            <div className="p-1">
              {results.map((result, idx) => (
                <button
                  key={result.id}
                  onClick={() => handleSelectResult(result)}
                  className={`w-full px-5 py-4 text-left rounded-lg transition-all duration-200 group flex flex-col gap-1 ${
                    idx === selectedIdx
                      ? "bg-amber-accent/15 text-white shadow-[inset_0_0_12px_rgba(180,120,30,0.1)]"
                      : "text-[var(--text-secondary)] hover:bg-amber-accent/5 hover:text-white"
                  }`}
                >
                  <div className={`text-sm font-semibold transition-colors ${idx === selectedIdx ? "text-white" : "text-[var(--text-primary)] group-hover:text-white"}`}>
                    {result.title}
                  </div>
                  <div className={`text-xs transition-colors ${idx === selectedIdx ? "text-white/60" : "text-[var(--text-secondary)] group-hover:text-white/40"}`}>
                    {result.storage_type} · {result.path}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
