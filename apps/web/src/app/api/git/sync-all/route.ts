import { checkAuth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { syncGlobalVault } from "kxta-core";
import { broadcastSync } from "@/lib/websocket";

let _syncAllInFlight = false;

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return new NextResponse("Unauthorized", { status: 401 });

  ensureDbInitialized();
  if (_syncAllInFlight) {
    return NextResponse.json(
      { error: "sync-all already in progress" },
      { status: 409 }
    );
  }
  _syncAllInFlight = true;
  const start = Date.now();
  broadcastSync({ type: "sync:start", projectId: null, at: start });
  try {
    // Vault sync is project-independent: it pushes every KB commit made
    // since the last sync (file creates/edits/deletes) in one shot. There
    // is no per-project copy step anymore — reference files are no longer
    // mirrored into dataDir/backups/<slug>.
    const PER_PROJECT_TIMEOUT_MS = Number(process.env.KONTEXTA_SYNC_TIMEOUT_MS ?? 60_000);

    const vaultSync = syncGlobalVault(DATA_DIR, (stage) => {
      broadcastSync({ type: "sync:stage", projectId: null, at: Date.now(), stage: `Knowledge Base: ${stage}` });
    });
    let vaultTimedOut = false;
    let vaultTimer: NodeJS.Timeout | undefined;
    const vaultTimeout = new Promise<never>((_, reject) => {
      vaultTimer = setTimeout(
        () => {
          vaultTimedOut = true;
          reject(new Error(`KB sync timed out after ${PER_PROJECT_TIMEOUT_MS}ms`));
        },
        PER_PROJECT_TIMEOUT_MS
      );
    });
    try {
      await Promise.race([vaultSync, vaultTimeout]);
    } finally {
      if (vaultTimer) clearTimeout(vaultTimer);
      if (vaultTimedOut) {
        console.warn(
          "[SyncAll] Global vault sync timed out; underlying syncGlobalVault is still running and holds the git lock."
        );
      }
    }

    broadcastSync({
      type: "sync:done",
      projectId: null,
      at: Date.now(),
      durationMs: Date.now() - start,
    });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("[SyncAll] Global vault sync failed:", error.message);
    broadcastSync({
      type: "sync:error",
      projectId: null,
      at: Date.now(),
      message: error.message || "Sync All failed",
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    _syncAllInFlight = false;
  }
}
