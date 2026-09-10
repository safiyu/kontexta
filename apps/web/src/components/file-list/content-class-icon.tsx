import type { ContentClass } from "kxta-core";

interface Props {
  contentClass: ContentClass | null;
  className?: string;
  title?: string;
}

const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

// Per-class file icon. Distinct glyphs communicate authority at a glance:
// dictionary = book, note = paper, journal = calendar,
// project = folder-with-arrow, null (legacy) = plain document.
export function ContentClassIcon({ contentClass, className, title }: Props) {
  const cn = className ?? "w-4 h-4";
  const label = title ?? (contentClass ?? "file");

  switch (contentClass) {
    case "dictionary":
      return (
        <svg viewBox="0 0 24 24" {...strokeProps} className={cn} aria-label={label}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      );
    case "note":
      return (
        <svg viewBox="0 0 24 24" {...strokeProps} className={cn} aria-label={label}>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z" />
          <polyline points="14 3 14 9 20 9" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
      );
    case "journal":
      return (
        <svg viewBox="0 0 24 24" {...strokeProps} className={cn} aria-label={label}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case "project":
      return (
        <svg viewBox="0 0 24 24" {...strokeProps} className={cn} aria-label={label}>
          <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" {...strokeProps} className={cn} aria-label={label}>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      );
  }
}
