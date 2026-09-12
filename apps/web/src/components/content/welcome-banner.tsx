"use client";

import { useEffect, useState } from "react";
import { CalendarDays, AlertTriangle, UserCircle, Sparkles, Clock, ArrowRight } from "lucide-react";

interface UpcomingEvent {
  id: number;
  title: string;
  starts_at: string;
  ends_at: string;
  entity_id: number;
  entity_name: string;
}

interface Conflict {
  kind: string;
  reason: string;
  event_a: { id: number; title: string; starts_at: string; entity_name: string };
  event_b: { id: number; title: string; starts_at: string; entity_name: string };
}

interface WelcomeResponse {
  today: string;
  profile: { exists: boolean; name: string | null; emptySections: string[]; daysSinceUpdate: number | null };
  upcoming: UpcomingEvent[];
  conflicts: Conflict[];
}

function fmtLongDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function fmtEventTime(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return { day, time };
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function WelcomeBanner() {
  const [data, setData] = useState<WelcomeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/welcome");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as WelcomeResponse;
        if (!cancelled) setData(body);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load welcome");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center animate-fade-in">
        <div className="w-full max-w-2xl px-8 space-y-4">
          <div className="skeleton h-8 w-2/3" />
          <div className="skeleton h-4 w-1/2" />
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--text-secondary)] p-6">
        <div className="text-center max-w-md">
          <p className="text-sm">Couldn&apos;t load your briefing{error ? ` — ${error}` : ""}.</p>
        </div>
      </div>
    );
  }

  const hasConflicts = data.conflicts.length > 0;
  const hasEvents = data.upcoming.length > 0;
  const profileStale =
    data.profile.exists &&
    (data.profile.emptySections.length > 0 || (data.profile.daysSinceUpdate != null && data.profile.daysSinceUpdate >= 30));

  return (
    <div className="h-full overflow-auto animate-fade-in bg-[var(--bg-primary)]">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        {/* Hero */}
        <header className="flex items-start gap-5">
          <div className="shrink-0 w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-soft)] to-[var(--bg-secondary)] border border-[var(--border)] flex items-center justify-center">
            <Sparkles className="w-8 h-8 text-[var(--accent)]" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
              {greeting()}{data.profile.name ? <>, <span className="text-[var(--accent)]">{data.profile.name}</span></> : ""}.
            </h1>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{fmtLongDate(data.today)}</p>
          </div>
        </header>

        {/* Conflicts (only when present — front and center) */}
        {hasConflicts && (
          <section className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/5 overflow-hidden">
            <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--danger)]/30 bg-[var(--danger)]/10">
              <div className="shrink-0 w-9 h-9 rounded-lg bg-[var(--danger)]/15 text-[var(--danger)] flex items-center justify-center">
                <AlertTriangle className="w-4 h-4" aria-hidden />
              </div>
              <div className="flex-1">
                <h2 className="text-[13px] font-bold uppercase tracking-widest text-[var(--text-primary)]">
                  Calendar conflicts <span className="ml-1 text-[var(--text-secondary)] font-normal normal-case tracking-normal">({data.conflicts.length})</span>
                </h2>
                <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
                  Overlaps or buffer violations in the next 7 days.
                </p>
              </div>
            </header>
            <ul className="divide-y divide-[var(--border)]">
              {data.conflicts.map((c, i) => {
                const a = fmtEventTime(c.event_a.starts_at);
                const b = fmtEventTime(c.event_b.starts_at);
                return (
                  <li key={i} className="px-4 py-3 text-sm">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[10px] uppercase tracking-widest text-[var(--danger)] font-bold">{c.kind.replace(/_/g, " ")}</span>
                      <span className="text-[11px] text-[var(--text-secondary)]">{c.reason}</span>
                    </div>
                    <div className="mt-1 text-[var(--text-primary)]">
                      <span className="font-medium">{c.event_a.title}</span>
                      <span className="text-[var(--text-secondary)]"> · {a.day} {a.time} · {c.event_a.entity_name}</span>
                    </div>
                    <div className="text-[var(--text-primary)]">
                      <span className="font-medium">{c.event_b.title}</span>
                      <span className="text-[var(--text-secondary)]"> · {b.day} {b.time} · {c.event_b.entity_name}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Upcoming events */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/60 overflow-hidden">
          <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
            <div className="shrink-0 w-9 h-9 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
              <CalendarDays className="w-4 h-4" aria-hidden />
            </div>
            <div className="flex-1">
              <h2 className="text-[13px] font-bold uppercase tracking-widest text-[var(--text-primary)]">Upcoming (next 7 days)</h2>
              <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
                {hasEvents ? `${data.upcoming.length} event${data.upcoming.length === 1 ? "" : "s"} in view.` : "No scheduled events."}
              </p>
            </div>
          </header>
          {hasEvents ? (
            <ul className="divide-y divide-[var(--border)]">
              {data.upcoming.map((e) => {
                const s = fmtEventTime(e.starts_at);
                const en = fmtEventTime(e.ends_at);
                return (
                  <li key={e.id} className="px-4 py-3 flex items-start gap-3 hover:bg-[var(--bg-primary)]/50 transition-colors">
                    <div className="shrink-0 w-14 text-center pt-0.5">
                      <div className="text-[10px] uppercase tracking-widest text-[var(--text-secondary)] font-bold">{s.day.split(" ")[0]}</div>
                      <div className="text-lg font-semibold leading-none text-[var(--text-primary)]">{s.day.split(" ")[2]}</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-[var(--text-primary)] truncate">{e.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                        <Clock className="w-3 h-3" aria-hidden />
                        <span>{s.time}–{en.time}</span>
                        <span className="text-[var(--border)]">·</span>
                        <span>{e.entity_name}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="px-4 py-6 text-center text-[12px] text-[var(--text-secondary)]">
              Nothing on the calendar. Add events via <code className="text-[var(--text-primary)]">calendar_add_event</code>.
            </div>
          )}
        </section>

        {/* Profile freshness nudge (only when the profile needs attention) */}
        {profileStale && (
          <section className="rounded-xl border border-amber-accent/30 bg-amber-accent/5 p-4 flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-lg bg-amber-accent/10 text-amber-accent flex items-center justify-center">
              <UserCircle className="w-4 h-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-[13px] font-bold uppercase tracking-widest text-[var(--text-primary)]">Keep your profile current</h3>
              <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                {data.profile.emptySections.length > 0 && (
                  <>The agent uses your profile to honor coding style and name people correctly. <span className="text-[var(--text-primary)]">{data.profile.emptySections.length} section{data.profile.emptySections.length === 1 ? "" : "s"} still empty</span>: {data.profile.emptySections.join(", ")}.</>
                )}
                {data.profile.emptySections.length === 0 && data.profile.daysSinceUpdate != null && data.profile.daysSinceUpdate >= 30 && (
                  <>Your profile hasn&apos;t been updated in {data.profile.daysSinceUpdate} days.</>
                )}
              </p>
              <p className="mt-2 text-[11px] text-[var(--text-secondary)] inline-flex items-center gap-1">
                Open <code className="text-[var(--text-primary)]">knowledge/profile.md</code> in the sidebar to edit
                <ArrowRight className="w-3 h-3" aria-hidden />
              </p>
            </div>
          </section>
        )}

        {/* Empty-state nudge when there's no profile at all */}
        {!data.profile.exists && (
          <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/60 p-4 flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
              <UserCircle className="w-4 h-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-[13px] font-bold uppercase tracking-widest text-[var(--text-primary)]">Set up your profile</h3>
              <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
                Kontexta hands your profile to the agent on every session start — coding rules, roadmap, team roster. Create one to make sessions consistent.
              </p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
