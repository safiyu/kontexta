export function buildSchemaDoc(): string {
  return `# Kontexta Hands — \`kontexta.json\` Authoring Reference

## 1. Overview

\`kontexta.json\` lives at the root of any registered Kontexta project. It declares command-line tools that AI agents can execute through Kontexta's MCP server. The file is read at MCP server startup, after \`register_project\` succeeds, and on \`reload_hands\` calls.

## 2. JSON Schema (Draft 2020-12)

\`\`\`json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["version", "tools"],
  "properties": {
    "version": { "const": "1" },
    "tools": {
      "type": "object",
      "patternProperties": {
        "^[a-z][a-z0-9-]*$": {
          "type": "object",
          "required": ["description", "command"],
          "properties": {
            "description": { "type": "string", "minLength": 1 },
            "command": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
            "workingDir": { "type": "string" },
            "timeout": { "type": "number", "minimum": 1, "maximum": 300000 },
            "danger": { "enum": ["safe", "moderate", "high"] },
            "confirm": { "type": "boolean" },
            "disabled": { "type": "boolean" },
            "argSeparator": { "type": "boolean" },
            "maxOutputBytes": { "type": "number", "minimum": 1, "maximum": 1000000 },
            "env": { "type": "object", "additionalProperties": { "type": "string" } },
            "params": {
              "type": "object",
              "additionalProperties": {
                "type": "object",
                "required": ["type"],
                "properties": {
                  "type": { "enum": ["string", "number", "boolean"] },
                  "required": { "type": "boolean" },
                  "default": {},
                  "pattern": { "type": "string" },
                  "min": { "type": "number" },
                  "max": { "type": "number" }
                }
              }
            }
          }
        }
      }
    }
  }
}
\`\`\`

## 3. Field reference

- **\`version\`** — must be the string \`"1"\`. Future versions may change the schema.
- **\`tools.<tool-name>\`** — tool name must match \`^[a-z][a-z0-9-]*$\`. Exposed to the agent as \`<project>__<tool-name>\`.
- **\`description\`** — required, non-empty string. Shown to the agent.
- **\`command\`** — required, non-empty array of strings. Element 0 is the executable; remaining elements are argv. Use \`{{name}}\` for parameter substitution (element 0 may not contain substitutions).
- **\`workingDir\`** — optional, relative to project root. Must not contain \`..\`. Symlinks are resolved and verified to remain inside the project root.
- **\`timeout\`** — optional, milliseconds. Default 60000, max 300000 (clamped).
- **\`danger\`** — \`safe | moderate | high\`. Default \`safe\`. Informational; \`confirm: true\` is what actually pauses execution.
- **\`confirm\`** — boolean, default false. When true, the first call returns a token; agent must call \`confirm_hand({ token })\` to actually execute.
- **\`disabled\`** — boolean, default false. Disabled tools are validated but never registered. Agent never sees them.
- **\`argSeparator\`** — boolean, default false. When true, \`--\` is inserted in argv before the first substituted element.
- **\`maxOutputBytes\`** — optional, per-stream output cap. Default 100000, max 1000000 (clamped).
- **\`env\`** — optional, key/value strings. Cannot include \`PATH\`, \`LD_PRELOAD\`, \`LD_LIBRARY_PATH\`, \`DYLD_*\`.
- **\`params.<name>.type\`** — \`string | number | boolean\`.
- **\`params.<name>.required\`** — boolean, default false.
- **\`params.<name>.default\`** — used when the agent omits the param.
- **\`params.<name>.pattern\`** — string params only. Validated via the \`re2\` engine (linear-time, ReDoS-proof). Empty-string values always pass pattern validation. Strings with no explicit pattern get a default of \`^[^-].*\`.
- **\`params.<name>.min\` / \`max\`** — number params only.

## 4. Validation rules and errors

| Rule | Error |
|---|---|
| \`tool-name\` not matching \`^[a-z][a-z0-9-]*$\` | \`tool name '<name>' invalid\` |
| \`command\` not a non-empty array of strings | \`command must be non-empty array\` |
| \`command[0]\` containing \`{{...}}\` | \`argv[0] must be literal\` |
| Placeholder \`{{x}}\` with no matching param def | \`placeholder {{x}} has no param def\` |
| \`params.pattern\` not compiling under re2 | \`param '<name>' invalid pattern\` |
| \`workingDir\` absolute or containing \`..\` | rejected at load |
| \`workingDir\` symlinking outside project root | rejected at execution |
| \`env\` key in forbidden set | rejected at load |
| Param value containing NUL | rejected at execution |
| String param value with leading dash, no explicit pattern | rejected at execution |
| Numeric param NaN/Infinity/out-of-safe-int-range | rejected at execution |
| Boolean param not exactly \`true\` or \`false\` | rejected at execution |

## 5. Security guarantees

- Only commands defined by the human in \`kontexta.json\` can run.
- No shell ever interprets the command. \`spawn\` runs with \`shell: false\`; commands are arrays.
- The executable (\`command[0]\`) is fixed by the author; agents cannot change which binary runs.
- Default string pattern \`^[^-].*\` mitigates argv injection. \`argSeparator: true\` provides belt-and-braces.
- All regex matching uses \`re2\` — no catastrophic backtracking.
- NUL bytes are rejected in all param values, regardless of pattern.
- Numeric params are bounded and finite; booleans are strict.
- Working directory is locked to the project root (verified via \`realpath\`).
- Environment is a clean base of \`PATH\`/\`HOME\`/\`USER\`/\`LANG\`/\`TZ\` plus the tool's \`env\`. Agents cannot add env keys.
- Output is captured through a streaming ring buffer; large outputs are truncated in the middle, never hold more than the cap in memory.
- Timeouts kill the entire process group (\`SIGTERM\`, then \`SIGKILL\` after 3 s) — no orphan workers.
- Confirm tokens are 32-byte CSPRNG, single-use, expire in 60 s, and bound to a hash of the resolved invocation.
- The agent cannot modify \`kontexta.json\` through any MCP tool.

## 6. Limitations

- A poorly written \`kontexta.json\` (e.g. \`["sh", "-c", "{{anything}}"]\`) defeats every guarantee. Authoring is the human's responsibility.
- Tool output may contain prompt-injection payloads. Treat the agent as potentially influenced after reading any command output.
- No CPU/memory/disk quotas — a command can exhaust resources up to the timeout.
- A Hand defined as a shell command could in principle write \`kontexta.json\` from inside execution. Keep \`kontexta.json\` on a path no other tool will edit, and review diffs before \`reload_hands\`.
- No rate limiting on \`reload_hands\`.

## 7. Authoring warnings

- **Argv injection.** \`["rm", "{{path}}"]\` with a permissive pattern lets \`path="-rf"\` become \`rm -rf\`. Use the default \`^[^-].*\`, an explicit strict pattern, or \`argSeparator: true\`.
- **Missing confirm on remote writes.** Always set \`confirm: true\` on tools that mutate remote systems (deploy, push, publish, drop).
- **Shell passthrough.** \`["sh", "-c", "{{cmd}}"]\` and \`["bash", "-c", "{{cmd}}"]\` make every guarantee meaningless. Don't.
- **Unused params.** A param defined but never referenced in \`command\` is allowed but produces a load-time warning. Either use it or remove it.
- **Permissive path patterns.** \`.*\` permits \`../../etc/passwd\`. Constrain to the actual character set you accept.
- **Long timeout on network tools.** A 5-minute timeout on a tool that blocks waiting for a server can wedge the agent. Set timeouts to the shortest plausible value.

## 8. Recommended practices

- Set \`disabled: true\` on high-danger tools by default; enable manually when needed.
- Prefer specific patterns. \`^[a-z]+$\` is much safer than \`.*\`.
- Set \`confirm: true\` on anything that writes to remote systems or production.
- Use \`argSeparator: true\` on tools where a substituted param sits next to a path-accepting flag.
- Commit \`kontexta.json\` to version control. Review changes the way you review infrastructure changes.

## 9. Annotated example

\`\`\`json
{
  "version": "1",
  "tools": {
    "list-files": {
      "description": "List files in the repo (no params, completely safe)",
      "command": ["git", "ls-files"]
    },
    "run-tests": {
      "description": "Run vitest with optional filter (regex-validated)",
      "command": ["npx", "vitest", "--reporter=verbose", "{{filter}}"],
      "timeout": 120000,
      "params": {
        "filter": { "type": "string", "required": false, "default": "", "pattern": "^[a-zA-Z0-9 _/-]*$" }
      }
    },
    "deploy-staging": {
      "description": "Deploy to staging Cloud Run (requires human approval)",
      "command": ["gcloud", "run", "deploy", "my-service", "--region", "us-central1"],
      "danger": "moderate",
      "confirm": true,
      "timeout": 180000
    },
    "deploy-production": {
      "description": "Deploy to production (disabled by default)",
      "command": ["npm", "run", "deploy:prod"],
      "danger": "high",
      "confirm": true,
      "disabled": true
    },
    "remove-temp": {
      "description": "Delete a temp file under /tmp/scratch (argSeparator guards path)",
      "command": ["rm", "{{name}}"],
      "argSeparator": true,
      "workingDir": "tmp/scratch",
      "params": {
        "name": { "type": "string", "required": true, "pattern": "^[a-zA-Z0-9._-]+$" }
      }
    }
  }
}
\`\`\`

What each tool demonstrates:

- \`list-files\` — minimal tool with no params.
- \`run-tests\` — optional param with a regex pattern; empty default safely drops the argv element.
- \`deploy-staging\` — \`confirm: true\` makes the agent pause for human approval.
- \`deploy-production\` — \`disabled: true\` keeps a high-risk tool in the file but invisible to the agent.
- \`remove-temp\` — \`argSeparator: true\` plus a strict pattern to prevent argv injection on a path-accepting command.

## 10. Out of scope (v7.0.0)

- Streaming stdout to the agent in real time (full output returned on completion).
- Chained tool execution (running multiple Hands in sequence automatically).
- Agent-writable \`kontexta.json\`.
- Remote execution.
- Web UI for managing Hands.
- Per-tool execution history or audit log.
- Per-tool \`inheritEnv\` opt-in for additional parent env keys.
- \`scaffold_hands\` tool to auto-detect \`package.json\` scripts.
- CPU/memory/disk quotas via cgroups.
- Rate limiting on \`reload_hands\`.
`;
}
