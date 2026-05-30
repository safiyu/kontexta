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
      <div className="w-14 shrink-0 bg-[#0A0F1A] border-r border-amber-accent/10 flex flex-col items-center py-4 gap-4 z-50">
        <div className="flex flex-col items-center gap-3 w-full">
          {items.map((it) => (
            <RailButton key={it.id} item={it} onPeek={() => setPeekId(it.id)} />
          ))}
        </div>
        <div className="flex-1" />
        {footer && (
          <div className="pt-4 border-t border-amber-accent/10 w-full flex flex-col items-center">
            <RailButton item={footer} onPeek={() => setPeekId(footer.id)} />
          </div>
        )}
      </div>

      {peekItem?.peek && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm transition-all" onClick={() => setPeekId(null)} />
          <div className="absolute z-50 left-16 top-16 w-64 max-h-[80vh] overflow-auto bg-[var(--bg-secondary)]/90 backdrop-blur-xl border border-amber-accent/20 rounded-xl shadow-2xl p-4 animate-fade-in">
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-accent/70 mb-4">{peekItem.label}</div>
            <div className="scrollbar-thin">
              {peekItem.peek}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function RailButton({ item, onPeek }: { item: IconRailItem; onPeek: () => void }) {
  const initial = item.label.charAt(0).toUpperCase();
  const isKB = item.id === "kb";

  return (
    <button
      title={item.label}
      onClick={() => {
        item.onClick();
        if (item.peek) onPeek();
      }}
      className={`
        w-10 h-10 flex items-center justify-center relative rounded-xl transition-all duration-300 group hover-lift
        ${item.active 
          ? "bg-amber-accent text-white shadow-[0_0_20px_rgba(180,120,30,0.4)]" 
          : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white active:scale-95"
        }
      `}
      aria-label={item.label}
    >
      {item.active && (
        <span className="absolute -left-3 top-1/2 -translate-y-1/2 w-1.5 h-6 bg-amber-accent rounded-r-full shadow-[4px_0_15px_rgba(180,120,30,0.6)]" />
      )}
      
      {isKB ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      ) : (
        <span className="font-black text-sm tracking-tighter">{initial}</span>
      )}
    </button>
  );
}
