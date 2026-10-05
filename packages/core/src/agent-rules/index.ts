import { lstatSync, readdirSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join, sep, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPathInside } from "../util/safety.js";

function loadCorePackageVersion(): string {
  try {
    let currentDir = dirname(fileURLToPath(import.meta.url));
    while (currentDir !== dirname(currentDir)) {
      const p = join(currentDir, "package.json");
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf8"));
        if (pkg.name === "kxta-core") {
          return pkg.rulesVersion || pkg.version || "0.0.0";
        }
      }
      currentDir = dirname(currentDir);
    }
  } catch {}
  return "0.0.0";
}

export const RULE_BLOCK_VERSION = loadCorePackageVersion();

export const SESSION_START_HOOK_SNIPPET = JSON.stringify({
  hooks: {
    SessionStart: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command:
              "echo 'kontexta: journal_distill recommended at session start' && true",
          },
        ],
      },
    ],
  },
}, null, 2);

export const STOP_HOOK_SNIPPET = JSON.stringify({
  hooks: {
    Stop: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command:
              "echo 'kontexta: end-of-session journal_distill recommended' && true",
          },
        ],
      },
    ],
  },
}, null, 2);

export const POST_TOOL_USE_HOOK_SNIPPET = JSON.stringify({
  hooks: {
    PostToolUse: [
      {
        matcher: "Bash(git*)|mcp__kontexta__admin[._]commit_backup|mcp__kontexta__files[._]move",
        hooks: [
          {
            type: "command",
            command:
              "echo 'kontexta: git context refresh hint' && true",
          },
        ],
      },
    ],
  },
}, null, 2);

export type AgentId = "claude-code" | "codex" | "gemini" | "antigravity" | "cursor" | "continue" | "aider" | "cline" | "copilot" | "generic";

interface ProjectMeta {
  name: string;
  description?: string | null;
}

interface ScaffoldDef {
  path: string;
  header: (project: ProjectMeta) => string;
}

const claudeStyleHeader = (p: ProjectMeta) =>
  p.description ? `# ${p.name}\n\n${p.description}\n\n` : `# ${p.name}\n\n`;

export const SCAFFOLDS: Record<AgentId, ScaffoldDef> = {
  "claude-code": { path: "CLAUDE.md", header: claudeStyleHeader },
  codex:         { path: "AGENTS.md", header: claudeStyleHeader },
  gemini:        { path: "GEMINI.md", header: claudeStyleHeader },
  antigravity:   { path: "ANTIGRAVITY.md", header: claudeStyleHeader },
  cursor:        {
    path: ".cursor/rules/kontexta.mdc",
    header: (p) => `---\ndescription: kontexta workflow rules for ${p.name}\nalwaysApply: true\n---\n\n`,
  },
  continue:      {
    path: ".continue/rules/kontexta.md",
    header: (p) => `# kontexta rules — ${p.name}\n\n`,
  },
  aider:         {
    path: ".aider/kontexta.md",
    header: (p) => `<!--\n  kontexta rules for Aider — ${p.name}\n  To enable, add this to your .aider.conf.yml:\n  read:\n    - .aider/kontexta.md\n-->\n\n`,
  },
  cline:         { path: ".clinerules", header: claudeStyleHeader },
  copilot:       { path: ".github/copilot-instructions.md", header: claudeStyleHeader },
  generic:       { path: "CLAUDE.md", header: claudeStyleHeader },
};

/** Shared candidate-path builder for rules-block.md and rules-reference.md. */
function rulesCandidates(filename: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, filename),
    join(here, "agent-rules", filename),
    join(here, "..", "..", "src", "agent-rules", filename),
    join(process.cwd(), "packages", "core", "src", "agent-rules", filename),
    join(process.cwd(), "packages", "core", "dist", "agent-rules", filename),
    join(process.cwd(), "..", "..", "packages", "core", "src", "agent-rules", filename),
    join(process.cwd(), "..", "..", "packages", "core", "dist", "agent-rules", filename),
  ];
}

function loadMarkdownAsset(filename: string, marker: string | null): string {
  const candidates = rulesCandidates(filename);
  const errors: string[] = [];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) {
        errors.push(`not found: ${p}`);
        continue;
      }
      const raw = readFileSync(p, "utf8");
      if (marker) {
        const beginIdx = raw.indexOf(marker);
        if (beginIdx === -1) {
          errors.push(`missing marker: ${p}`);
          continue;
        }
        return raw.slice(beginIdx).replace(/\{\{VERSION\}\}/g, RULE_BLOCK_VERSION);
      }
      return raw.replace(/\{\{VERSION\}\}/g, RULE_BLOCK_VERSION);
    } catch (e: any) {
      errors.push(`error reading ${p}: ${e.message}`);
    }
  }
  throw new Error(
    `${filename} not found or invalid. Checked:\n- ${candidates.join("\n- ")}\nDetails:\n- ${errors.join("\n- ")}`
  );
}

function loadRulesBlockBody(): string {
  return loadMarkdownAsset("rules-block.md", "<!-- BEGIN kontexta:rules");
}

function loadRulesReferenceBody(): string {
  return loadMarkdownAsset("rules-reference.md", null);
}

// Try eagerly so existing `import { RULES_BLOCK_BODY }` consumers still see
// the content, but DON'T throw if the asset is missing — previously a missing
// rules-block.md broke every `import "kxta-core"` (web, MCP, publish, etc.)
// even for callers that never touch agent-rules. The deferred error surfaces
// only when getRulesBlockBody() / getRulesReferenceBody() is actually called.
let _rulesBlockBody: string | null = null;
let _rulesBlockError: Error | null = null;
try {
  _rulesBlockBody = loadRulesBlockBody();
} catch (e: any) {
  _rulesBlockError = e instanceof Error ? e : new Error(String(e));
}
export function getRulesBlockBody(): string {
  if (_rulesBlockBody != null) return _rulesBlockBody;
  try {
    _rulesBlockBody = loadRulesBlockBody();
    _rulesBlockError = null;
    return _rulesBlockBody;
  } catch (e: any) {
    _rulesBlockError = e instanceof Error ? e : new Error(String(e));
    throw _rulesBlockError;
  }
}
export const RULES_BLOCK_BODY = _rulesBlockBody ?? "";

let _rulesReferenceBody: string | null = null;
try {
  _rulesReferenceBody = loadRulesReferenceBody();
} catch {
  // Non-fatal: reference file is only needed when syncAgentRules writes KONTEXTA.md
}
export function getRulesReferenceBody(): string {
  if (_rulesReferenceBody != null) return _rulesReferenceBody;
  try {
    _rulesReferenceBody = loadRulesReferenceBody();
    return _rulesReferenceBody;
  } catch (e: any) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}
export const RULES_REFERENCE_BODY = _rulesReferenceBody ?? "";

/** File name for the full rules reference at the project root. */
export const KONTEXTA_MD = "KONTEXTA.md";

// Note: .aider.conf.yml is intentionally NOT in this list. It's a YAML file;
// injectOrUpdate writes HTML-comment markers (<!-- BEGIN... -->) which would
// syntax-corrupt YAML. Aider's rules go in .aider/kontexta.md (see SCAFFOLDS),
// referenced from the YAML via a `read:` directive.
const ROOT_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "ANTIGRAVITY.md", ".clinerules", ".github/copilot-instructions.md"] as const;
const SUBDIR_GLOBS = [
  { dir: ".cursor/rules", ext: ".mdc" },
  { dir: ".continue/rules", ext: ".md" },
  { dir: ".aider", ext: ".md" },
] as const;

function isRegularNonSymlink(absPath: string): boolean {
  try {
    return lstatSync(absPath).isFile();
  } catch {
    return false;
  }
}

function toForwardSlashes(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export function detectAgentContextFiles(projectPath: string): string[] {
  const out: string[] = [];

  for (const name of ROOT_FILES) {
    if (isRegularNonSymlink(join(projectPath, name))) {
      out.push(name);
    }
  }

  for (const { dir, ext } of SUBDIR_GLOBS) {
    const full = join(projectPath, dir);
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    entries.sort();
    for (const entry of entries) {
      if (!entry.endsWith(ext)) continue;
      if (!isRegularNonSymlink(join(full, entry))) continue;
      out.push(toForwardSlashes(join(dir, entry)));
    }
  }

  return out;
}

export type ParseResult =
  | { kind: "ok"; version: string; beginAt: number; endAt: number }
  | { kind: "malformed" }
  | { kind: "duplicate" };

const BEGIN_RE = /<!--\s*BEGIN\s+kontexta:rules\s+v(\d+\.\d+\.\d+)\s*-->/g;
const END_RE = /<!--\s*END\s+kontexta:rules(?:\s+v\d+\.\d+\.\d+)?\s*-->/;

export function parseMarker(content: string): ParseResult | null {
  BEGIN_RE.lastIndex = 0;
  const matches = [...content.matchAll(BEGIN_RE)];
  if (matches.length === 0) return null;
  if (matches.length > 1) return { kind: "duplicate" };

  const m = matches[0];
  const version = m[1];
  const beginAt = m.index ?? 0;
  const afterBegin = beginAt + m[0].length;

  const tail = content.slice(afterBegin);
  const endMatch = tail.match(END_RE);
  if (!endMatch || endMatch.index === undefined) return { kind: "malformed" };

  const endAt = afterBegin + endMatch.index + endMatch[0].length;
  return { kind: "ok", version, beginAt, endAt };
}

export class InjectError extends Error {
  code: "malformed" | "duplicate";
  constructor(code: "malformed" | "duplicate", message: string) {
    super(message);
    this.code = code;
    this.name = "InjectError";
  }
}

export interface InjectResult {
  action: "updated" | "skipped";
  content: string;
}

export function injectOrUpdate(content: string, block: string, version: string): InjectResult {
  const parsed = parseMarker(content);

  if (parsed === null) {
    const sep = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    return { action: "updated", content: content + sep + block };
  }

  if (parsed.kind === "malformed") {
    throw new InjectError("malformed", "kontexta rules marker is malformed (BEGIN with no matching END)");
  }
  if (parsed.kind === "duplicate") {
    throw new InjectError("duplicate", "duplicate kontexta rules marker found");
  }

  if (parsed.version === version) {
    return { action: "skipped", content };
  }

  const before = content.slice(0, parsed.beginAt);
  const after = content.slice(parsed.endAt);
  return { action: "updated", content: before + block.replace(/\n$/, "") + after };
}

export interface SyncOpts {
  projectPath: string;
  project: ProjectMeta;
  files: string[];
  targetAgent?: AgentId;
}

export interface SyncResultEntry {
  path: string;
  action: "created" | "updated" | "skipped";
  version: string;
}

export interface SyncSkippedEntry {
  path: string;
  reason:
    | "missing"
    | "symlink"
    | "escape"
    | "malformed marker"
    | "duplicate marker"
    | "read-only"
    | "unreadable";
}

export interface SyncResult {
  written: SyncResultEntry[];
  skipped: SyncSkippedEntry[];
  reference?: SyncResultEntry;
  optional_hook_snippet?: string;          // backward compat (SessionStart only)
  optional_hook_install_path?: string;
  optional_hook_snippets?: {
    SessionStart: string;
    Stop: string;
    PostToolUse: string;
  };
}

let _atomicWriteSeq = 0;
function atomicWrite(absPath: string, content: string): void {
  // Refuse to write THROUGH a symlink. The intended use is to manage agent
  // context files; replacing a user's intentional symlink with a regular
  // file via the renameSync below would silently undo their setup.
  try {
    const st = lstatSync(absPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink: ${absPath}`);
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      // Re-throw the explicit symlink error; ignore stat-failures so a
      // missing parent dir still goes through the mkdir path below.
      if (e?.message?.startsWith("Refusing")) throw e;
    }
  }
  mkdirSync(dirname(absPath), { recursive: true });
  // Counter + pid + ms gives a unique tmp name even when two concurrent
  // calls land on the same millisecond inside the same process.
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}.${++_atomicWriteSeq}`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, absPath);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

function classifyAccessError(e: any): SyncSkippedEntry["reason"] {
  if (e?.code === "ENOENT") return "missing";
  if (e?.code === "EROFS") return "read-only";
  return "unreadable";
}

function resolveInside(base: string, rel: string): string | null {
  try {
    return assertPathInside(base, rel);
  } catch {
    return null;
  }
}

export function syncAgentRules(opts: SyncOpts): SyncResult {
  const { projectPath, project, files, targetAgent } = opts;
  const written: SyncResultEntry[] = [];
  const skipped: SyncSkippedEntry[] = [];

  let reference: SyncResultEntry | undefined;
  // Always write/update KONTEXTA.md with the full rules reference.
  try {
    const refBody = getRulesReferenceBody();
    const kontextaPath = resolveInside(projectPath, KONTEXTA_MD);
    if (kontextaPath) {
      // Strip the HTML comment header (authoring notes) — only the rendered content goes to the project.
      const headerEnd = refBody.indexOf("-->");
      const cleanBody = headerEnd !== -1 ? refBody.slice(headerEnd + 3).replace(/^\n+/, "") : refBody;
      let needsWrite = true;
      const alreadyExists = existsSync(kontextaPath);
      try {
        const existing = readFileSync(kontextaPath, "utf8");
        if (existing === cleanBody) needsWrite = false;
      } catch { /* file doesn't exist yet, write it */ }
      if (needsWrite) {
        atomicWrite(kontextaPath, cleanBody);
        reference = { path: KONTEXTA_MD, action: alreadyExists ? "updated" : "created", version: RULE_BLOCK_VERSION };
      } else {
        reference = { path: KONTEXTA_MD, action: "skipped", version: RULE_BLOCK_VERSION };
      }
    }
  } catch (e: any) {
    // Non-fatal: if rules-reference.md is unavailable, agent stubs still work.
  }

  if (files.length === 0) {
    if (!targetAgent) {
      throw new Error("syncAgentRules: targetAgent required when files is empty");
    }
    const scaffold = SCAFFOLDS[targetAgent];
    const relPath = scaffold.path;
    const absPath = resolveInside(projectPath, relPath);
    if (!absPath) {
      skipped.push({ path: relPath, reason: "escape" });
      return { written, skipped, ...(reference ? { reference } : {}) };
    }
    const initial = scaffold.header(project) + getRulesBlockBody();
    atomicWrite(absPath, initial);
    written.push({ path: relPath, action: "created", version: RULE_BLOCK_VERSION });
    return {
      written,
      skipped,
      ...(reference ? { reference } : {}),
      optional_hook_snippet: SESSION_START_HOOK_SNIPPET,
      optional_hook_install_path: "~/.claude/settings.json (Claude Code only)",
      optional_hook_snippets: {
        SessionStart: SESSION_START_HOOK_SNIPPET,
        Stop: STOP_HOOK_SNIPPET,
        PostToolUse: POST_TOOL_USE_HOOK_SNIPPET,
      },
    };
  }

  for (const rel of files) {
    if (isAbsolute(rel)) {
      skipped.push({ path: rel, reason: "escape" });
      continue;
    }
    const absPath = resolveInside(projectPath, rel);
    if (!absPath) {
      skipped.push({ path: rel, reason: "escape" });
      continue;
    }

    let stat;
    try {
      stat = lstatSync(absPath);
    } catch (e) {
      skipped.push({ path: rel, reason: classifyAccessError(e) });
      continue;
    }
    if (stat.isSymbolicLink()) {
      skipped.push({ path: rel, reason: "symlink" });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: rel, reason: "unreadable" });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch (e) {
      skipped.push({ path: rel, reason: classifyAccessError(e) });
      continue;
    }

    let result;
    try {
      result = injectOrUpdate(content, getRulesBlockBody(), RULE_BLOCK_VERSION);
    } catch (e) {
      if (e instanceof InjectError) {
        skipped.push({ path: rel, reason: e.code === "malformed" ? "malformed marker" : "duplicate marker" });
        continue;
      }
      throw e;
    }

    if (result.action === "skipped") {
      written.push({ path: rel, action: "skipped", version: RULE_BLOCK_VERSION });
      continue;
    }

    try {
      atomicWrite(absPath, result.content);
    } catch (e) {
      skipped.push({ path: rel, reason: classifyAccessError(e) });
      continue;
    }
    written.push({ path: rel, action: "updated", version: RULE_BLOCK_VERSION });
  }

  return {
    written,
    skipped,
    ...(reference ? { reference } : {}),
    optional_hook_snippet: SESSION_START_HOOK_SNIPPET,
    optional_hook_install_path: "~/.claude/settings.json (Claude Code only)",
    optional_hook_snippets: {
      SessionStart: SESSION_START_HOOK_SNIPPET,
      Stop: STOP_HOOK_SNIPPET,
      PostToolUse: POST_TOOL_USE_HOOK_SNIPPET,
    },
  };
}

export interface RuleStatus {
  path: string;
  version: string | null;
  upToDate: boolean;
  error?: "malformed" | "duplicate" | "unreadable";
}

export function checkAgentRulesStatus(projectPath: string, files: string[]): RuleStatus[] {
  const out: RuleStatus[] = [];

  for (const rel of files) {
    const absPath = resolveInside(projectPath, rel);
    if (!absPath) continue;

    try {
      if (!existsSync(absPath)) continue;
      const content = readFileSync(absPath, "utf8");
      const parsed = parseMarker(content);

      if (!parsed) {
        out.push({ path: rel, version: null, upToDate: false });
      } else if (parsed.kind === "ok") {
        out.push({
          path: rel,
          version: parsed.version,
          upToDate: parsed.version === RULE_BLOCK_VERSION,
        });
      } else {
        out.push({
          path: rel,
          version: null,
          upToDate: false,
          error: parsed.kind,
        });
      }
    } catch {
      out.push({ path: rel, version: null, upToDate: false, error: "unreadable" });
    }
  }

  return out;
}
