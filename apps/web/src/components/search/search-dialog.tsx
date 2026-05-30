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
      className="fixed inset-0 z-50 bg-black/50 pt-[20vh]"
      onClick={handleOverlayClick}
    >
      <div className="w-[560px] mx-auto bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-2xl">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search context files..."
          className="w-full px-5 py-4 text-base bg-transparent border-b border-[var(--border-color)] outline-none text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]"
        />

        <div className="max-h-[300px] overflow-y-auto">
          {loading && (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex flex-col gap-2 px-1">
                  <div className="skeleton h-4 w-3/4" />
                  <div className="skeleton h-3 w-1/4" />
                </div>
              ))}
            </div>
          )}

          {!loading && query && results.length === 0 && (
            <div className="flex flex-col items-center py-8 text-[var(--text-secondary)] gap-2">
              <span className="text-3xl opacity-30">🔍</span>
              <p className="text-sm font-medium">No results found</p>
              <p className="text-xs opacity-70">Try a different search term</p>
            </div>
          )}

          {!loading && results.length > 0 && (
            <div>
              {results.map((result, idx) => (
                <button
                  key={result.id}
                  onClick={() => handleSelectResult(result)}
                  className={`w-full px-4 py-3 text-left border-b border-[var(--border-color)] last:border-b-0 transition-colors group ${
                    idx === selectedIdx
                      ? "bg-[var(--accent)] text-black"
                      : "hover:bg-[var(--accent)] hover:text-black"
                  }`}
                >
                  <div className="text-sm font-semibold text-[var(--text-primary)]">
                    {result.title}
                  </div>
                  <div className="text-xs font-medium text-[var(--text-secondary)] mt-1">
                    {result.storage_type}
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
