"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Brain, GitMerge } from "lucide-react";

export interface IconRailItem {
  id: string;
  label: string;
  active: boolean;
  onClick: () => void;
  /** Optional icon to render instead of the first-letter initial. */
  icon?: ReactNode;
  /** Optional badge content (e.g. unresolved conflict count). */
  badge?: ReactNode;
  /** Optional content to render in a peek popover (e.g. a project's folder tree). */
  peek?: ReactNode;
  /** Optional navigation href for links. */
  href?: string;
}

export interface IconRailProps {
  items: IconRailItem[];
  /** Item rendered at the bottom of the rail (e.g. Knowledge Base). */
  footer?: IconRailItem;
  /**
   * Optional custom Conflict Manager navigation item.
   * If omitted or undefined, a default Conflict Manager navigation item pointing to `/conflicts` is rendered.
   * Pass null to explicitly disable the Conflict Manager item.
   */
  conflictsItem?: IconRailItem | null;
  /**
   * Optional unresolved conflict count override.
   * If omitted, polls `/api/conflicts?status=unresolved` and listens for `kontexta:conflicts-changed` events.
   */
  unresolvedConflicts?: number;
}

export function IconRail({ items, footer, conflictsItem, unresolvedConflicts }: IconRailProps) {
  const [peekId, setPeekId] = useState<string | null>(null);
  const [unresolvedCount, setUnresolvedCount] = useState<number>(() => unresolvedConflicts ?? 0);

  let router: ReturnType<typeof useRouter> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter();
  } catch {
    // Fallback when router context is unavailable
  }

  let pathname = "";
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    pathname = (typeof usePathname === "function" ? usePathname() : null) ?? "";
  } catch {
    if (typeof window !== "undefined") {
      pathname = window.location.pathname || "";
    }
  }

  useEffect(() => {
    if (unresolvedConflicts !== undefined) {
      setUnresolvedCount(unresolvedConflicts);
      return;
    }

    let cancelled = false;
    const fetchUnresolved = async () => {
      try {
        const res = await fetch("/api/conflicts?status=unresolved&limit=1", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && typeof data?.unresolved === "number") {
            setUnresolvedCount(data.unresolved);
          }
        }
      } catch {
        // Ignore network / abort errors
      }
    };

    void fetchUnresolved();
    const interval = setInterval(fetchUnresolved, 15_000);
    const handleChanged = () => {
      void fetchUnresolved();
    };
    window.addEventListener("kontexta:conflicts-changed", handleChanged);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("kontexta:conflicts-changed", handleChanged);
    };
  }, [unresolvedConflicts]);

  const hasConflictsInItems = items.some((it) => it.id === "conflicts");

  const defaultConflictsItem: IconRailItem = {
    id: "conflicts",
    label: "Conflict Manager",
    active: pathname === "/conflicts",
    onClick: () => {
      try {
        if (router) {
          router.push("/conflicts");
        } else if (typeof window !== "undefined") {
          window.location.href = "/conflicts";
        }
      } catch {}
    },
    icon: <GitMerge className="w-5 h-5" strokeWidth={2.2} />,
    badge: unresolvedCount > 0 ? unresolvedCount : undefined,
    href: "/conflicts",
  };

  const resolvedConflictsItem: IconRailItem | null = hasConflictsInItems
    ? null
    : conflictsItem === undefined
      ? defaultConflictsItem
      : conflictsItem;

  const brainItem: IconRailItem | null = items.some((it) => it.id === "brain")
    ? null
    : {
        id: "brain",
        label: "Brain",
        active: pathname === "/brain",
        onClick: () => {
          try {
            if (router) {
              router.push("/brain");
            } else if (typeof window !== "undefined") {
              window.location.href = "/brain";
            }
          } catch {}
        },
        icon: <Brain className="w-5 h-5" strokeWidth={2.2} />,
        href: "/brain",
      };

  const allItems = [
    ...items,
    ...(resolvedConflictsItem ? [resolvedConflictsItem] : []),
    ...(brainItem ? [brainItem] : []),
    ...(footer ? [footer] : []),
  ];
  const peekItem = allItems.find((i) => i.id === peekId) ?? null;

  return (
    <>
      <div className="w-14 shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col items-center py-4 gap-4 z-50">
        <div className="flex flex-col items-center gap-3 w-full">
          {items.map((it) => (
            <RailButton key={it.id} item={it} onPeek={() => setPeekId(it.id)} />
          ))}
        </div>
        <div className="flex-1" />
        {(resolvedConflictsItem || brainItem || footer) && (
          <div className="pt-4 border-t border-[var(--border)] w-full flex flex-col items-center gap-3">
            {resolvedConflictsItem && (
              <RailButton
                item={resolvedConflictsItem}
                onPeek={() => setPeekId(resolvedConflictsItem.id)}
                badge={resolvedConflictsItem.badge ?? (unresolvedCount > 0 ? unresolvedCount : undefined)}
              />
            )}
            {brainItem && <RailButton item={brainItem} onPeek={() => setPeekId(brainItem.id)} />}
            {footer && (
              <RailButton item={footer} onPeek={() => setPeekId(footer.id)} />
            )}
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

function RailButton({ item, onPeek, badge }: { item: IconRailItem; onPeek: () => void; badge?: ReactNode }) {
  const initial = item.label.charAt(0).toUpperCase();
  const isKB = item.id === "kb";
  const isConflicts = item.id === "conflicts" || item.id === "conflict-manager";
  const displayBadge = item.badge ?? badge;
  const buttonTitle = displayBadge
    ? `${item.label} (${displayBadge} unresolved)`
    : item.label;

  return (
    <button
      title={buttonTitle}
      onClick={() => {
        item.onClick();
        if (item.peek) onPeek();
      }}
      className={`
        w-10 h-10 flex items-center justify-center relative rounded-xl transition-all duration-300 group hover-lift
        ${item.active
          ? "bg-amber-accent text-white shadow-[0_0_20px_rgba(180,120,30,0.4)]"
          : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)] active:scale-95"
        }
      `}
      aria-label={item.label}
      data-testid={`rail-button-${item.id}`}
    >
      {item.active && (
        <span className="absolute -left-3 top-1/2 -translate-y-1/2 w-1.5 h-6 bg-amber-accent rounded-r-full shadow-[4px_0_15px_rgba(180,120,30,0.6)] bp-keep-round" />
      )}
      
      {item.icon ? (
        item.icon
      ) : isKB ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-5 h-5">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      ) : isConflicts ? (
        <GitMerge className="w-5 h-5" strokeWidth={2.2} />
      ) : (
        <span className="font-black text-sm tracking-tighter">{initial}</span>
      )}

      {Boolean(displayBadge) && (
        <span
          data-testid={`rail-badge-${item.id}`}
          className="absolute -top-1 -right-1 flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-amber-accent text-[10px] font-extrabold text-black leading-none shadow-md"
        >
          {displayBadge}
        </span>
      )}
    </button>
  );
}
