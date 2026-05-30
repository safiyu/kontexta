import { NextResponse } from "next/server";
import { DATA_DIR, ensureDbInitialized } from "@/lib/db-init";
import { syncBackup, syncGlobalVault, listProjects } from "kxta-core";
import { broadcastSync } from "@/lib/websocket";

let _syncAllInFlight = false;

export async function POST() {
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
    const projects = listProjects();
    let totalBackedUp = 0;
    const errors: string[] = [];

    // Cap each project so an unreachable remote can't hang the whole batch.
    const PER_PROJECT_TIMEOUT_MS = Number(process.env.KONTEXTA_SYNC_TIMEOUT_MS ?? 60_000);

    // A timed-out syncBackup keeps running and holds the per-dataDir git
    // lock; subsequent projects would queue behind it and time out the
    // same way. Stop the batch instead of cascading N timeouts.
    let lockStuck = false;

    for (const project of projects) {
      if (lockStuck) {
        errors.push(`Project ${project.name}: skipped (prior sync timed out and is still holding the git lock)`);
        continue;
      }
      try {
        const sync = syncBackup(project.id, DATA_DIR, (stage) => {
          broadcastSync({ type: "sync:stage", projectId: project.id, at: Date.now(), stage: `${project.name}: ${stage}` });
        });
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              timedOut = true;
              reject(new Error(`timed out after ${PER_PROJECT_TIMEOUT_MS}ms`));
            },
            PER_PROJECT_TIMEOUT_MS
          );
        });
        try {
          const backedUp = await Promise.race([sync, timeout]);
          totalBackedUp += backedUp.length;
        } finally {
          if (timer) clearTimeout(timer);
          if (timedOut) {
            lockStuck = true;
            console.warn(
              `[SyncAll] Project ${project.name} (id=${project.id}) timed out; ` +
                `underlying syncBackup still running and holding the git lock. ` +
                `Skipping remaining projects.`
            );
            broadcastSync({
              type: "sync:error",
              projectId: project.id,
              at: Date.now(),
              message: `${project.name}: timeout — remaining projects skipped`,
            });
          }
        }
      } catch (error: any) {
        console.error(`[SyncAll] Failed for project ${project.id}:`, error.message);
        errors.push(`Project ${project.name}: ${error.message}`);
      }
    }

    // Always run a global-vault sync at the end so KB-only commits go
    // upstream even when the user has zero projects. Skip if a prior
    // timeout left the git lock stuck.
    if (lockStuck) {
      errors.push("Knowledge Base: skipped (prior sync timed out and is still holding the git lock)");
    } else try {
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
    } catch (error: any) {
      console.error("[SyncAll] Global vault sync failed:", error.message);
      errors.push(`Knowledge Base: ${error.message}`);
    }

    if (errors.length > 0) {
      broadcastSync({
        type: "sync:error",
        projectId: null,
        at: Date.now(),
        message: errors.join("; "),
      });
      return NextResponse.json({
        success: false,
        backed_up: totalBackedUp,
        message: "Partial success. Some projects failed to sync.",
        errors,
      }, { status: 207 });
    }

    broadcastSync({
      type: "sync:done",
      projectId: null,
      at: Date.now(),
      durationMs: Date.now() - start,
    });
    return NextResponse.json({ success: true, backed_up: totalBackedUp });
  } catch (error: any) {
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
