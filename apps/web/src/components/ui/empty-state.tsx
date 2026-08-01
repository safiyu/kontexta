import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}

/** One styling convention for the three divergent empty states. */
export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center gap-2">
      {icon && <div className="text-[var(--muted)] opacity-60 mb-1">{icon}</div>}
      <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
      {hint && <p className="text-xs text-[var(--text-secondary)]">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
