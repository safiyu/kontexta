import { randomBytes } from "node:crypto";
import type { ExecResult } from "./types.js";

interface PendingEntry {
  toolName: string;
  projectName: string;
  resolvedArgv: string[];
  workingDir: string;
  env: Record<string, string>;
  expiresAt: number;
  execute: () => Promise<ExecResult>;
}

export interface StashInput {
  toolName: string;
  projectName: string;
  resolvedArgv: string[];
  workingDir: string;
  env: Record<string, string>;
  execute: () => Promise<ExecResult>;
}

export class ConfirmStore {
  private map = new Map<string, PendingEntry>();
  private ttlMs: number;

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [token, entry] of this.map) {
      if (entry.expiresAt < now) this.map.delete(token);
    }
  }

  stash(input: StashInput): string {
    this.sweepExpired();
    const token = randomBytes(32).toString("hex");
    this.map.set(token, { ...input, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  consume(token: string): { execute: () => Promise<ExecResult>; toolName: string } | null {
    const entry = this.map.get(token);
    if (!entry) return null;
    this.map.delete(token);
    if (entry.expiresAt < Date.now()) return null;
    return { execute: entry.execute, toolName: entry.toolName };
  }

  clearProject(projectName: string): void {
    for (const [token, entry] of this.map) {
      if (entry.projectName === projectName) this.map.delete(token);
    }
  }

  clearAll(): void {
    this.map.clear();
  }
}
