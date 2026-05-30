import { describe, test, expect } from "vitest";
import { POST } from "./route";
import { listFiles, readFile } from "kxta-core";

function multipart(parts: Record<string, string | { filename: string; content: string; type?: string }[]>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(parts)) {
    if (typeof v === "string") {
      fd.append(k, v);
    } else {
      for (const f of v) {
        fd.append(k, new File([f.content], f.filename, { type: f.type ?? "text/markdown" }));
      }
    }
  }
  return new Request("http://localhost/api/files/upload", { method: "POST", body: fd });
}

describe("POST /api/files/upload", () => {
  test("uploads a single .md file to KB root", async () => {
    const res = await POST(multipart({
      project_id: "",
      folder: "",
      files: [{ filename: "notes.md", content: "# Hello" }],
    }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploaded.length).toBe(1);
    expect(body.rejected).toEqual([]);
    expect(body.uploaded[0].original_name).toBe("notes.md");
    expect(body.uploaded[0].final_name).toBe("notes.md");
    const file = readFile(body.uploaded[0].id);
    expect(file.content).toBe("# Hello");
  });

  test("auto-suffixes on collision", async () => {
    await POST(multipart({
      project_id: "",
      folder: "",
      files: [{ filename: "dup.md", content: "first" }],
    }) as any);
    const res = await POST(multipart({
      project_id: "",
      folder: "",
      files: [{ filename: "dup.md", content: "second" }],
    }) as any);
    const body = await res.json();
    expect(body.uploaded[0].final_name).toBe("dup-2.md");
  });

  test("rejects non-markdown extensions", async () => {
    const res = await POST(multipart({
      project_id: "",
      folder: "",
      files: [
        { filename: "ok.md", content: "x" },
        { filename: "bad.png", content: "x", type: "image/png" },
      ],
    }) as any);
    const body = await res.json();
    expect(body.uploaded.length).toBe(1);
    expect(body.rejected).toEqual([{ name: "bad.png", reason: "unsupported_extension" }]);
  });

  test("rejects oversize files", async () => {
    const huge = "x".repeat(5 * 1024 * 1024 + 1);
    const res = await POST(multipart({
      project_id: "",
      folder: "",
      files: [{ filename: "big.md", content: huge }],
    }) as any);
    const body = await res.json();
    expect(body.uploaded).toEqual([]);
    expect(body.rejected).toEqual([{ name: "big.md", reason: "too_large" }]);
  });

  test("400 when no files", async () => {
    const res = await POST(multipart({ project_id: "", folder: "" }) as any);
    expect(res.status).toBe(400);
  });

  test("accepts .mmd uploads", async () => {
    const res = await POST(multipart({
      project_id: "",
      folder: "",
      files: [{ filename: "flow.mmd", content: "graph TD\nA-->B", type: "text/plain" }],
    }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploaded).toHaveLength(1);
    expect(body.uploaded[0].final_name).toMatch(/\.mmd$/);
  });

  test("still rejects unrelated extensions", async () => {
    const res = await POST(multipart({
      project_id: "",
      folder: "",
      files: [{ filename: "data.json", content: "x", type: "application/json" }],
    }) as any);
    const body = await res.json();
    expect(body.rejected.length).toBeGreaterThan(0);
  });
});
