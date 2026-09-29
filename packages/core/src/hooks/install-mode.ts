import { existsSync } from "node:fs";

export type InstallMode = "docker" | "npm" | "source";

export function detectInstallMode(env: NodeJS.ProcessEnv = process.env, fileExists: (p: string) => boolean = existsSync): InstallMode {
  const hint = env.KONTEXTA_INSTALL_HINT;
  if (hint === "docker" || hint === "npm" || hint === "source") return hint;
  try { if (fileExists("/.dockerenv")) return "docker"; } catch { /* unreadable root fs → keep probing */ }
  if (env.npm_execpath?.includes("npx")) return "npm";
  return "source";
}
