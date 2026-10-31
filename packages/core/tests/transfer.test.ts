import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { createFile } from "../src/files/index.js";
import { setFavorite } from "../src/metadata/index.js";
import { exportContexts, importContexts, writeArchive, readArchive } from "../src/transfer/index.js";

let src: string;
let dst: string;

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "kontexta-transfer-"));
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  return dir;
}

beforeEach(() => {
  src = fresh();
  dst = fresh();
  createDatabase(join(src, "test.db"));
});
afterEach(() => {
  closeDatabase();
  rmSync(src, { recursive: true, force: true });
  rmSync(dst, { recursive: true, force: true });
});

async function seed() {
  const note = await createFile({
    title: "api-notes", content: "# API\nhello", destination: "knowledge",
    folder: "knowledge/notes", tags: ["api", "backend"], dataDir: src,
  });
  setFavorite(note.id, true);
  await createFile({
    title: "term", content: "dict body", destination: "knowledge",
    folder: "knowledge/dictionary", tags: [], dataDir: src,
  });
}

describe("transfer", () => {
  test("export → gzip archive → import into a fresh db restores files, tags, favorites", async () => {
    await seed();
    const archive = exportContexts({ dataDir: src });
    expect(archive.files).toHaveLength(2);
    const out = join(src, "out", "ctx.kxta.json.gz");
    writeArchive(archive, out);
    closeDatabase();

    createDatabase(join(dst, "test.db"));
    const r = await importContexts(readArchive(out), { dataDir: dst });
    expect(r.errors).toEqual([]);
    expect(r.created).toBe(2);
    expect(readFileSync(join(dst, "knowledge", "knowledge", "notes", "api-notes.md"), "utf8")).toBe("# API\nhello");

    const again = exportContexts({ dataDir: dst });
    const n = again.files.find((f) => f.path.endsWith("api-notes.md"))!;
    expect(n.tags.sort()).toEqual(["api", "backend"]);
    expect(n.favorite).toBe(true);
  });

  test("re-import overwrites existing files; dry run writes nothing", async () => {
    await seed();
    const archive = exportContexts({ dataDir: src });
    const dry = await importContexts(archive, { dataDir: src, dryRun: true });
    expect(dry.overwritten).toBe(2);
    archive.files[0].content = "changed";
    const r = await importContexts(archive, { dataDir: src });
    expect(r.overwritten).toBe(2);
    expect(readFileSync(join(src, archive.files[0].path), "utf8")).toBe("changed");
  });

  test("filters by tag and rejects path traversal / bad archives", async () => {
    await seed();
    expect(exportContexts({ dataDir: src, tags: ["api"] }).files).toHaveLength(1);
    const bad = exportContexts({ dataDir: src });
    bad.files[0].path = "knowledge/../../evil.md";
    const r = await importContexts(bad, { dataDir: dst });
    expect(r.errors.length).toBe(1);
    expect(existsSync(join(dst, "..", "evil.md"))).toBe(false);
    const p = join(src, "junk.json");
    writeArchive({ format: "nope" } as any, p);
    expect(() => readArchive(p)).toThrow(/Not a kontexta/);
  });
});
