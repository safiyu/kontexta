"use client";

import { Star } from "lucide-react";
import { toast } from "sonner";
import type { ContentClass } from "kxta-core";
import { ContentClassIcon } from "./content-class-icon";

interface FileItemProps {
  id: number;
  title: string;
  updatedAt: string;
  active: boolean;
  onClick: () => void;
  estTokens?: number | null;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  favorite?: boolean;
  tags?: string[];
  contentClass?: ContentClass | null;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins === 1) return "1 min ago";
  if (diffMins < 60) return `${diffMins} mins ago`;
  if (diffHours === 1) return "1 hour ago";
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return "1 day ago";
  if (diffDays < 30) return `${diffDays} days ago`;

  return date.toLocaleDateString();
}

const DownloadIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export function FileItem({ id, title, updatedAt, active, onClick, estTokens, selectMode, selected, onToggleSelect, favorite, tags, contentClass }: FileItemProps) {
  const handleRowClick = (e: React.MouseEvent) => {
    if (selectMode) {
      e.preventDefault();
      onToggleSelect?.();
      return;
    }
    onClick();
  };

  return (
    <div
      onClick={handleRowClick}
      className={`
        group relative px-4 py-3 cursor-pointer border-l-[3px] transition-all duration-200
        ${
          active && !selectMode
            ? "bg-[var(--accent-soft)] border-amber-accent"
            : selectMode && selected
            ? "bg-[var(--accent-soft)] border-amber-accent"
            : "border-transparent hover:bg-[var(--accent-soft)]/60 hover:translate-x-0.5"
        }
      `}
    >
      <div className="flex items-start gap-3">
        {selectMode ? (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect?.()}
            onClick={(e) => e.stopPropagation()}
            className="mt-1 cursor-pointer accent-amber-accent"
          />
        ) : (
          <ContentClassIcon contentClass={contentClass ?? null} className="w-4 h-4 mt-1 text-amber-accent shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-semibold truncate transition-colors flex items-center gap-1.5 ${
            active ? "text-[var(--text-primary)]" : "text-[var(--text-primary)] group-hover:text-[var(--accent)]"
          }`}>
            {favorite && (
              <span className="text-amber-accent shrink-0" title="Favorite" aria-label="Favorite">
                <Star className="w-3.5 h-3.5 fill-current" aria-hidden />
              </span>
            )}
            <span className="truncate">{title}</span>
          </div>
          <div className="text-[11px] mt-1 flex flex-wrap items-center gap-1.5 transition-colors text-[var(--text-secondary)]">
            <span>{formatTimeAgo(updatedAt)}</span>
            {typeof estTokens === "number" && estTokens > 0 && (
              <span>· ~{formatTokens(estTokens)} tok</span>
            )}
            {tags && tags.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {tags.slice(0, 3).map((t) => (
                  <span key={t} className="px-1.5 rounded bg-amber-accent/10 border border-amber-accent/20 text-[10px]">
                    {t}
                  </span>
                ))}
                {tags.length > 3 && <span className="text-[10px] opacity-60">+{tags.length - 3}</span>}
              </span>
            )}
          </div>
        </div>
        {!selectMode && (
          <button
            type="button"
            onClick={async (e) => {
              e.stopPropagation();
              try {
                const res = await fetch(`/api/files/${id}/download`);
                if (!res.ok) {
                  let msg = `HTTP ${res.status}`;
                  try {
                    const body = await res.json();
                    if (body?.error) msg = body.error;
                  } catch {}
                  toast.error(`Download failed: ${msg}`);
                  return;
                }
                const disposition = res.headers.get("content-disposition") || "";
                const match = /filename="([^"]+)"/.exec(disposition);
                const filename = match?.[1] ?? `${title}.md`;
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              } catch (err: any) {
                toast.error(`Download failed: ${err?.message ?? String(err)}`);
              }
            }}
            title="Download .md"
            aria-label="Download file"
            className="btn btn-icon-sm opacity-0 group-hover:opacity-100"
          >
            <DownloadIcon className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
