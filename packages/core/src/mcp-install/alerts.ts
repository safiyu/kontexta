import { dq, isAbsoluteHostPath } from "../hooks/alerts.js";
import type { McpApproval } from "../hooks/registry.js";

// The container cannot edit files on the host, so it runs the installer in a throw-away container with the home folder mounted.
export function dockerConnectCommand(o: { agent: string; version: string; hostDataDir?: string | null; approval?: McpApproval }): string {
  const dir = o.hostDataDir && isAbsoluteHostPath(o.hostDataDir) ? dq(o.hostDataDir) : "<DATA_DIR>";
  const approval = o.approval && o.approval !== "prompt" ? ` --approval ${o.approval}` : "";
  return `docker run --rm -v "$HOME":/host -v "${dir}":/app/data safiyu/kontexta:${o.version} connect install --home /host --host-data-dir "${dir}" --no-db --install-mode docker --agent ${o.agent}${approval}`;
}
