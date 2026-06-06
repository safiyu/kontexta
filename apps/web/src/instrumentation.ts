export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { attachWebSocketServer } = await import("./lib/websocket");
    // Share DATA_DIR with db-init so watcher and SQLite agree on the path.
    const { DATA_DIR } = await import("./lib/db-init");

    attachWebSocketServer([DATA_DIR]);

    console.log(`[Kontexta] WebSocket server attached to HTTP server watching ${DATA_DIR}`);

    // Phase 2 Task 29: JournalScheduler
    const { JournalScheduler } = await import("./lib/journal-scheduler");
    const scheduler = new JournalScheduler({ baseDir: DATA_DIR });
    scheduler.start();
    process.on("SIGTERM", () => scheduler.stop());
    process.on("SIGINT", () => scheduler.stop());
  }
}
