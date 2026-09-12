"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import {
  UserCircle, Pencil, Plus, Trash2, User, Briefcase, Target, Route, Settings,
  Code2, Users, StickyNote, FileText, RefreshCw,
} from "lucide-react";

type IconRender = (className: string) => React.ReactNode;

const REQUIRED = [
  { key: "name",               title: "Name",                    hint: "How the agent should address you.",                                                icon: ((c: string) => <User className={c} aria-hidden />) as IconRender,          placeholder: "e.g. Safiyu" },
  { key: "role",               title: "Role",                    hint: "Your role, focus, and areas of expertise.",                                        icon: ((c: string) => <Briefcase className={c} aria-hidden />) as IconRender,     placeholder: "e.g. Data engineer, SLT CDC ownership" },
  { key: "vision",             title: "Vision",                  hint: "Where you want your work to go over the medium term.",                              icon: ((c: string) => <Target className={c} aria-hidden />) as IconRender,        placeholder: "e.g. reduce operational load on the SAP replication path" },
  { key: "roadmap",            title: "Roadmap",                 hint: "Active initiatives, upcoming milestones, current themes.",                          icon: ((c: string) => <Route className={c} aria-hidden />) as IconRender,         placeholder: "e.g. sprint 7 CDC observability; Q4 dedup redesign" },
  { key: "preferences",        title: "Preferences",             hint: "General working style, tools, and communication quirks.",                           icon: ((c: string) => <Settings className={c} aria-hidden />) as IconRender,      placeholder: "e.g. prefers TypeScript, terse responses, red‑green TDD" },
  { key: "sessionCodingStyle", title: "Session coding style",    hint: "Hard rules the agent must honor every session. Comment style, git etiquette, review gates.", icon: ((c: string) => <Code2 className={c} aria-hidden />) as IconRender,         placeholder: "e.g. one‑line comments only; no auto push to git; ask before schema migrations" },
  { key: "teamMembers",        title: "Team members and roles",  hint: "People you work with, so the agent names them correctly in summaries and updates.",   icon: ((c: string) => <Users className={c} aria-hidden />) as IconRender,         placeholder: "e.g. Alice — PM, sprint planning\nBob — SRE, on‑call" },
  { key: "notes",              title: "Notes",                   hint: "Anything else worth remembering that doesn't fit elsewhere.",                       icon: ((c: string) => <StickyNote className={c} aria-hidden />) as IconRender,    placeholder: "Free‑form scratch space." },
] as const;

type SectionKey = typeof REQUIRED[number]["key"];
type SectionMap = Record<SectionKey, string>;

interface CustomSection { title: string; body: string; }
interface Parsed { preamble: string; required: SectionMap; custom: CustomSection[]; }

const REQUIRED_TITLES_LOWER = new Set(REQUIRED.map((r) => r.title.toLowerCase()));

function keyForTitle(title: string): SectionKey | null {
  const hit = REQUIRED.find((r) => r.title.toLowerCase() === title.toLowerCase());
  return hit ? hit.key : null;
}

function parseProfile(content: string): Parsed {
  const required: SectionMap = { name: "", role: "", vision: "", roadmap: "", preferences: "", sessionCodingStyle: "", teamMembers: "", notes: "" };
  const custom: CustomSection[] = [];
  // Strip a leading `# Profile` H1 — the profile file uses a fixed H1 that assembleProfile re-adds.
  const withoutH1 = content.replace(/^\s*#\s+Profile\s*$/m, "");
  const lines = withoutH1.split("\n");
  let preambleBuf: string[] = [];
  let currentKind: "required" | "custom" | null = null;
  let currentKey: SectionKey | null = null;
  let currentCustomTitle = "";
  let buf: string[] = [];
  const commit = () => {
    const body = buf.join("\n").replace(/^\s+|\s+$/g, "");
    if (currentKind === "required" && currentKey) required[currentKey] = body;
    else if (currentKind === "custom") custom.push({ title: currentCustomTitle, body });
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (currentKind !== null) commit();
      else preambleBuf = buf.slice();
      const key = keyForTitle(m[1]);
      if (key) { currentKind = "required"; currentKey = key; }
      else { currentKind = "custom"; currentCustomTitle = m[1]; currentKey = null; }
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (currentKind !== null) commit();
  else preambleBuf = buf.slice();
  const preamble = preambleBuf.join("\n").replace(/^\s+|\s+$/g, "");
  return { preamble, required, custom };
}

function assemble(parsed: Parsed): string {
  const out: string[] = ["# Profile", ""];
  if (parsed.preamble) { out.push(parsed.preamble, ""); }
  for (const r of REQUIRED) {
    out.push(`## ${r.title}`, parsed.required[r.key] || "", "");
  }
  for (const c of parsed.custom) {
    const title = c.title.trim();
    if (!title) continue; // Empty title would emit a stray `## ` marker.
    if (REQUIRED_TITLES_LOWER.has(title.toLowerCase())) continue; // Collision — parse would swallow it into the required section.
    out.push(`## ${title}`, c.body || "", "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

interface ProfileEditorProps {
  onDirtyChange?: (dirty: boolean) => void;
  onChanged?: () => void;
}

export function ProfileEditor({ onDirtyChange, onChanged }: ProfileEditorProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed>({ preamble: "", required: { name: "", role: "", vision: "", roadmap: "", preferences: "", sessionCodingStyle: "", teamMembers: "", notes: "" }, custom: [] });
  const [rawContent, setRawContent] = useState<string>("");
  const [rawMode, setRawMode] = useState(false);
  const [savedContent, setSavedContent] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const currentContent = useMemo(() => (rawMode ? rawContent : assemble(parsed)), [rawMode, rawContent, parsed]);
  const dirty = currentContent.trim() !== savedContent.trim();

  const emptyCount = REQUIRED.filter((r) => !parsed.required[r.key].trim()).length;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const initialLoadRef = useRef(false);
  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/profile");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const content = data.exists ? (data.content as string) : "";
        setParsed(parseProfile(content));
        setRawContent(content);
        setSavedContent(content);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load profile");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleFieldChange = (key: SectionKey, value: string) => {
    setParsed((prev) => ({ ...prev, required: { ...prev.required, [key]: value } }));
  };

  const handleCustomChange = (i: number, patch: Partial<CustomSection>) => {
    setParsed((prev) => {
      const next = [...prev.custom];
      next[i] = { ...next[i], ...patch };
      return { ...prev, custom: next };
    });
  };

  const handleAddCustom = () => {
    // Suggest a fresh title so two blank rows don't collide when the user hasn't renamed yet.
    let title = "New section";
    let n = 2;
    while (parsed.custom.some((c) => c.title.toLowerCase() === title.toLowerCase())) title = `New section ${n++}`;
    setParsed((prev) => ({ ...prev, custom: [...prev.custom, { title, body: "" }] }));
  };

  const handleDeleteCustom = (i: number) => {
    setParsed((prev) => ({ ...prev, custom: prev.custom.filter((_, j) => j !== i) }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = { content: currentContent };
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const finalContent = (data.content as string) ?? currentContent;
      setSavedContent(finalContent);
      setParsed(parseProfile(finalContent));
      setRawContent(finalContent);
      toast.success("Profile saved");
      onChanged?.();
    } catch (e: any) {
      toast.error(`Failed to save profile: ${e?.message ?? "Network error"}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = () => {
    setParsed(parseProfile(savedContent));
    setRawContent(savedContent);
  };

  const toggleRaw = () => {
    if (rawMode) {
      // Leaving raw: re-parse the raw text so the structured view reflects manual edits.
      setParsed(parseProfile(rawContent));
    } else {
      // Entering raw: serialise the current structured state so the textarea is a faithful view.
      setRawContent(assemble(parsed));
    }
    setRawMode((v) => !v);
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col animate-fade-in">
        <div className="border-b border-[var(--border)] px-6 py-4">
          <div className="skeleton h-6 w-48 mb-2" />
          <div className="skeleton h-4 w-32" />
        </div>
        <div className="flex-1 p-6 space-y-4">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-5/6" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-[var(--text-secondary)]">
        <div className="text-center max-w-md">
          <p className="text-sm">Failed to load profile: {error}</p>
        </div>
      </div>
    );
  }

  const displayName = parsed.required.name.trim() || "Set your name";
  const displayRole = parsed.required.role.trim();
  const completeness = Math.round(((REQUIRED.length - emptyCount) / REQUIRED.length) * 100);

  return (
    <div className="h-full flex flex-col animate-fade-in bg-[var(--bg-primary)]">
      {/* Sticky action bar — always accessible while scrolling. */}
      <div className="h-11 px-5 border-b border-[var(--border)] flex items-center gap-3 sticky top-0 bg-[var(--bg-primary)] z-20">
        <div className="flex items-center gap-2 text-[var(--text-primary)]">
          <UserCircle className="w-4 h-4 text-[var(--accent)]" aria-hidden />
          <span className="text-[13px] font-semibold uppercase tracking-wider">Profile</span>
        </div>
        <span className="text-[11px] text-[var(--text-secondary)] font-mono">knowledge/profile.md</span>
        {dirty && (
          <span className="text-[10px] uppercase tracking-widest text-amber-accent font-bold">• unsaved</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={toggleRaw}
            className={`btn btn-sm inline-flex items-center gap-1 ${rawMode ? "border-[var(--accent)]" : ""}`}
            title={rawMode ? "Switch back to the structured view" : "Edit as raw markdown"}
          >
            {rawMode ? <FileText className="w-3.5 h-3.5" aria-hidden /> : <Pencil className="w-3.5 h-3.5" aria-hidden />}
            {rawMode ? "Structured" : "Raw"}
          </button>
          <button
            type="button"
            onClick={handleRevert}
            disabled={!dirty || saving}
            className="btn btn-sm inline-flex items-center gap-1"
            title="Discard unsaved edits"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden />
            Revert
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="btn btn-sm border-[var(--accent)]/40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {rawMode ? (
          <textarea
            value={rawContent}
            onChange={(e) => setRawContent(e.target.value)}
            className="w-full h-full bg-[var(--bg-primary)] text-[var(--text-primary)] p-6 font-mono text-sm outline-none resize-none"
            spellCheck={false}
          />
        ) : (
          <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
            {/* Hero: avatar + Name + Role — the profile "identity card". */}
            <header className="flex items-start gap-5">
              <div className="shrink-0 w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-soft)] to-[var(--bg-secondary)] border border-[var(--border)] flex items-center justify-center">
                <UserCircle className="w-9 h-9 text-[var(--accent)]" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className={`text-2xl font-bold tracking-tight truncate ${parsed.required.name.trim() ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)] italic"}`}>
                  {displayName}
                </h1>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  {displayRole || <span className="italic">Add your role</span>}
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${emptyCount === 0 ? "bg-[var(--accent)]" : "bg-amber-accent/70"}`}
                      style={{ width: `${completeness}%` }}
                    />
                  </div>
                  <span className={`text-[11px] font-bold uppercase tracking-wider whitespace-nowrap ${emptyCount === 0 ? "text-[var(--accent)]" : "text-amber-accent"}`}>
                    {emptyCount === 0 ? "Complete" : `${REQUIRED.length - emptyCount}/${REQUIRED.length}`}
                  </span>
                </div>
              </div>
            </header>

            {parsed.preamble && (
              <div className="text-[12px] text-[var(--text-secondary)] italic border-l-2 border-[var(--accent)]/40 pl-3 py-1">
                {parsed.preamble}
              </div>
            )}

            {/* Section cards — one per required section. */}
            <div className="space-y-4">
              {REQUIRED.map((r) => {
                const value = parsed.required[r.key];
                const isEmpty = !value.trim();
                return (
                  <section
                    key={r.key}
                    className={`rounded-xl border transition-colors ${isEmpty ? "border-[var(--border)] bg-[var(--bg-secondary)]/40" : "border-[var(--border)] bg-[var(--bg-secondary)]/70 hover:border-[var(--accent)]/30"}`}
                  >
                    <header className="flex items-start gap-3 px-4 pt-4">
                      <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${isEmpty ? "bg-[var(--bg-primary)] text-[var(--text-secondary)]" : "bg-[var(--accent-soft)] text-[var(--accent)]"}`}>
                        {r.icon("w-4 h-4")}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <h3 className="text-[13px] font-bold uppercase tracking-widest text-[var(--text-primary)]">{r.title}</h3>
                          {isEmpty && (
                            <span className="text-[10px] uppercase tracking-widest text-amber-accent/80 font-semibold">Empty</span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{r.hint}</p>
                      </div>
                    </header>
                    <div className="p-4 pt-3">
                      <textarea
                        value={value}
                        onChange={(e) => handleFieldChange(r.key, e.target.value)}
                        placeholder={r.placeholder}
                        rows={Math.max(3, value.split("\n").length + 1)}
                        className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]/50 font-mono resize-y placeholder:text-[var(--text-secondary)]/60"
                      />
                    </div>
                  </section>
                );
              })}
            </div>

            {/* Custom sections — same card shape as required so it feels one continuous surface. */}
            <section className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-secondary)]/30 p-4">
              <header className="flex items-center gap-3 mb-3">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-[var(--bg-primary)] text-[var(--text-secondary)] flex items-center justify-center">
                  <Plus className="w-4 h-4" aria-hidden />
                </div>
                <div className="flex-1">
                  <h3 className="text-[13px] font-bold uppercase tracking-widest text-[var(--text-primary)]">
                    Custom sections
                    <span className="ml-2 text-[11px] font-normal tracking-normal text-[var(--text-secondary)] normal-case">({parsed.custom.length})</span>
                  </h3>
                  <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
                    Add your own headings for anything the required set doesn't cover.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAddCustom}
                  className="btn btn-sm inline-flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden />
                  Add section
                </button>
              </header>

              {parsed.custom.length > 0 && (
                <div className="space-y-3">
                  {parsed.custom.map((c, i) => {
                    const collides = REQUIRED.some((r) => r.title.toLowerCase() === c.title.trim().toLowerCase());
                    const titleEmpty = !c.title.trim();
                    const warn = collides || titleEmpty;
                    return (
                      <div key={i} className={`rounded-lg border p-3 bg-[var(--bg-primary)] ${warn ? "border-amber-accent/40" : "border-[var(--border)]"}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <input
                            type="text"
                            value={c.title}
                            onChange={(e) => handleCustomChange(i, { title: e.target.value })}
                            placeholder="Section title"
                            className={`flex-1 bg-transparent border-0 border-b-2 px-1 py-1 text-[13px] font-bold uppercase tracking-widest text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors ${warn ? "border-amber-accent/60" : "border-[var(--border)]"}`}
                          />
                          <button
                            type="button"
                            onClick={() => handleDeleteCustom(i)}
                            className="btn btn-icon-sm text-[var(--text-secondary)] hover:text-[var(--danger)]"
                            aria-label={`Delete section ${c.title}`}
                            title="Delete this section"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden />
                          </button>
                        </div>
                        {warn && (
                          <p className="text-[10px] text-amber-accent mb-2">
                            {titleEmpty ? "Give this section a title, or it will be lost on save." : `Title collides with the required "${c.title.trim()}" section — pick a different name.`}
                          </p>
                        )}
                        <textarea
                          value={c.body}
                          onChange={(e) => handleCustomChange(i, { body: e.target.value })}
                          placeholder="Section content"
                          rows={Math.max(2, c.body.split("\n").length + 1)}
                          className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]/50 font-mono resize-y placeholder:text-[var(--text-secondary)]/60"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
