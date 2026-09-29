import { groupedInstaller } from "./grouped.js";

export const claudeCodeInstaller = groupedInstaller({
  id: "claude-code",
  relPath: [".claude", "settings.json"],
  timeoutKey: "timeout", timeoutValue: 5,
  events: [
    { name: "UserPromptSubmit" },
    { name: "Stop" },
    { name: "SubagentStop" },
    { name: "PostToolUse", matcher: "Bash|AskUserQuestion" },
  ],
});
