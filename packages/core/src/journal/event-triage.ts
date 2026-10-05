// Grades journal events 0-4 from their structure (event kind, tool, parsed shell command), never from free text:
// words inside heredocs, PR bodies and pasted logs say nothing about what an event did.
import type { RawEvent } from "./types.js";
import { READ_ONLY_TOOL_NAMES, isWriteToolName } from "./patterns/tool-classes.js";

/** 0 noise (read-only), 1 routine, 2 changes state, 3 significant outcome, 4 release / explicit pivot. */
export interface TriageResult {
  grade: 0 | 1 | 2 | 3 | 4;
  reason: string;
}

type Grade = TriageResult["grade"];

const READ_ONLY_VERBS = new Set([
  "ls", "ll", "cat", "bat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd",
  "pwd", "echo", "printf", "which", "type", "whoami", "date", "wc", "tree", "du", "df", "stat", "file", "diff", "cmp",
  "sort", "uniq", "cut", "tr", "awk", "jq", "yq", "env", "printenv", "id", "uname", "hostname", "ps", "lsof", "basename",
  "dirname", "realpath", "readlink", "test", "[", "true", "false", "sleep", "xxd", "hexdump", "strings", "column", "nl",
  "tac", "md5", "md5sum", "shasum", "sha256sum", "set", "alias", "history", "clear",
]);
const NAVIGATION_VERBS = new Set(["cd", "pushd", "popd"]);
const WRAPPER_VERBS = new Set(["sudo", "time", "nohup", "command", "exec", "env", "nice"]);
const FILE_MUTATORS = new Set(["mkdir", "touch", "mv", "cp", "rm", "rmdir", "ln", "chmod", "chown", "tee", "truncate", "install", "rsync", "unzip", "zip", "patch", "dd"]);
const INTERPRETERS = new Set(["node", "python", "python3", "ruby", "perl", "bash", "sh", "zsh", "deno", "bun"]);
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PKG_CHANGE = new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "up", "link", "unlink", "ci", "upgrade"]);
const OTHER_INSTALLERS = new Set(["pip", "pip3", "uv", "poetry", "pipx", "brew", "apt", "apt-get", "dnf", "yum", "cargo", "gem", "bundle"]);
const OTHER_INSTALL_ACTIONS = new Set(["install", "add", "remove", "uninstall", "update", "upgrade"]);
const GIT_READ = new Set(["status", "log", "diff", "show", "remote", "rev-parse", "rev-list", "ls-files", "ls-remote", "blame", "describe", "shortlog", "reflog", "grep", "cherry", "name-rev", "diff-tree", "merge-base", "version", "help"]);
const GIT_STATE = new Set(["checkout", "switch", "add", "rm", "mv", "restore", "stash", "pull", "clone", "init", "fetch", "worktree", "submodule", "clean"]);
const GIT_SIGNIFICANT = new Set(["commit", "merge", "rebase", "cherry-pick", "revert", "reset", "push", "am", "bisect"]);
const GH_READ_ACTIONS = new Set(["view", "list", "checks", "diff", "status", "watch", "download", "browse", "search"]);
const GH_RELEASE_ACTIONS = new Set(["merge", "delete", "archive"]);
const KUBECTL_MUTATE = new Set(["apply", "delete", "rollout", "scale", "patch", "replace", "create", "set", "annotate", "label", "cordon", "drain"]);
const GCLOUD_READ = new Set(["list", "describe", "get-iam-policy", "config", "auth", "info", "help", "version", "read", "get-value", "print-access-token", "get"]);
const SCRIPT_WRITES = /\b(writeFileSync|writeFile|appendFile|write_text|write_bytes|shutil\.(copy|move)|os\.(rename|remove)|fs\.(write|rename|unlink|rm)|\.write\()|\bopen\([^)]*['"][wax]\+?['"]/;

interface Prepared { segments: string[]; heredocs: string[] }

// Heredoc bodies and quoted strings can contain `;`, `&&`, `>` and any word: remove them before reading the command.
function prepare(command: string): Prepared {
  const heredocs: string[] = [];
  let text = command.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g, (_m, _q, _d, rest, body) => {
    heredocs.push(body);
    return `<<HD${rest}`;
  });
  text = text.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n([\s\S]*)$/, (_m, _q, _d, rest, body) => {
    heredocs.push(body);
    return `<<HD${rest}`;
  });
  text = text.replace(/\\./g, " ").replace(/'[^']*'/g, '""').replace(/"[^"]*"/g, '""');
  const segments = text.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  return { segments, heredocs };
}

function tokensOf(segment: string): string[] {
  const tokens = segment.replace(/^\(+/, "").split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && (/^\w+=\S*$/.test(tokens[0]) || WRAPPER_VERBS.has(tokens[0]))) tokens.shift();
  return tokens;
}

const baseName = (token: string): string => token.split("/").pop() ?? token;
// `> file` / `>> file` write; `2>&1`, `>&2` and `> /dev/null` do not.
const hasWriteRedirect = (segment: string): boolean =>
  /(^|[^<>=])>>?/.test(segment.replace(/\d*>&\d+/g, "").replace(/&?\d*>>?\s*\/dev\/null/g, ""));

interface SegmentGrade { grade: Grade; reason: string; verb: string }

function gradeSegment(segment: string, heredocs: string[], original: string): SegmentGrade | null {
  const tokens = tokensOf(segment);
  if (tokens.length === 0) return null;
  const verb = baseName(tokens[0]);
  const args = tokens.slice(1);
  const sub = args.find((a) => !a.startsWith("-")) ?? "";
  const done = (grade: Grade, reason: string): SegmentGrade => ({ grade, reason, verb });

  if (NAVIGATION_VERBS.has(verb)) return null;
  if (hasWriteRedirect(segment) && verb !== "git") return done(2, "writes a file");

  if (verb === "git") {
    const action = sub;
    if (action === "push") return done(args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease")) ? 4 : 3, "git push");
    if (action === "tag") {
      if (args.some((a) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at|-n\d*|--sort|--format)/.test(a))) return done(0, "git tag list");
      if (args.some((a) => a === "-d" || a === "--delete")) return done(3, "git tag delete");
      return done(args.filter((a) => !a.startsWith("-")).length > 1 ? 4 : 0, "git tag");
    }
    if (action === "branch") return done(args.some((a) => /^-[dDmMc]$|^--(delete|move|copy)$/.test(a)) || args.filter((a) => !a.startsWith("-")).length > 1 ? 2 : 0, "git branch");
    if (action === "config") return done(args.some((a) => /^--(get|list|show-origin)/.test(a)) ? 0 : 2, "git config");
    if (GIT_READ.has(action)) return done(0, "read-only git");
    if (action === "reset") return done(args.includes("--hard") ? 3 : 2, "git reset");
    if (GIT_SIGNIFICANT.has(action)) return done(3, `git ${action}`);
    if (GIT_STATE.has(action)) return done(action === "stash" && /^(list|show)$/.test(args[1] ?? "") ? 0 : 2, `git ${action}`);
    return done(1, "git");
  }

  if (verb === "gh") {
    const [area, action = ""] = args.filter((a) => !a.startsWith("-"));
    if (area === "release" && action === "create") return done(4, "gh release");
    if (area === "pr" && GH_RELEASE_ACTIONS.has(action)) return done(4, `gh pr ${action}`);
    if (area === "repo" && /^(create|delete|rename|archive)$/.test(action)) return done(4, `gh repo ${action}`);
    if (area === "workflow" && action === "run") return done(4, "gh workflow run");
    if (area === "api") return done(args.some((a, i) => /^(-X|--method)$/.test(a) && !/^get$/i.test(args[i + 1] ?? "")) || args.some((a) => /^(-f|-F|--field|--raw-field)$/.test(a)) ? 3 : 0, "gh api");
    if (GH_READ_ACTIONS.has(action) || area === "auth") return done(0, "read-only gh");
    return done(3, `gh ${area ?? ""} ${action}`.trim());
  }

  if (PKG_MANAGERS.has(verb)) {
    if (sub === "publish") return done(4, "package publish");
    if (PKG_CHANGE.has(sub)) return done(2, "changes dependencies");
    return done(1, "package script");
  }
  if (OTHER_INSTALLERS.has(verb)) return done(OTHER_INSTALL_ACTIONS.has(sub) ? 2 : 1, "package manager");

  if (verb === "docker") {
    if (sub === "push") return done(4, "docker push");
    if (/^(ps|images|logs|inspect|stats|version|info|top|history)$/.test(sub)) return done(0, "read-only docker");
    return done(1, "docker");
  }
  if (verb === "kubectl" || verb === "helm" || verb === "terraform") {
    if (verb === "kubectl" ? KUBECTL_MUTATE.has(sub) : /^(install|upgrade|uninstall|rollback|apply|destroy)$/.test(sub)) return done(4, `${verb} ${sub}`);
    return done(/^(get|describe|logs|top|list|show|plan|status|version|diff)$/.test(sub) ? 0 : 1, verb);
  }
  if (verb === "gcloud") {
    const readOnly = args.some((a) => GCLOUD_READ.has(a)) || args.some((a) => /^get-/.test(a));
    return done(readOnly ? 0 : /\b(create|delete|deploy|update|apply|patch|import|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding)\b/.test(args.join(" ")) ? 4 : 1, "gcloud");
  }

  if (verb === "sed") return done(args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) ? 2 : 0, "sed");
  if (verb === "tar") return done(args.some((a) => /^-?[a-zA-Z]*t[a-zA-Z]*$/.test(a)) ? 0 : 2, "tar");
  if (verb === "export" || verb === "source" || verb === "." || verb === "unset" || /^(nvm|pyenv|rbenv|asdf)$/.test(verb)) return done(2, "changes the environment");
  if (FILE_MUTATORS.has(verb)) return done(2, "changes files");

  if (INTERPRETERS.has(verb)) {
    const inline = args.includes("-c") || args.includes("-e") || args.includes("-") || heredocs.length > 0;
    if (inline) return done(heredocs.some((h) => SCRIPT_WRITES.test(h)) || SCRIPT_WRITES.test(original) ? 2 : 1, "inline script");
    return done(1, "runs a script");
  }

  if (READ_ONLY_VERBS.has(verb)) return done(0, "read-only command");
  return done(1, "command");
}

/** Verbs of the non-navigation parts of a shell command, in order. */
export function commandVerbs(command: string): string[] {
  const { segments, heredocs } = prepare(command);
  return segments.map((s) => gradeSegment(s, heredocs, command)).filter((g): g is SegmentGrade => g !== null).map((g) => g.verb);
}

export function gradeShellCommand(command: string): TriageResult {
  const { segments, heredocs } = prepare(command);
  const graded = segments.map((s) => gradeSegment(s, heredocs, command)).filter((g): g is SegmentGrade => g !== null);
  if (graded.length === 0) return { grade: 0, reason: "navigation only" };
  const top = graded.reduce((a, b) => (b.grade > a.grade ? b : a));
  return { grade: top.grade, reason: top.reason };
}

// A prompt that is an agent hand-back or system message was not typed by the person.
export function isHumanPrompt(text: string | undefined): boolean {
  return !!text && !/^\s*<[a-z][\w-]*[ >]/i.test(text);
}

export function gradeEvent(ev: Pick<RawEvent, "event" | "tool" | "status" | "command" | "text">): TriageResult {
  switch (ev.event) {
    case "shell":
      return ev.command ? gradeShellCommand(ev.command) : { grade: 1, reason: "shell" };
    case "error":
      return { grade: 3, reason: "error" };
    case "tool_call":
      if (ev.status === "error") return { grade: 3, reason: "tool failed" };
      if (ev.tool && READ_ONLY_TOOL_NAMES.has(ev.tool)) return { grade: 0, reason: "read-only tool" };
      if (ev.tool && isWriteToolName(ev.tool)) return { grade: 2, reason: "write tool" };
      return { grade: 1, reason: "tool" };
    case "git_commit":
      return { grade: 3, reason: "commit" };
    case "user_intent":
      return { grade: 4, reason: "explicit pivot" };
    case "agent_note":
      return { grade: 3, reason: "agent note" };
    case "user_prompt":
      return isHumanPrompt(ev.text) ? { grade: 2, reason: "user prompt" } : { grade: 1, reason: "system message" };
    case "agent_question":
      return { grade: 2, reason: "agent question" };
    default:
      return { grade: 1, reason: ev.event };
  }
}
