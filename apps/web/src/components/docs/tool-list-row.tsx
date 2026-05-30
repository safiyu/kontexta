"use client";

import type { ToolDef } from "./tool-form";

interface Props {
  name: string;
  def: ToolDef;
  onEdit: () => void;
  onDelete: () => void;
  errorBadge?: string | null;
}

const DANGER_STRIPE: Record<string, string> = {
  moderate: "bg-amber-500",
  high: "bg-red-500",
};

export function ToolListRow({ name, def, onEdit, onDelete, errorBadge }: Props) {
  const cmd = def.command.join(" ");
  const paramCount = Object.keys(def.params ?? {}).length;
  const meta = [
    def.danger ?? "safe",
    `${paramCount} param${paramCount === 1 ? "" : "s"}`,
    `timeout ${(def.timeout ?? 60000) / 1000}s`,
    def.confirm ? "confirm" : null,
    def.disabled ? "disabled" : null,
  ].filter(Boolean).join(" · ");

  const stripeClass = def.danger ? DANGER_STRIPE[def.danger] : null;

  return (
    <div
      className={`relative border border-[var(--border)] rounded p-3 mb-2 bg-[var(--bg-secondary)] ${
        def.disabled ? "opacity-50" : ""
      }`}
    >
      {stripeClass && (
        <span
          data-testid="danger-stripe"
          aria-hidden
          className={`absolute left-0 top-0 bottom-0 w-1 rounded-l ${stripeClass}`}
        />
      )}
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-mono font-semibold flex items-center gap-2">
            <span>{name}</span>
            {def.confirm && (
              <span title="Requires human approval" aria-label="Requires confirm">🔒</span>
            )}
            {def.disabled && (
              <span title="Validated but not registered" aria-label="Disabled">⊘</span>
            )}
          </div>
          <div className="text-xs text-[var(--text-secondary)] truncate font-mono">{cmd}</div>
          <div className="text-xs text-[var(--text-secondary)]">{meta}</div>
          {errorBadge && (
            <div className="text-xs text-red-500 mt-0.5">⚠ {errorBadge}</div>
          )}
        </div>
        <button onClick={onEdit} className="px-2 py-1 text-xs border border-[var(--border)] rounded transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black">Edit</button>
        <button onClick={onDelete} className="px-2 py-1 text-xs border border-[var(--border)] rounded transition hover:bg-[var(--accent)] hover:text-black focus:bg-[var(--accent)] focus:text-black">Delete</button>
      </div>
    </div>
  );
}
