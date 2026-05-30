// packages/core/src/journal/types.ts

export type EventKind =
  | "tool_call"
  | "user_intent"
  | "agent_note"
  | "error"
  | "git_context"
  | "git_commit";

export interface RawEvent {
  ts: string;            // ISO 8601 UTC
  agent: string;         // 'claude-code' | 'cursor' | 'antigravity' | 'codex' | 'unknown'
  sid: string;           // session correlator
  event: EventKind;
  // tool_call / error
  tool?: string;
  args?: Record<string, unknown>;
  touched?: string[];
  status?: "ok" | "error";
  ms?: number;
  msg?: string;
  // user_intent / agent_note
  summary?: string;
  tags?: string[];
  // git_context
  branch?: string;
  head?: string;
  // git_commit
  sha?: string;
  files_changed?: string[];
  project?: string;
}

export interface JournalFrontmatter {
  task: string;
  project: string;
  tags: string[];
  touched_files: string[];
  git: {
    branches: string[];
    commits: Array<{ sha: string; msg: string; ts: string }>;
    ticket_ids: string[];
  };
  status_latest: string | null;
  started_at: string;
  last_active_at: string;
  distilled_from: string[]; // e.g. "raw/2026-05-12.jsonl@offset:0-89"
}

export interface TaskBucket {
  task_slug: string;
  events: RawEvent[];
  is_new: boolean;            // true if no existing task file matched
  matched_via: "ticket" | "branch" | "files" | "minted";
}

export interface DistillResult {
  events_processed: number;
  tasks_touched: string[];
  tasks_created: string[];
  high_water_advanced_to: string;
  warnings: string[];
}

export interface BacklogStatus {
  backlog_events: number;
  backlog_oldest_age_hours: number | null;
  high_water: string | null;
  mode: "lenient" | "strict" | "mechanical-only";
}
