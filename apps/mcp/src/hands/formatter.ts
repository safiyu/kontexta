import type { ExecResult } from "./types.js";

export function formatExecResult(toolName: string, r: ExecResult): string {
  const statusLine = ({
    success: `Success (exit ${r.exitCode})`,
    failed:  `Failed (exit ${r.exitCode})`,
    timeout: `Timeout`,
    rejected: `Rejected${r.rejectionReason ? `: ${r.rejectionReason}` : ""}`,
  } as const)[r.status];

  const durSec = (r.durationMs / 1000).toFixed(1);
  const parts = [
    `## Tool: ${toolName}`,
    `**Status:** ${statusLine}`,
    `**Duration:** ${durSec}s`,
    `**Working Directory:** ${r.workingDir}`,
    ``,
    `### stdout`,
    "```",
    r.stdout || "",
    "```",
  ];
  if (r.stderr && r.stderr.length > 0) {
    parts.push(``, `### stderr`, "```", r.stderr, "```");
  }
  return parts.join("\n");
}

export interface PendingFormatInput {
  toolName: string;
  projectName: string;
  resolvedArgv: string[];
  workingDir: string;
  token: string;
}

export function formatPendingConfirm(p: PendingFormatInput): string {
  return [
    `This tool requires human approval before running.`,
    ``,
    `  Tool:    ${p.toolName}`,
    `  Project: ${p.projectName}`,
    `  Command (resolved):`,
    ...p.resolvedArgv.map((a, i) => `    [${i}] ${a}`),
    `  Working dir: ${p.workingDir}`,
    ``,
    `To approve, call: confirm_hand({ token: "${p.token}" })`,
    `This token expires in 60 seconds.`,
  ].join("\n");
}
