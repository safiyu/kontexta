"use client";

import { useState, ReactNode } from "react";

interface TreeNodeProps {
  label: string;
  icon?: ReactNode;
  active?: boolean;
  initialExpanded?: boolean;
  children?: ReactNode;
  onClick?: () => void;
  hasHands?: boolean;
}

export function TreeNode({
  label,
  icon,
  active = false,
  initialExpanded = false,
  children,
  onClick,
  hasHands = false,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(initialExpanded);

  const hasChildren = !!children;

  const handleClick = () => {
    if (hasChildren) {
      setExpanded(!expanded);
    }
    onClick?.();
  };

  return (
    <div>
      <div
        onClick={handleClick}
        className={`relative flex items-center gap-1.5 py-1.5 px-2 rounded text-sm cursor-pointer transition-colors ${
          active
            ? "bg-[var(--accent)] text-black"
            : "text-[var(--text-secondary)] hover:bg-[var(--accent)] hover:text-black"
        }`}
      >
        {active && <span className="absolute -left-1 top-1 bottom-1 w-0.5 bg-[var(--accent)] rounded-full" />}
        {hasChildren && (
          <span className={`text-[10px] inline-block transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}>▶</span>
        )}
        {icon && <span className="dark-icon">{icon}</span>}
        <span className="truncate lowercase first-letter:uppercase flex-1">{label}</span>
        {hasHands && (
          <span className="ml-1 flex items-center justify-center text-[10px] text-[var(--accent)] opacity-70" title="Hands enabled">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
              <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
              <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
              <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
              <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
            </svg>
          </span>
        )}
      </div>

      {hasChildren && expanded && <div className="ml-3 mt-0.5">{children}</div>}
    </div>
  );
}
