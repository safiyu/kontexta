import { groupedInstaller } from "./grouped.js";

export const geminiInstaller = groupedInstaller({
  id: "gemini",
  relPath: [".gemini", "settings.json"],
  events: [
    { name: "BeforeAgent" },
    { name: "AfterAgent" },
    { name: "AfterTool", matcher: "run_shell_command" },
  ],
  notes: ["Gemini parses hook stdout as JSON; the emitter prints nothing, so no action needed."],
});
