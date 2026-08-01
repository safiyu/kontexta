// Deterministic color mapping for freeform event types. Class strings are
// literal (not composed) so Tailwind's JIT scanner picks them up.
const PALETTE = [
  { chip: "bg-amber-accent/15 text-amber-accent-dark dark:text-amber-accent-light border-amber-accent/30", dot: "bg-amber-accent" },
  { chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30", dot: "bg-sky-400" },
  { chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30", dot: "bg-emerald-400" },
  { chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30", dot: "bg-violet-400" },
  { chip: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30", dot: "bg-rose-400" },
  { chip: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30", dot: "bg-cyan-400" },
] as const;

export function colorForType(type: string) {
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
