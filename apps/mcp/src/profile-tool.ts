import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { profileRelPath, getMissingSections, REQUIRED_SECTIONS } from "kxta-core";

export interface GetProfileResult {
  exists: boolean;
  path: string;
  content: string | null;
  missing_sections: string[];
  hint: string | null;
}

export function handleGetProfile(dataDir: string): GetProfileResult {
  const rel = profileRelPath();
  const abs = join(dataDir, rel);
  if (!existsSync(abs)) {
    return {
      exists: false,
      path: rel,
      content: null,
      missing_sections: [...REQUIRED_SECTIONS],
      hint: "Profile not yet set up — ask the user to fill it in via the web UI or by editing knowledge/profile.md",
    };
  }
  const content = readFileSync(abs, "utf8");
  return {
    exists: true,
    path: rel,
    content,
    missing_sections: getMissingSections(content),
    hint: null,
  };
}
