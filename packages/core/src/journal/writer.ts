import { mkdirSync, openSync, closeSync, writeSync, fsyncSync } from "node:fs";
import { join, dirname } from "node:path";
import type { RawEvent } from "./types.js";

export interface JournalWriterOptions {
  projectSlug: string;
  baseDir: string;        // e.g. <data>/knowledge/journal
}

export class JournalWriter {
  private fd: number | null = null;
  private currentDay: string | null = null;
  private closed = false;
  private readonly rawDir: string;

  constructor(opts: JournalWriterOptions) {
    this.rawDir = join(opts.baseDir, opts.projectSlug, "raw");
  }

  append(event: RawEvent): void {
    if (this.closed) {
      // Silently drop after close — throwing EBADF mid-shutdown is worse
      // than losing a trailing journal line that's mostly a status ping.
      // Callers should re-create the writer if they want to reopen.
      return;
    }
    const day = event.ts.slice(0, 10); // YYYY-MM-DD
    if (day !== this.currentDay) this.rotate(day);
    const line = JSON.stringify(event) + "\n";
    writeSync(this.fd!, line);
    fsyncSync(this.fd!);
  }

  close(): void {
    this.closed = true;
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
      this.currentDay = null;
    }
  }

  private rotate(day: string): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    const path = join(this.rawDir, `${day}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a"); // append mode
    this.currentDay = day;
  }
}
