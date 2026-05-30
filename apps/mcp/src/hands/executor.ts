import { spawn } from "node:child_process";
import { resolve as resolvePath, sep } from "node:path";
import { realpathSync } from "node:fs";
import { validateParamValue } from "./sanitizer.js";
import type { ExecResult, HandToolDef, ParamDef } from "./types.js";

const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
const SAFE_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "TZ"];

export function resolveArgv(
  command: string[],
  params: Record<string, unknown>,
  defs: Record<string, ParamDef>,
  argSeparator: boolean
): string[] {
  const resolvedValues: Record<string, string> = {};
  for (const [name, def] of Object.entries(defs)) {
    let v: unknown = params[name];
    if (v === undefined) {
      if (def.required) throw new Error(`required param '${name}' missing`);
      v = def.default ?? (def.type === "string" ? "" : def.type === "number" ? 0 : false);
    }
    validateParamValue(v, def);
    resolvedValues[name] = String(v);
  }

  const out: string[] = [command[0]];
  let inserted = !argSeparator;
  for (let i = 1; i < command.length; i++) {
    const original = command[i];
    let substituted = false;
    const replaced = original.replace(PLACEHOLDER_RE, (_m, name) => {
      substituted = true;
      return resolvedValues[name] ?? "";
    });
    if (substituted && replaced === "") continue;
    if (substituted && !inserted) {
      out.push("--");
      inserted = true;
    }
    out.push(replaced);
  }
  return out;
}

interface ExecArgs {
  toolDef: HandToolDef;
  params: Record<string, unknown>;
  projectRoot: string;
}

export async function executeHand(args: ExecArgs): Promise<ExecResult> {
  const { toolDef, params, projectRoot } = args;
  const argv = resolveArgv(toolDef.command, params, toolDef.params ?? {}, toolDef.argSeparator === true);
  const cwd = resolveCwd(projectRoot, toolDef.workingDir);
  const env = buildEnv(toolDef.env ?? {});
  return runProcess(argv, cwd, env, toolDef.timeout ?? 60000, toolDef.maxOutputBytes ?? 100000);
}

export function resolveCwd(projectRoot: string, workingDir?: string): string {
  let rootReal: string;
  try { rootReal = realpathSync(projectRoot); } catch { throw new Error("project root unavailable"); }
  if (!workingDir) return rootReal;
  const target = resolvePath(rootReal, workingDir);
  let real: string;
  try { real = realpathSync(target); } catch { throw new Error(`workingDir does not exist: ${workingDir}`); }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`workingDir resolved outside project root`);
  }
  return real;
}

export function buildEnv(toolEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(toolEnv)) env[k] = v;
  return env;
}

async function runProcess(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  maxBytes: number
): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutBuf = new RingBuffer(maxBytes);
    const stderrBuf = new RingBuffer(maxBytes);
    child.stdout.on("data", (c) => stdoutBuf.push(c));
    child.stderr.on("data", (c) => stderrBuf.push(c));
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 3000);
    }, timeoutMs);

    const finish = (code: number | null, _signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status: ExecResult["status"] = timedOut
        ? "timeout"
        : code === 0 ? "success" : "failed";
      resolve({
        status,
        exitCode: code,
        durationMs: Date.now() - start,
        workingDir: cwd,
        stdout: stdoutBuf.read(),
        stderr: stderrBuf.read(),
        resolvedArgv: argv,
        truncated: { stdout: stdoutBuf.dropped, stderr: stderrBuf.dropped },
      });
    };

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: "rejected",
        exitCode: null,
        durationMs: Date.now() - start,
        workingDir: cwd,
        stdout: "",
        stderr: String(e?.message ?? e),
        resolvedArgv: argv,
        rejectionReason: String(e?.message ?? e),
      });
    });
    child.on("exit", finish);
    child.on("close", finish);
  });
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals) {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, sig);
    else process.kill(-pid, sig);
  } catch { /* already gone */ }
}

class RingBuffer {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private headCap: number;
  private tailCap: number;
  public dropped = 0;

  constructor(cap: number) {
    this.headCap = Math.floor(cap / 2);
    this.tailCap = cap - this.headCap;
  }

  push(c: Buffer): void {
    let remaining = c;
    // Fill head until headCap reached. Once full, head is frozen.
    if (this.headBytes < this.headCap) {
      const need = this.headCap - this.headBytes;
      if (remaining.length <= need) {
        this.head.push(remaining);
        this.headBytes += remaining.length;
        return;
      }
      const fit = remaining.subarray(0, need);
      this.head.push(fit);
      this.headBytes += fit.length;
      remaining = remaining.subarray(need);
    }
    // Append to tail, evicting from tail's front if it overflows.
    this.tail.push(remaining);
    this.tailBytes += remaining.length;
    while (this.tailBytes > this.tailCap && this.tail.length > 0) {
      const front = this.tail[0];
      if (this.tailBytes - front.length >= this.tailCap || this.tail.length === 1 && front.length > this.tailCap) {
        // Drop or trim front entirely
        if (this.tail.length === 1 && front.length > this.tailCap) {
          // Single huge chunk: keep only the last tailCap bytes
          const keep = front.subarray(front.length - this.tailCap);
          this.dropped += front.length - keep.length;
          this.tail = [keep];
          this.tailBytes = keep.length;
          break;
        } else {
          this.tail.shift();
          this.tailBytes -= front.length;
          this.dropped += front.length;
        }
      } else {
        // Trim partial: front is larger than overflow
        const overflow = this.tailBytes - this.tailCap;
        const trimmed = front.subarray(overflow);
        this.tail[0] = trimmed;
        this.tailBytes -= overflow;
        this.dropped += overflow;
        break;
      }
    }
  }

  read(): string {
    if (this.dropped === 0) {
      return Buffer.concat([...this.head, ...this.tail]).toString("utf8");
    }
    const headStr = Buffer.concat(this.head).toString("utf8");
    const tailStr = Buffer.concat(this.tail).toString("utf8");
    return `${headStr}\n... [truncated ${this.dropped} bytes] ...\n${tailStr}`;
  }
}
