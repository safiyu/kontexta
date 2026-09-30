import { describe, it, expect } from "vitest";
import { dockerConnectCommand } from "../../src/mcp-install/alerts.js";

describe("dockerConnectCommand", () => {
  it("mounts home and the data dir and runs the connect CLI without the database", () => {
    const c = dockerConnectCommand({ agent: "cursor", version: "5.1.0", hostDataDir: "/home/me/kx" });
    expect(c).toBe('docker run --rm -v "$HOME":/host -v "/home/me/kx":/app/data safiyu/kontexta:5.1.0 connect install --home /host --host-data-dir "/home/me/kx" --no-db --install-mode docker --agent cursor');
  });

  it("adds the approval level only when it is not the default", () => {
    expect(dockerConnectCommand({ agent: "gemini", version: "1", hostDataDir: "/d", approval: "prompt" })).not.toMatch(/--approval/);
    expect(dockerConnectCommand({ agent: "gemini", version: "1", hostDataDir: "/d", approval: "safe" })).toMatch(/--approval safe$/);
  });

  it("uses a placeholder for a relative or unknown host dir", () => {
    expect(dockerConnectCommand({ agent: "cursor", version: "1", hostDataDir: "./kontexta-data" })).toContain('"<DATA_DIR>"');
    expect(dockerConnectCommand({ agent: "cursor", version: "1", hostDataDir: null })).toContain('"<DATA_DIR>"');
  });

  it("escapes shell metacharacters in the host path", () => {
    expect(dockerConnectCommand({ agent: "cursor", version: "1", hostDataDir: '/tmp/a"b$c' })).toContain('"/tmp/a\\"b\\$c"');
  });
});
