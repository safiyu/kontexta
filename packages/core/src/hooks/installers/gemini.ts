import { groupedInstaller } from "./grouped.js";

export const geminiInstaller = groupedInstaller({
  id: "gemini",
  relPath: [".gemini", "settings.json"],
  events: [
    { name: "BeforeAgent" },
    { name: "AfterAgent" },
    { name: "AfterTool", matcher: "run_shell_command" },
  ],
});
