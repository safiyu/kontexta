"use client";

import { useState, type ReactNode } from "react";

interface IconRailItem {
  id: string;
  label: string;
  active: boolean;
  onClick: () => void;
  /** Optional content to render in a peek popover (e.g. a project's folder tree). */
  peek?: ReactNode;
}

interface IconRailProps {
  items: IconRailItem[];
  /** Item rendered at the bottom of the rail (e.g. Knowledge Base). */
  footer?: IconRailItem;
}

export function IconRail({ items, footer }: IconRailProps) {
  const [peekId, setPeekId] = useState<string | null>(null);
  const peekItem = [...items, ...(footer ? [footer] : [])].find((i) => i.id === peekId) ?? null;

  return (
    <>
      <div className="w-12 shrink-0 bg-[var(--bg-primary)] border-r border-[var(--border)] flex flex-col items-center py-2.5 gap-1.5">
        {items.map((it) => (
          <RailButton key={it.id} item={it} onPeek={() => setPeekId(it.id)} />
        ))}
        <div className="flex-1" />
        {footer && <RailButton item={footer} onPeek={() => setPeekId(footer.id)} />}
      </div>

      {peekItem?.peek && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPeekId(null)} />
          <div className="absolute z-50 left-12 top-[84px] w-60 max-h-[60vh] overflow-auto bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md shadow-xl p-2">
            <div className="text-[11px] uppercase tracking-wider text-[var(--text-secondary)] px-2 pb-1.5">{peekItem.label}</div>
            {peekItem.peek}
          </div>
        </>
      )}
    </>
  );
}

function RailButton({ item, onPeek }: { item: IconRailItem; onPeek: () => void }) {
  return (
    <button
      title={item.label}
      onClick={() => {
        item.onClick();
        if (item.peek) onPeek();
      }}
      className={`btn btn-icon-md relative ${
        item.active
          ? "!bg-[var(--accent)] !text-black"
          : ""
      }`}
      aria-label={item.label}
    >
      {item.active && (
        <span className="absolute -left-2 top-1 bottom-1 w-0.5 bg-[var(--accent)] rounded-full" />
      )}
      ●
    </button>
  );
}
