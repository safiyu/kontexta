import { groupedInstaller } from "./grouped.js";

export const codexInstaller = groupedInstaller({
  id: "codex",
  relPath: [".codex", "hooks.json"],
  events: [
    { name: "UserPromptSubmit" },
    { name: "Stop" },
    { name: "SubagentStop" },
    { name: "PostToolUse", matcher: "Bash" },
  ],
  notes: [
    "Codex only runs hooks you have trusted: open Codex and run /hooks to review and trust the kontexta hooks (trust is tied to the hook's content, so re-trust after reinstalling or moving node).",
    "Older Codex versions may also need `[features]\\ncodex_hooks = true` in ~/.codex/config.toml.",
  ],
});
