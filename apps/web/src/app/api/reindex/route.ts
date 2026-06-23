import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { refreshIndex, listProjects } from "kxta-core";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";

interface ScopeReport {
  scope: string;
  newly_indexed: number;
  refreshed: number;
  pruned: number;
  note?: string;
  error?: string;
}

// Single in-flight slot — reindex touches every project + the KB; running two
// in parallel would just contend on the same per-scope withLock and waste
// time. A second concurrent request gets 409 so the UI can show a clear
// "already running" state instead of queuing silently.
let _reindexInFlight = false;

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();

  if (_reindexInFlight) {
    return NextResponse.json(
      { error: "Reindex already in progress" },
      { status: 409 },
    );
  }
  _reindexInFlight = true;

  const startedAt = Date.now();
  const reports: ScopeReport[] = [];

  try {
    const projects = listProjects();

    // KB first (project_id = null), then every project. Per-scope failures
    // are captured into the report rather than aborting the whole run so a
    // single inaccessible project doesn't block reindexing the rest.
    const scopes: Array<{ id: number | null; label: string }> = [
      { id: null, label: "Knowledge Base" },
      ...projects.map((p) => ({ id: p.id, label: p.name })),
    ];

    for (const scope of scopes) {
      try {
        const r = await refreshIndex(scope.id, DATA_DIR);
        reports.push({
          scope: scope.label,
          newly_indexed: r.newly_indexed,
          refreshed: r.refreshed,
          pruned: r.pruned,
          ...(r.note ? { note: r.note } : {}),
        });
      } catch (e: any) {
        reports.push({
          scope: scope.label,
          newly_indexed: 0,
          refreshed: 0,
          pruned: 0,
          error: e?.message ?? String(e),
        });
      }
    }

    const totals = reports.reduce(
      (acc, r) => ({
        newly_indexed: acc.newly_indexed + r.newly_indexed,
        refreshed: acc.refreshed + r.refreshed,
        pruned: acc.pruned + r.pruned,
        errors: acc.errors + (r.error ? 1 : 0),
      }),
      { newly_indexed: 0, refreshed: 0, pruned: 0, errors: 0 },
    );

    return NextResponse.json({
      success: true,
      duration_ms: Date.now() - startedAt,
      totals,
      scopes: reports,
    });
  } catch (error: any) {
    console.error("[api/reindex] failed:", error);
    return NextResponse.json(
      { error: error?.message ?? "Reindex failed" },
      { status: 500 },
    );
  } finally {
    _reindexInFlight = false;
  }
}
