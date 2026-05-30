import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RULE_BLOCK_VERSION, RULES_BLOCK_BODY, SCAFFOLDS, detectAgentContextFiles, parseMarker, injectOrUpdate, syncAgentRules } from "../src/agent-rules/index.js";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync, readdirSync as readdirSyncForTest } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("agent-rules constants", () => {
  it("RULE_BLOCK_VERSION is semver", () => {
    expect(RULE_BLOCK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("RULES_BLOCK_BODY contains BEGIN/END markers carrying the version", () => {
    expect(RULES_BLOCK_BODY).toContain(`<!-- BEGIN kontexta:rules v${RULE_BLOCK_VERSION} -->`);
    expect(RULES_BLOCK_BODY).toContain(`<!-- END kontexta:rules v${RULE_BLOCK_VERSION} -->`);
  });

  it("RULES_BLOCK_BODY mentions every required workflow rule", () => {
    for (const phrase of [
      "Search before reading",
      "All KB writes go through kontexta",
      "Batch reads",
      "Address `journal.suggested_action`",
      "Use `journal_note(text, tags)`",
      "Use `journal_intent(summary)`",
      "Confirm Hands tokens within 60 seconds",
      "Save specs to a canonical location",
      "Tag new KB files",
      "`whats_new` early",
    ]) {
      expect(RULES_BLOCK_BODY).toContain(phrase);
    }
    expect(RULES_BLOCK_BODY).toContain("### Core rules");
    expect(RULES_BLOCK_BODY).toContain("### Tool reference");
  });

  it("SCAFFOLDS covers every supported agent and returns a path + header", () => {
    const project = { name: "Demo", description: "x" } as any;
    for (const agent of ["claude-code", "codex", "gemini", "cursor", "continue", "generic"] as const) {
      const s = SCAFFOLDS[agent];
      expect(s).toBeTruthy();
      expect(s.path).toMatch(/.+/);
      const header = s.header(project);
      expect(typeof header).toBe("string");
    }
    expect(SCAFFOLDS["claude-code"].path).toBe("CLAUDE.md");
    expect(SCAFFOLDS.codex.path).toBe("AGENTS.md");
    expect(SCAFFOLDS.gemini.path).toBe("GEMINI.md");
    expect(SCAFFOLDS.cursor.path).toBe(".cursor/rules/kontexta.mdc");
    expect(SCAFFOLDS.continue.path).toBe(".continue/rules/kontexta.md");
    expect(SCAFFOLDS.generic.path).toBe("CLAUDE.md");
  });
});

describe("detectAgentContextFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kontexta-agent-rules-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] when no context files exist", () => {
    expect(detectAgentContextFiles(dir)).toEqual([]);
  });

  it("detects CLAUDE.md / AGENTS.md / GEMINI.md at the project root", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "");
    writeFileSync(join(dir, "AGENTS.md"), "");
    writeFileSync(join(dir, "GEMINI.md"), "");
    const found = detectAgentContextFiles(dir).sort();
    expect(found).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
  });

  it("detects .cursor/rules/*.mdc files", () => {
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "rules", "kontexta.mdc"), "");
    writeFileSync(join(dir, ".cursor", "rules", "other.mdc"), "");
    writeFileSync(join(dir, ".cursor", "rules", "ignored.txt"), "");
    const found = detectAgentContextFiles(dir).sort();
    expect(found).toEqual([".cursor/rules/kontexta.mdc", ".cursor/rules/other.mdc"]);
  });

  it("detects .continue/rules/*.md files", () => {
    mkdirSync(join(dir, ".continue", "rules"), { recursive: true });
    writeFileSync(join(dir, ".continue", "rules", "kontexta.md"), "");
    expect(detectAgentContextFiles(dir)).toEqual([".continue/rules/kontexta.md"]);
  });

  it("skips symlinked CLAUDE.md (defensive)", () => {
    const real = join(dir, "real.md");
    writeFileSync(real, "");
    symlinkSync(real, join(dir, "CLAUDE.md"));
    expect(detectAgentContextFiles(dir)).toEqual([]);
  });

  it("returns paths relative to projectPath, with forward-slash separators", () => {
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "rules", "x.mdc"), "");
    expect(detectAgentContextFiles(dir)).toEqual([".cursor/rules/x.mdc"]);
  });
});

describe("parseMarker", () => {
  it("returns null when no marker is present", () => {
    expect(parseMarker("# Just a file\n\nWith some text.\n")).toBeNull();
  });

  it("parses a valid marker pair", () => {
    const content =
      "preamble\n" +
      "<!-- BEGIN kontexta:rules v1.2.3 -->\n" +
      "body\n" +
      "<!-- END kontexta:rules v1.2.3 -->\n" +
      "trailing\n";
    const r = parseMarker(content);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("ok");
    if (r!.kind === "ok") {
      expect(r!.version).toBe("1.2.3");
      expect(content.slice(r!.beginAt, r!.endAt)).toMatch(/<!-- BEGIN kontexta:rules/);
      expect(content.slice(r!.beginAt, r!.endAt)).toMatch(/<!-- END kontexta:rules/);
    }
  });

  it("returns malformed when BEGIN has no matching END", () => {
    const content = "<!-- BEGIN kontexta:rules v1.0.0 -->\nbody only\n";
    const r = parseMarker(content);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("malformed");
  });

  it("returns duplicate when two BEGIN markers exist", () => {
    const content =
      "<!-- BEGIN kontexta:rules v1.0.0 -->\nfirst\n<!-- END kontexta:rules v1.0.0 -->\n" +
      "<!-- BEGIN kontexta:rules v1.0.0 -->\nsecond\n<!-- END kontexta:rules v1.0.0 -->\n";
    const r = parseMarker(content);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("duplicate");
  });

  it("tolerates whitespace inside the marker comment", () => {
    const content = "<!--    BEGIN   kontexta:rules    v9.3.0   -->\nx\n<!-- END kontexta:rules v9.3.0 -->\n";
    const r = parseMarker(content);
    expect(r!.kind).toBe("ok");
    if (r!.kind === "ok") expect(r!.version).toBe("9.3.0");
  });
});

describe("injectOrUpdate", () => {
  it("appends the block when no marker exists", () => {
    const out = injectOrUpdate("# Project\n\nSome notes.\n", RULES_BLOCK_BODY, RULE_BLOCK_VERSION);
    expect(out.action).toBe("updated");
    expect(out.content).toContain("# Project");
    expect(out.content).toContain("<!-- BEGIN kontexta:rules");
    expect(out.content.endsWith("\n")).toBe(true);
  });

  it("returns skipped when the marker already matches the current version", () => {
    const initial = injectOrUpdate("# x\n", RULES_BLOCK_BODY, RULE_BLOCK_VERSION).content;
    const out = injectOrUpdate(initial, RULES_BLOCK_BODY, RULE_BLOCK_VERSION);
    expect(out.action).toBe("skipped");
    expect(out.content).toBe(initial);
  });

  it("replaces the block in-place when versions differ, preserving outside text", () => {
    const oldBlock = `<!-- BEGIN kontexta:rules v0.0.1 -->\nold body\n<!-- END kontexta:rules v0.0.1 -->`;
    const initial = `# Header\n\n${oldBlock}\n\n## Trailing user section\n`;
    const out = injectOrUpdate(initial, RULES_BLOCK_BODY, RULE_BLOCK_VERSION);
    expect(out.action).toBe("updated");
    expect(out.content).toContain("# Header");
    expect(out.content).toContain("## Trailing user section");
    expect(out.content).not.toContain("old body");
    expect(out.content).toContain(`<!-- BEGIN kontexta:rules v${RULE_BLOCK_VERSION} -->`);
  });

  it("throws an InjectError on malformed marker", () => {
    const initial = `# x\n<!-- BEGIN kontexta:rules v0.0.1 -->\nno end here\n`;
    expect(() => injectOrUpdate(initial, RULES_BLOCK_BODY, RULE_BLOCK_VERSION)).toThrow(/malformed/);
  });

  it("throws an InjectError on duplicate marker", () => {
    const block = `<!-- BEGIN kontexta:rules v0.0.1 -->\nb\n<!-- END kontexta:rules v0.0.1 -->`;
    const initial = `${block}\n\n${block}\n`;
    expect(() => injectOrUpdate(initial, RULES_BLOCK_BODY, RULE_BLOCK_VERSION)).toThrow(/duplicate/);
  });

  it("inserts a single blank line between existing content and the appended block", () => {
    const out = injectOrUpdate("text without trailing newline", RULES_BLOCK_BODY, RULE_BLOCK_VERSION);
    expect(out.content).toMatch(/text without trailing newline\n\n<!-- BEGIN kontexta:rules/);
  });

  it("handles replace when block is at EOF (no trailing user content)", () => {
    const oldBlock = `<!-- BEGIN kontexta:rules v0.0.1 -->\nold body\n<!-- END kontexta:rules v0.0.1 -->\n`;
    const initial = `# Header\n\n${oldBlock}`;
    const out = injectOrUpdate(initial, RULES_BLOCK_BODY, RULE_BLOCK_VERSION);
    expect(out.action).toBe("updated");
    expect(out.content).toContain("# Header");
    expect(out.content).toContain(`<!-- END kontexta:rules v${RULE_BLOCK_VERSION} -->`);
    expect(out.content.endsWith("\n")).toBe(true);
  });

  it("matches END marker even when its version differs from BEGIN (hand-edit tolerance)", () => {
    const initial = `# x\n<!-- BEGIN kontexta:rules v0.0.1 -->\nbody\n<!-- END kontexta:rules v9.9.9 -->\n`;
    const out = injectOrUpdate(initial, RULES_BLOCK_BODY, RULE_BLOCK_VERSION);
    expect(out.action).toBe("updated");
    expect(out.content).not.toContain("v0.0.1");
    expect(out.content).not.toContain("v9.9.9");
  });
});

describe("syncAgentRules", () => {
  let dir: string;
  const project = { name: "Demo", description: "A demo project" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kontexta-sync-rules-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("update mode: injects block into an existing CLAUDE.md", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# Existing\n\nUser content.\n");
    const result = syncAgentRules({ projectPath: dir, project, files: ["CLAUDE.md"] });
    expect(result.written).toEqual([
      { path: "CLAUDE.md", action: "updated", version: RULE_BLOCK_VERSION },
    ]);
    expect(result.skipped).toEqual([]);
    const after = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(after).toContain("# Existing");
    expect(after).toContain("User content.");
    expect(after).toContain(`<!-- BEGIN kontexta:rules v${RULE_BLOCK_VERSION} -->`);
  });

  it("update mode: skipped when block already at current version", () => {
    syncAgentRules({ projectPath: dir, project, files: [], targetAgent: "claude-code" });
    const result = syncAgentRules({ projectPath: dir, project, files: ["CLAUDE.md"] });
    expect(result.written).toEqual([
      { path: "CLAUDE.md", action: "skipped", version: RULE_BLOCK_VERSION },
    ]);
  });

  it("create mode: scaffolds CLAUDE.md when targetAgent='claude-code' and no file exists", () => {
    const result = syncAgentRules({ projectPath: dir, project, files: [], targetAgent: "claude-code" });
    expect(result.written).toEqual([
      { path: "CLAUDE.md", action: "created", version: RULE_BLOCK_VERSION },
    ]);
    const content = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("# Demo");
    expect(content).toContain("A demo project");
    expect(content).toContain(`<!-- BEGIN kontexta:rules v${RULE_BLOCK_VERSION} -->`);
  });

  it("create mode: scaffolds nested .cursor/rules/kontexta.mdc with frontmatter", () => {
    const result = syncAgentRules({ projectPath: dir, project, files: [], targetAgent: "cursor" });
    expect(result.written[0].path).toBe(".cursor/rules/kontexta.mdc");
    expect(result.written[0].action).toBe("created");
    const content = readFileSync(join(dir, ".cursor/rules/kontexta.mdc"), "utf8");
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain(`<!-- BEGIN kontexta:rules v${RULE_BLOCK_VERSION} -->`);
  });

  it("update mode: refuses symlinks", () => {
    const real = join(dir, "real.md");
    writeFileSync(real, "");
    symlinkSync(real, join(dir, "CLAUDE.md"));
    const result = syncAgentRules({ projectPath: dir, project, files: ["CLAUDE.md"] });
    expect(result.written).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ path: "CLAUDE.md", reason: "symlink" });
  });

  it("update mode: refuses paths outside project root", () => {
    const result = syncAgentRules({ projectPath: dir, project, files: ["../escape.md"] });
    expect(result.written).toEqual([]);
    expect(result.skipped[0].reason).toBe("escape");
  });

  it("update mode: missing target file", () => {
    const result = syncAgentRules({ projectPath: dir, project, files: ["MISSING.md"] });
    expect(result.skipped[0]).toMatchObject({ path: "MISSING.md", reason: "missing" });
  });

  it("update mode: malformed marker is skipped, not silently 'fixed'", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "<!-- BEGIN kontexta:rules v0.0.1 -->\nno end\n");
    const result = syncAgentRules({ projectPath: dir, project, files: ["CLAUDE.md"] });
    expect(result.written).toEqual([]);
    expect(result.skipped[0].reason).toBe("malformed marker");
  });

  it("create mode: throws when targetAgent is missing AND no detected files", () => {
    expect(() => syncAgentRules({ projectPath: dir, project, files: [] })).toThrow(/targetAgent required/);
  });

  it("update mode runs when both files and targetAgent provided (targetAgent is ignored)", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# Existing\n");
    const result = syncAgentRules({
      projectPath: dir,
      project,
      files: ["CLAUDE.md"],
      targetAgent: "cursor",
    });
    expect(result.written).toEqual([
      { path: "CLAUDE.md", action: "updated", version: RULE_BLOCK_VERSION },
    ]);
    expect(existsSync(join(dir, ".cursor/rules/kontexta.mdc"))).toBe(false);
  });

  it("atomic write: leaves no .tmp.* siblings on success", () => {
    syncAgentRules({ projectPath: dir, project, files: [], targetAgent: "claude-code" });
    const entries = readdirSyncForTest(dir);
    expect(entries.filter((e: string) => e.includes(".tmp."))).toEqual([]);
  });
});

describe("rules-block.md structural integrity", () => {
  const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
  const rulesPath = join(__dirnameLocal, "..", "src", "agent-rules", "rules-block.md");
  const raw = readFileSync(rulesPath, "utf8");

  it("contains the BEGIN/END markers with {{VERSION}} placeholder", () => {
    expect(raw).toContain("<!-- BEGIN kontexta:rules v{{VERSION}} -->");
    expect(raw).toContain("<!-- END kontexta:rules v{{VERSION}} -->");
  });

  it("every routing row has exactly 4 cells", () => {
    const lines = raw.split("\n");
    const toolRowRe = /^\|\s*`([a-z_]+)`\s*\|/;
    let rowsChecked = 0;
    for (const line of lines) {
      if (!toolRowRe.test(line)) continue;
      const cells = line.split("|").slice(1, -1);
      expect(cells.length, `row "${line}" should have 4 cells`).toBe(4);
      rowsChecked++;
    }
    expect(rowsChecked, "should find at least one routing row").toBeGreaterThan(40);
  });

  it("tool names in column 1 are unique and lowercase_snake_case", () => {
    const toolRowRe = /^\|\s*`([a-z_]+)`\s*\|/;
    const seen = new Set<string>();
    for (const line of raw.split("\n")) {
      const m = line.match(toolRowRe);
      if (!m) continue;
      const name = m[1];
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(seen.has(name), `duplicate tool row: ${name}`).toBe(false);
      seen.add(name);
    }
  });

  it("every MCP tool registered in apps/mcp has a routing row", () => {
    const mcpIndexPath = join(
      __dirnameLocal,
      "..", "..", "..",
      "apps", "mcp", "src", "index.ts"
    );
    const mcpSrc = readFileSync(mcpIndexPath, "utf8");

    const toolNameRe = /server\.tool\(\s*"([a-z_][a-z0-9_]*)"/g;
    const registeredTools = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = toolNameRe.exec(mcpSrc)) !== null) {
      registeredTools.add(m[1]);
    }
    expect(registeredTools.size, "should find registered tools in apps/mcp/src/index.ts").toBeGreaterThan(0);

    const documentedTools = new Set<string>();
    const docRowRe = /^\|\s*`([a-z_][a-z0-9_]*)`\s*\|/gm;
    let dm: RegExpExecArray | null;
    while ((dm = docRowRe.exec(raw)) !== null) {
      documentedTools.add(dm[1]);
    }

    const missing = [...registeredTools].filter((t) => !documentedTools.has(t)).sort();

    // TODO(Task 18-20): Remove this allowlist once journal_note, journal_intent, distill_journal are implemented
    const pendingImplementation = new Set(["journal_note", "journal_intent", "distill_journal"]);
    const extra = [...documentedTools].filter((t) => !registeredTools.has(t) && !pendingImplementation.has(t)).sort();

    expect(missing, `Tools registered in MCP but missing routing rows: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `Routing rows present for tools not registered in MCP: ${extra.join(", ")}`).toEqual([]);
  });
});
