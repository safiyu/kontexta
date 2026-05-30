"use client";

interface FileListFilterProps {
  value: string;
  onChange: (next: string) => void;
}

export function FileListFilter({ value, onChange }: FileListFilterProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Filter files..."
      className="w-full px-2.5 py-1 text-[12px] bg-[var(--bg-primary)] border-b border-[var(--border)] focus:outline-none focus:border-[var(--accent)]"
    />
  );
}
