import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute, normalize, sep } from "node:path";
import { compilePattern, isLiteralArgv0 } from "./sanitizer.js";
import type { HandToolDef, LoadResult } from "./types.js";

const TOOL_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PARAM_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const FORBIDDEN_ENV = new Set([
  "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
]);
const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
const TIMEOUT_MAX = 300000;
const TIMEOUT_DEFAULT = 60000;
const OUTPUT_MAX = 1_000_000;
const OUTPUT_DEFAULT = 100_000;

export function loadProjectConfig(projectRoot: string): LoadResult {
  const file = join(projectRoot, "kontexta.json");
  if (!existsSync(file)) {
    return { found: false, tools: {}, disabled: [], warnings: [], errors: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e: any) {
    return { found: true, tools: {}, disabled: [], warnings: [], errors: [`read failed: ${e.message}`] };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    return { found: true, tools: {}, disabled: [], warnings: [], errors: [`JSON parse: ${e.message}`] };
  }
  return validateConfig(parsed, projectRoot);
}

export function validateConfig(parsed: any, projectRoot: string): LoadResult {
  const out: LoadResult = { found: true, tools: {}, disabled: [], warnings: [], errors: [] };
  if (!parsed || parsed.version !== "1") {
    out.errors.push(`version must be "1"`);
    return out;
  }
  if (!parsed.tools || typeof parsed.tools !== "object") {
    out.errors.push(`tools must be an object`);
    return out;
  }
  for (const [name, def] of Object.entries(parsed.tools)) {
    const result = validateTool(name, def as any, projectRoot);
    if (result.warnings) out.warnings.push(...result.warnings);
    if (result.kind === "ok") out.tools[name] = result.tool;
    else if (result.kind === "disabled") out.disabled.push(name);
  }
  return out;
}

type ToolValidation =
  | { kind: "ok"; tool: HandToolDef; warnings: string[] }
  | { kind: "disabled"; warnings: string[] }
  | { kind: "rejected"; warnings: string[] };

function validateTool(name: string, def: any, projectRoot: string): ToolValidation {
  const warnings: string[] = [];
  const reject = (reason: string): ToolValidation => {
    warnings.push(`tool '${name}' rejected: ${reason}`);
    return { kind: "rejected", warnings };
  };
  if (!TOOL_NAME_RE.test(name)) return reject(`tool name '${name}' invalid`);
  if (!def || typeof def !== "object") return reject("def must be object");
  if (typeof def.description !== "string" || !def.description) return reject("description required");
  if (!Array.isArray(def.command) || def.command.length === 0) return reject("command must be non-empty array");
  for (const e of def.command) {
    if (typeof e !== "string") return reject("command elements must be strings");
  }
  if (!isLiteralArgv0(def.command[0])) return reject("argv[0] must be literal (no {{param}})");
  // Reject relative argv[0] — would resolve against project cwd and run shipped binaries.
  const argv0 = def.command[0];
  if (!isAbsolute(argv0) && (argv0.includes("/") || argv0.includes(sep))) {
    return reject("argv[0] must be absolute or a bare command name (no relative paths)");
  }

  const paramDefs: Record<string, any> = def.params ?? {};
  for (const pn of Object.keys(paramDefs)) {
    if (!PARAM_NAME_RE.test(pn)) return reject(`param name '${pn}' invalid`);
    const p = paramDefs[pn];
    if (!p || !["string", "number", "boolean"].includes(p.type)) return reject(`param '${pn}' bad type`);
    if (p.pattern !== undefined) {
      try { compilePattern(p.pattern); } catch (e: any) { return reject(`param '${pn}' ${e.message}`); }
    }
  }

  const usedParams = new Set<string>();
  for (let i = 1; i < def.command.length; i++) {
    const el = def.command[i];
    let m: RegExpExecArray | null;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(el))) {
      if (!(m[1] in paramDefs)) return reject(`placeholder {{${m[1]}}} has no param def`);
      usedParams.add(m[1]);
    }
  }
  for (const pn of Object.keys(paramDefs)) {
    if (!usedParams.has(pn)) warnings.push(`tool '${name}' param '${pn}' is defined but unused in command`);
  }

  if (def.workingDir !== undefined) {
    if (typeof def.workingDir !== "string") return reject("workingDir must be string");
    if (isAbsolute(def.workingDir)) return reject("workingDir must be relative");
    const norm = normalize(def.workingDir);
    if (norm.startsWith("..") || norm.split(sep).includes("..")) return reject("workingDir must not contain ..");
  }

  if (def.env !== undefined) {
    if (typeof def.env !== "object" || def.env === null) return reject("env must be object");
    for (const [k, v] of Object.entries(def.env)) {
      if (FORBIDDEN_ENV.has(k)) return reject(`env key '${k}' forbidden`);
      if (typeof v !== "string") return reject(`env value for '${k}' must be string`);
    }
  }

  let timeout = typeof def.timeout === "number" ? def.timeout : TIMEOUT_DEFAULT;
  if (timeout > TIMEOUT_MAX) timeout = TIMEOUT_MAX;
  if (timeout < 1) timeout = TIMEOUT_DEFAULT;

  let maxOutputBytes = typeof def.maxOutputBytes === "number" ? def.maxOutputBytes : OUTPUT_DEFAULT;
  if (maxOutputBytes > OUTPUT_MAX) maxOutputBytes = OUTPUT_MAX;
  if (maxOutputBytes < 1) maxOutputBytes = OUTPUT_DEFAULT;

  const danger = def.danger ?? "safe";
  if (!["safe", "moderate", "high"].includes(danger)) return reject(`danger '${danger}' invalid`);

  if (def.disabled === true) {
    warnings.push(`tool '${name}' is disabled`);
    return { kind: "disabled", warnings };
  }

  const tool: HandToolDef = {
    description: def.description,
    command: def.command,
    workingDir: def.workingDir,
    timeout,
    danger,
    confirm: def.confirm === true,
    disabled: false,
    argSeparator: def.argSeparator === true,
    maxOutputBytes,
    env: def.env ?? {},
    params: paramDefs,
  };
  return { kind: "ok", tool, warnings };
}
