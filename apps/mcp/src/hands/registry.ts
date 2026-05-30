import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadProjectConfig } from "./loader.js";
import { executeHand } from "./executor.js";
import { formatExecResult, formatPendingConfirm } from "./formatter.js";
import { ConfirmStore } from "./confirm.js";
import type { HandToolDef, ParamDef } from "./types.js";

interface RegisteredTool {
  projectName: string;
  projectRoot: string;
  toolName: string;        // bare name, e.g. "run-tests"
  fullName: string;        // namespaced, e.g. "myapi__run-tests"
  def: HandToolDef;
  unregister: () => void;  // callback returned from server.tool's handle
}

export class HandsRegistry {
  private byProject = new Map<string, RegisteredTool[]>();
  private confirmStore = new ConfirmStore();
  private silentNotify = false;

  constructor(private server: McpServer) {}

  getConfirmStore(): ConfirmStore {
    return this.confirmStore;
  }

  list(): Array<{ project: string; tool: string; full: string; danger: string; confirm: boolean; description: string; disabled: false }> {
    const out: any[] = [];
    for (const items of this.byProject.values()) {
      for (const r of items) {
        out.push({
          project: r.projectName,
          tool: r.toolName,
          full: r.fullName,
          danger: r.def.danger ?? "safe",
          confirm: r.def.confirm === true,
          description: r.def.description,
          disabled: false,
        });
      }
    }
    return out;
  }

  registerProject(projectName: string, projectRoot: string): { found: boolean; registered: number; disabled: number; warnings: string[] } {
    this.unregisterProject(projectName);
    const cfg = loadProjectConfig(projectRoot);
    if (!cfg.found) return { found: false, registered: 0, disabled: 0, warnings: cfg.warnings };
    const items: RegisteredTool[] = [];
    for (const [name, def] of Object.entries(cfg.tools)) {
      const fullName = `${projectName}__${name}`;
      const inputShape = buildInputShape(def.params ?? {});
      const handle = (this.server as any).tool(
        fullName,
        def.description,
        inputShape,
        async (params: Record<string, unknown>) => {
          return this.invoke(projectName, projectRoot, fullName, def, params);
        }
      );
      items.push({
        projectName, projectRoot, toolName: name, fullName, def,
        unregister: () => {
          try { handle?.remove?.(); }
          catch (e) { console.warn(`[hands] failed to unregister ${fullName}: ${(e as Error).message}`); }
        },
      });
    }
    this.byProject.set(projectName, items);
    if (!this.silentNotify) this.notifyListChanged();
    return { found: true, registered: items.length, disabled: cfg.disabled.length, warnings: [...cfg.warnings, ...cfg.errors] };
  }

  unregisterProject(projectName: string): void {
    this.confirmStore.clearProject(projectName);
    const items = this.byProject.get(projectName);
    if (!items) return;
    for (const it of items) it.unregister();
    this.byProject.delete(projectName);
    if (!this.silentNotify) this.notifyListChanged();
  }

  reloadAll(projects: Array<{ name: string; root: string }>): { totalRegistered: number; totalDisabled: number; perProject: Array<{ project: string; registered: number; disabled: number; warnings: string[] }> } {
    this.silentNotify = true;
    try {
      for (const name of [...this.byProject.keys()]) this.unregisterProject(name);
      const perProject: any[] = [];
      let totalRegistered = 0, totalDisabled = 0;
      for (const p of projects) {
        const r = this.registerProject(p.name, p.root);
        perProject.push({ project: p.name, registered: r.registered, disabled: r.disabled, warnings: r.warnings });
        totalRegistered += r.registered;
        totalDisabled += r.disabled;
      }
      return { totalRegistered, totalDisabled, perProject };
    } finally {
      this.silentNotify = false;
      this.notifyListChanged();
    }
  }

  private async invoke(
    projectName: string,
    projectRoot: string,
    fullName: string,
    def: HandToolDef,
    params: Record<string, unknown>
  ) {
    const execOnce = async () => executeHand({ toolDef: def, params, projectRoot });
    if (def.confirm === true) {
      // Resolve argv now to show the human exactly what will run
      const { resolveArgv, resolveCwd, buildEnv } = await import("./executor.js");
      let resolvedArgv: string[];
      let cwd: string;
      try {
        resolvedArgv = resolveArgv(def.command, params, def.params ?? {}, def.argSeparator === true);
        cwd = resolveCwd(projectRoot, def.workingDir);
      } catch (e: any) {
        return { content: [{ type: "text", text: `Param validation failed: ${e?.message ?? e}` }] };
      }
      const env = buildEnv(def.env ?? {});
      const token = this.confirmStore.stash({
        toolName: fullName, projectName, resolvedArgv, workingDir: cwd, env,
        execute: execOnce,
      });
      return { content: [{ type: "text", text: formatPendingConfirm({ toolName: fullName, projectName, resolvedArgv, workingDir: cwd, token }) }] };
    }
    const result = await execOnce();
    return { content: [{ type: "text", text: formatExecResult(fullName, result) }] };
  }

  private notifyListChanged(): void {
    try {
      const r = (this.server as any).server?.notification?.({ method: "notifications/tools/list_changed" });
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch { /* SDK variance or not connected yet */ }
  }
}

function buildInputShape(params: Record<string, ParamDef>): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, p] of Object.entries(params)) {
    let s: z.ZodTypeAny;
    if (p.type === "string") s = z.string();
    else if (p.type === "number") s = z.number();
    else s = z.boolean();
    if (!p.required) s = s.optional();
    shape[name] = s;
  }
  return shape;
}
