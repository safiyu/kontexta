import { describe, test, expect, beforeEach } from "vitest";
import { GET } from "./route";
import { createFile, registerProject, getDatabase } from "kxta-core";
import { ensureDbInitialized } from "@/lib/db-init";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import unzipper from "unzipper";

async function readZipEntries(res: Response): Promise<Map<string, string>> {
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = await unzipper.Open.buffer(buf);
  const out = new Map<string, string>();
  for (const entry of dir.files) {
    const content = await entry.buffer();
    out.set(entry.path, content.toString("utf-8"));
  }
  return out;
}

beforeEach(() => {
  ensureDbInitialized();
});

describe("GET /api/export/zip", () => {
  test("400 when no mode specified", async () => {
    const res = await GET(new Request("http://localhost/api/export/zip") as any);
    expect(res.status).toBe(400);
  });

  test("400 when multiple modes specified", async () => {
    const res = await GET(new Request("http://localhost/api/export/zip?file_ids=1&project_id=1") as any);
    expect(res.status).toBe(400);
  });

  test("404 when no files resolved", async () => {
    const res = await GET(new Request("http://localhost/api/export/zip?file_ids=999") as any);
    expect(res.status).toBe(404);
  });

  test("exports by file_ids preserving relative paths", async () => {
    const dataDir = process.env.KONTEXTA_DATA_DIR || "";
    const projectDir = join(dataDir, "test-project");
    mkdirSync(projectDir, { recursive: true });
    const project = registerProject("TestProj", projectDir);
    const f1 = await createFile({ title: "a", content: "AAA", destination: "project", projectId: project.id, folder: "specs", dataDir });
    const f2 = await createFile({ title: "b", content: "BBB", destination: "project", projectId: project.id, folder: "notes", dataDir });

    const res = await GET(new Request(`http://localhost/api/export/zip?file_ids=${f1.id},${f2.id}`) as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    const entries = await readZipEntries(res);
    // file_ids mode preserves project-relative paths.
    expect([...entries.keys()].sort()).toEqual(["notes/b.md", "specs/a.md"]);
    expect(entries.get("specs/a.md")).toBe("AAA");
  });

  test("exports a project recursively", async () => {
    const dataDir = process.env.KONTEXTA_DATA_DIR || "";
    const projectDir = join(dataDir, "p2");
    mkdirSync(projectDir, { recursive: true });
    const project = registerProject("P2", projectDir);
    await createFile({ title: "root", content: "R", destination: "project", projectId: project.id, dataDir });
    await createFile({ title: "deep", content: "D", destination: "project", projectId: project.id, folder: "sub/deeper", dataDir });

    const res = await GET(new Request(`http://localhost/api/export/zip?project_id=${project.id}`) as any);
    expect(res.status).toBe(200);
    const entries = await readZipEntries(res);
    expect(entries.get("root.md")).toBe("R");
    expect(entries.get("sub/deeper/deep.md")).toBe("D");
  });

  test("exports a folder", async () => {
    const dataDir = process.env.KONTEXTA_DATA_DIR || "";
    const projectDir = join(dataDir, "p3");
    mkdirSync(projectDir, { recursive: true });
    const project = registerProject("P3", projectDir);
    await createFile({ title: "in", content: "X", destination: "project", projectId: project.id, folder: "incl", dataDir });
    await createFile({ title: "out", content: "Y", destination: "project", projectId: project.id, folder: "other", dataDir });

    const res = await GET(new Request(`http://localhost/api/export/zip?project_id=${project.id}&folder=incl`) as any);
    expect(res.status).toBe(200);
    const entries = await readZipEntries(res);
    // folder mode = paths relative to the folder root.
    expect([...entries.keys()]).toEqual(["in.md"]);
  });

  test("413 when total size exceeds KONTEXTA_EXPORT_MAX_BYTES", async () => {
    process.env.KONTEXTA_EXPORT_MAX_BYTES = "10";
    try {
      const dataDir = process.env.KONTEXTA_DATA_DIR || "";
      const projectDir = join(dataDir, "p4");
      mkdirSync(projectDir, { recursive: true });
      const project = registerProject("P4", projectDir);
      await createFile({ title: "big", content: "x".repeat(50), destination: "project", projectId: project.id, dataDir });
      const res = await GET(new Request(`http://localhost/api/export/zip?project_id=${project.id}`) as any);
      expect(res.status).toBe(413);
    } finally {
      delete process.env.KONTEXTA_EXPORT_MAX_BYTES;
    }
  });
});
