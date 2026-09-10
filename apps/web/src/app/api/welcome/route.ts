import { NextRequest, NextResponse } from "next/server";
import { statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getDataDir, profileRelPath, getEmptySections,
  listEvents, findConflicts, getEntity,
  type CalendarEvent, type Conflict,
} from "kxta-core";
import { checkAuth } from "@/lib/auth";

export interface UpcomingEvent {
  id: number;
  title: string;
  starts_at: string;
  ends_at: string;
  entity_id: number;
  entity_name: string;
}

export interface WelcomeResponse {
  today: string;
  profile: {
    exists: boolean;
    name: string | null;
    emptySections: string[];
    daysSinceUpdate: number | null;
  };
  upcoming: UpcomingEvent[];
  conflicts: Array<{
    kind: Conflict["kind"];
    reason: string;
    event_a: { id: number; title: string; starts_at: string; entity_name: string };
    event_b: { id: number; title: string; starts_at: string; entity_name: string };
  }>;
}

// Extract the body under a required `## Name` heading; returns first non-empty line only.
function extractName(content: string): string | null {
  const m = content.match(/^##\s+Name\s*$([\s\S]*?)(?=^##\s+|\Z)/m);
  if (!m) return null;
  for (const line of m[1].split("\n")) {
    const t = line.trim();
    if (t) return t.replace(/^[-*]\s+/, "");
  }
  return null;
}

const WINDOW_DAYS = 7;
const MAX_EVENTS = 5;
const MAX_CONFLICTS = 5;

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const dataDir = getDataDir();
  const profilePath = join(dataDir, profileRelPath());
  const profileExists = existsSync(profilePath);
  let emptySections: string[] = [];
  let daysSinceUpdate: number | null = null;
  let name: string | null = null;
  if (profileExists) {
    try {
      const content = readFileSync(profilePath, "utf8");
      emptySections = getEmptySections(content);
      name = extractName(content);
    } catch {}
    try {
      const mtime = statSync(profilePath).mtime;
      daysSinceUpdate = Math.floor((Date.now() - mtime.getTime()) / (24 * 60 * 60 * 1000));
    } catch {}
  }

  let events: CalendarEvent[] = [];
  let conflicts: Conflict[] = [];
  try {
    events = listEvents({ from, to, limit: MAX_EVENTS });
    conflicts = findConflicts({ from, to }).conflicts.slice(0, MAX_CONFLICTS);
  } catch {}

  const entityName = (id: number) => getEntity(id)?.name ?? `#${id}`;

  const body: WelcomeResponse = {
    today: now.toISOString().slice(0, 10),
    profile: { exists: profileExists, name, emptySections, daysSinceUpdate },
    upcoming: events.map((e) => ({
      id: e.id,
      title: e.title,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      entity_id: e.entity_id,
      entity_name: entityName(e.entity_id),
    })),
    conflicts: conflicts.map((c) => ({
      kind: c.kind,
      reason: c.reason,
      event_a: { id: c.event_a.id, title: c.event_a.title, starts_at: c.event_a.starts_at, entity_name: entityName(c.event_a.entity_id) },
      event_b: { id: c.event_b.id, title: c.event_b.title, starts_at: c.event_b.starts_at, entity_name: entityName(c.event_b.entity_id) },
    })),
  };

  return NextResponse.json(body);
}
