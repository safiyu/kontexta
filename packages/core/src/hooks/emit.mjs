// kontexta-hooks v0.0.0-dev
// Dependency-free journal emitter invoked by coding-agent hooks. Prints nothing, always exits 0.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { homedir, platform } from "node:os";
import { pathToFileURL } from "node:url";

const MAX_STDIN_BYTES = 1_000_000;
const DEFAULT_CAPS = { prompt_max_bytes: 8192, reply_max_bytes: 4096, command_max_bytes: 2048 };
const BLOCKED_KEY_RE = /(password|token|secret|auth|cookie|bearer|api[_-]?key)/i;
const REDACTED = "<redacted>";
// Bounded quantifiers around the key words keep the key=value pattern linear on long unbroken tokens.
const VALUE_PATTERNS = [
  [/ghp_[A-Za-z0-9]{20,}/g, REDACTED],
  [/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/glpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/AIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/sk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/sk_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/xapp-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/AKIA[0-9A-Z]{16}/g, REDACTED],
  [/(?:npm|hf)_[A-Za-z0-9]{30,}/g, REDACTED],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${REDACTED}`],
  [/(:\/\/)[^\s:@/]+:[^\s@/]+@/g, `$1${REDACTED}@`],
  [/(^|\s)(-u|--user)\s+[^\s:]+:\S+/g, `$1$2 ${REDACTED}`],
  [/([A-Za-z0-9_.-]{0,40}(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]{0,40})\s*[=:]\s*("[^"]*"|'[^']*'|[^\s"']+)/gi, `$1=${REDACTED}`],
  [/\b(password|passwd|pwd)\s+is\s+\S+/gi, `$1 is ${REDACTED}`],
];

// ---------- small helpers ----------
const str = (v) => typeof v === "string" && v.length > 0;

export function redactText(s) {
  let out = s;
  for (const [re, replacement] of VALUE_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function redactDeep(v) {
  if (typeof v === "string") return redactText(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = BLOCKED_KEY_RE.test(k) ? REDACTED : redactDeep(val);
    return o;
  }
  return v;
}

export function capUtf8(s, max) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return { text: s, truncated: false, bytes: buf.length };
  let cut = max;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString("utf8"), truncated: true, bytes: buf.length };
}

export function defaultDataDir() {
  const home = homedir();
  switch (platform()) {
    case "darwin": return join(home, "Library", "Application Support", "kontexta");
    case "win32": return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "kontexta");
    default: return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "kontexta");
  }
}

export function resolveDataDir(argv, env) {
  if (str(env.KONTEXTA_DATA_DIR)) return resolve(env.KONTEXTA_DATA_DIR);
  const i = argv.indexOf("--data-dir");
  if (i >= 0 && str(argv[i + 1])) return resolve(argv[i + 1]);
  try {
    const cached = readFileSync(join(homedir(), ".kontexta_datadir"), "utf8").trim();
    if (cached && isAbsolute(cached)) return cached;
  } catch {}
  return defaultDataDir();
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && str(argv[i + 1]) ? argv[i + 1] : undefined;
}

function readCaps(dataDir) {
  try {
    const cfg = JSON.parse(readFileSync(join(dataDir, "kontexta.json"), "utf8"));
    const h = cfg?.journal?.hooks ?? {};
    const pick = (k) => (Number.isInteger(h[k]) && h[k] > 0 ? h[k] : DEFAULT_CAPS[k]);
    return { prompt_max_bytes: pick("prompt_max_bytes"), reply_max_bytes: pick("reply_max_bytes"), command_max_bytes: pick("command_max_bytes") };
  } catch { return { ...DEFAULT_CAPS }; }
}

// Windows paths differ in separator and drive-letter case between the registered path and the agent-reported cwd, so compare a normalised form.
function normPath(p) {
  const win = /^[A-Za-z]:[\\/]/.test(p);
  let q = p.replace(/\\/g, "/");
  if (win) q = q.toLowerCase();
  return q.endsWith("/") ? q : q + "/";
}

export function slugFor(cwd, dataDir) {
  try {
    const { projects } = JSON.parse(readFileSync(join(dataDir, "hooks", "projects.json"), "utf8"));
    const c = normPath(cwd);
    let best = null;
    for (const p of projects ?? []) {
      if (!str(p?.path) || !str(p?.slug)) continue;
      const base = normPath(p.path);
      if (c.startsWith(base) && (!best || base.length > best.len)) best = { slug: p.slug, len: base.length };
    }
    return best ? best.slug : "default";
  } catch { return "default"; }
}

function findGitDir(start) {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, ".git");
    try {
      const st = statSync(candidate);
      if (st.isDirectory()) return candidate;
      const m = readFileSync(candidate, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (m) return isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim());
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function gitBranch(cwd) {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return null;
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return { branch: ref[1], head: null };
    return { branch: head.slice(0, 7), head };
  } catch { return null; }
}

function stdinTimeoutMs(env) {
  const n = Number(env.KONTEXTA_HOOK_STDIN_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : 5000;
}

// Stream (not readFileSync) so a non-blocking or never-closing stdin can't hang or crash the agent's turn; gives up after the timeout.
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    process.stdin.on("data", (c) => {
      total += c.length;
      if (total > MAX_STDIN_BYTES) { finish(null); return; }
      chunks.push(c);
    });
    process.stdin.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => finish(null));
  });
}

function commandString(v) {
  if (str(v)) return v;
  if (Array.isArray(v) && v.length > 0 && v.every(str)) return v.join(" ");
  return null;
}

// ---------- adapters: agent payload → partial events ----------
function askUserQuestion(p, sid) {
  const qs = Array.isArray(p.tool_input?.questions) ? p.tool_input.questions : [];
  const resp = p.tool_response;
  const answers = resp && typeof resp === "object" && resp.answers && typeof resp.answers === "object" ? resp.answers : null;
  const questions = [];
  qs.forEach((q, i) => {
    const question = str(q?.question) ? q.question : str(q?.header) ? q.header : null;
    if (!question) return;
    let a = answers ? (answers[question] ?? answers[q?.header] ?? (Array.isArray(answers) ? answers[i] : undefined)) : undefined;
    if (a !== undefined && typeof a !== "string") a = JSON.stringify(a);
    questions.push(a === undefined ? { question } : { question, answer: a });
  });
  return questions.length ? [{ event: "agent_question", questions, sid }] : [];
}

function adaptClaudeCode(p) {
  const sid = p.session_id;
  switch (p.hook_event_name) {
    case "UserPromptSubmit": return str(p.prompt) ? [{ event: "user_prompt", text: p.prompt, sid }] : [];
    case "Stop": return str(p.last_assistant_message) ? [{ event: "agent_reply", text: p.last_assistant_message, sid }] : [];
    case "SubagentStop": return str(p.last_assistant_message) ? [{ event: "agent_reply", text: p.last_assistant_message, sid, subagent: true }] : [];
    case "PostToolUse":
      if (p.tool_name === "Bash" && str(p.tool_input?.command)) return [{ event: "shell", command: p.tool_input.command, sid }];
      if (p.tool_name === "AskUserQuestion") return askUserQuestion(p, sid);
      return [];
    default: return [];
  }
}

function adaptGemini(p) {
  const sid = p.session_id;
  switch (p.hook_event_name) {
    case "BeforeAgent": return str(p.prompt) ? [{ event: "user_prompt", text: p.prompt, sid }] : [];
    case "AfterAgent": return str(p.prompt_response) ? [{ event: "agent_reply", text: p.prompt_response, sid }] : [];
    case "AfterTool": {
      const c = p.tool_name === "run_shell_command" ? commandString(p.tool_input?.command) : null;
      return c ? [{ event: "shell", command: c, sid }] : [];
    }
    default: return [];
  }
}

const CODEX_SHELL_TOOLS = new Set(["shell", "local_shell", "exec_command", "bash", "container.exec"]);
function adaptCodex(p) {
  const sid = p.session_id ?? p.turn_id;
  switch (p.hook_event_name) {
    case "UserPromptSubmit": return str(p.prompt) ? [{ event: "user_prompt", text: p.prompt, sid }] : [];
    case "Stop": return str(p.last_assistant_message) ? [{ event: "agent_reply", text: p.last_assistant_message, sid }] : [];
    case "SubagentStop": return str(p.last_assistant_message) ? [{ event: "agent_reply", text: p.last_assistant_message, sid, subagent: true }] : [];
    case "PostToolUse": {
      const c = CODEX_SHELL_TOOLS.has(p.tool_name) ? commandString(p.tool_input?.command ?? p.tool_input?.cmd) : null;
      return c ? [{ event: "shell", command: c, sid }] : [];
    }
    default: return [];
  }
}

// Copilot payloads carry no event name; the installer passes --event, and we infer from fields as a fallback.
function adaptCopilot(p, hint) {
  const sid = p.sessionId;
  const ev = hint ?? (str(p.prompt) ? "userPromptSubmitted" : str(p.response) ? "subagentStop" : str(p.toolName) ? "postToolUse" : "");
  switch (ev) {
    case "userPromptSubmitted": return str(p.prompt) ? [{ event: "user_prompt", text: p.prompt, sid }] : [];
    case "subagentStop": return str(p.response) ? [{ event: "agent_reply", text: p.response, sid, subagent: true }] : [];
    case "postToolUse": {
      if (p.toolName !== "bash" && p.toolName !== "powershell") return [];
      let args = p.toolArgs;
      if (str(args)) { try { args = JSON.parse(args); } catch { return []; } }
      const c = commandString(args?.command);
      return c ? [{ event: "shell", command: c, sid }] : [];
    }
    default: return [];
  }
}

function adaptCursor(p) {
  const sid = p.conversation_id;
  switch (p.hook_event_name) {
    case "beforeSubmitPrompt": return str(p.prompt) ? [{ event: "user_prompt", text: p.prompt, sid }] : [];
    case "afterAgentResponse": return str(p.text) ? [{ event: "agent_reply", text: p.text, sid }] : [];
    case "afterShellExecution": return str(p.command) ? [{ event: "shell", command: p.command, sid }] : [];
    default: return [];
  }
}

function adaptWindsurf(p, hint) {
  const sid = p.trajectory_id;
  const info = p.tool_info ?? {};
  switch (p.agent_action_name ?? hint) {
    case "pre_user_prompt": return str(info.user_prompt) ? [{ event: "user_prompt", text: info.user_prompt, sid }] : [];
    case "post_cascade_response": return str(info.response) ? [{ event: "agent_reply", text: info.response, sid }] : [];
    case "post_run_command": return str(info.command_line) ? [{ event: "shell", command: info.command_line, sid }] : [];
    default: return [];
  }
}

// Kiro's payload has no session id, so sessions are keyed by working directory; the shell tool is `execute_bash` in older docs and `shell` in current agent configs.
function adaptKiro(p) {
  const sid = p.session_id ?? p.cwd;
  switch (p.hook_event_name) {
    case "userPromptSubmit": return str(p.prompt) ? [{ event: "user_prompt", text: p.prompt, sid }] : [];
    case "postToolUse": {
      const c = p.tool_name === "execute_bash" || p.tool_name === "shell" ? commandString(p.tool_input?.command) : null;
      return c ? [{ event: "shell", command: c, sid }] : [];
    }
    default: return [];
  }
}

function adaptCline(p) {
  const sid = p.taskId;
  switch (p.hookName) {
    case "UserPromptSubmit": return str(p.userPromptSubmit?.prompt) ? [{ event: "user_prompt", text: p.userPromptSubmit.prompt, sid }] : [];
    case "PostToolUse": {
      const t = p.postToolUse;
      const c = t?.toolName === "execute_command" ? commandString(t.parameters?.command) : null;
      return c ? [{ event: "shell", command: c, sid }] : [];
    }
    default: return [];
  }
}

// The OpenCode plugin (installed by kontexta) already normalises; it sends { kontexta_event, session_id, text | command }.
function adaptOpenCode(p) {
  const sid = p.session_id;
  if (p.kontexta_event === "user_prompt" && str(p.text)) return [{ event: "user_prompt", text: p.text, sid }];
  if (p.kontexta_event === "shell" && str(p.command)) return [{ event: "shell", command: p.command, sid }];
  return [];
}

export const ADAPTERS = {
  "claude-code": adaptClaudeCode,
  gemini: adaptGemini,
  codex: adaptCodex,
  copilot: adaptCopilot,
  cursor: adaptCursor,
  windsurf: adaptWindsurf,
  kiro: adaptKiro,
  cline: adaptCline,
  opencode: adaptOpenCode,
};

// ---------- normalise + write ----------
export function normalise(partials, ctx) {
  const out = [];
  for (const pe of partials) {
    const ev = { ts: ctx.ts, agent: ctx.agent, sid: `${ctx.agent}:${str(pe.sid) ? pe.sid : "unknown"}`, event: pe.event, source: "hook", cwd: ctx.cwd };
    if (ctx.branch) ev.branch = ctx.branch;
    if (pe.subagent) ev.subagent = true;
    if (pe.event === "user_prompt" || pe.event === "agent_reply") {
      const max = pe.event === "user_prompt" ? ctx.caps.prompt_max_bytes : ctx.caps.reply_max_bytes;
      const c = capUtf8(redactText(pe.text), max);
      ev.text = c.text; if (c.truncated) { ev.truncated = true; ev.bytes = c.bytes; }
    } else if (pe.event === "shell") {
      const c = capUtf8(redactText(pe.command), ctx.caps.command_max_bytes);
      ev.command = c.text; if (c.truncated) { ev.truncated = true; ev.bytes = c.bytes; }
    } else if (pe.event === "agent_question") {
      ev.questions = redactDeep(pe.questions);
    } else {
      continue;
    }
    out.push(ev);
  }
  return out;
}

function stateFile(dataDir, sid) {
  return join(dataDir, "hooks", "state", `${sid.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function gitContextIfChanged(dataDir, sid, git, ctx) {
  if (!git?.branch) return [];
  const f = stateFile(dataDir, sid);
  let prev = null;
  try { prev = JSON.parse(readFileSync(f, "utf8")).branch ?? null; } catch {}
  if (prev === git.branch) return [];
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify({ branch: git.branch, ts: ctx.ts })); } catch {}
  const ev = { ts: ctx.ts, agent: ctx.agent, sid, event: "git_context", source: "hook", cwd: ctx.cwd, branch: git.branch };
  if (git.head) ev.head = git.head;
  return [ev];
}

function appendEvents(dataDir, slug, events) {
  if (events.length === 0) return;
  const day = events[0].ts.slice(0, 10);
  const dir = join(dataDir, "knowledge", "journal", slug, "raw");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day}.jsonl`);
  for (const ev of events) appendFileSync(file, JSON.stringify(ev) + "\n");
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const agent = argValue(argv, "--agent");
  const adapter = agent ? ADAPTERS[agent] : undefined;
  if (!adapter) return;
  const raw = await readStdin(stdinTimeoutMs(env));
  if (raw === null || raw.trim() === "") return;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (!payload || typeof payload !== "object") return;

  const dataDir = resolveDataDir(argv, env);
  const partials = adapter(payload, argValue(argv, "--event"));
  if (partials.length === 0) return;

  const cwd = str(payload.cwd) ? payload.cwd
    : str(payload.tool_info?.cwd) ? payload.tool_info.cwd
    : Array.isArray(payload.workspace_roots) && str(payload.workspace_roots[0]) ? payload.workspace_roots[0]
    : Array.isArray(payload.workspaceRoots) && str(payload.workspaceRoots[0]) ? payload.workspaceRoots[0]
    : process.cwd();
  const git = gitBranch(cwd);
  const ctx = { ts: new Date().toISOString(), agent, cwd, branch: git?.branch, caps: readCaps(dataDir) };
  const events = normalise(partials, ctx);
  if (events.length === 0) return;
  const sid = events[0].sid;
  appendEvents(dataDir, slugFor(cwd, dataDir), [...gitContextIfChanged(dataDir, sid, git, ctx), ...events]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .catch((e) => { try { process.stderr.write(`[kontexta-hooks] ${e?.message ?? e}\n`); } catch {} })
    .finally(() => process.exit(0));
}
