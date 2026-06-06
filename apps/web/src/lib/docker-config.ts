import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR } from "@/lib/db-init";

const DOCKER_CONFIG_FILE = "kontexta-docker.json";

function configPath(): string {
  return path.join(DATA_DIR, DOCKER_CONFIG_FILE);
}

export interface DockerConfig {
  hostDataDir: string;
  hostPort: number;
  wsHostPort: number;
  projectDir: string;
}

const DEFAULTS: DockerConfig = {
  hostDataDir: "",
  hostPort: 3000,
  wsHostPort: 3001,
  projectDir: "",
};

export function loadDockerConfig(): DockerConfig {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return { ...DEFAULTS };
    const raw = fs.readFileSync(p, "utf8").trim();
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<DockerConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveDockerConfig(config: Partial<DockerConfig>): void {
  const current = loadDockerConfig();
  const merged = { ...current, ...config };
  // Validate: hostPort and wsHostPort must be positive integers
  if (merged.hostPort && (!Number.isInteger(merged.hostPort) || merged.hostPort < 1)) {
    throw new Error("hostPort must be a positive integer");
  }
  if (merged.wsHostPort && (!Number.isInteger(merged.wsHostPort) || merged.wsHostPort < 1)) {
    throw new Error("wsHostPort must be a positive integer");
  }
  try {
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), "utf8");
  } catch (err) {
    throw new Error(`Failed to write docker config: ${(err as Error).message}`);
  }
}
