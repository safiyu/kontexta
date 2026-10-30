import { describe, it, expect } from "vitest";
import { mergeJournalContent } from "../../src/storage/journal-merge.js";

const day = (...entries: string[]): string => `# Journal: 2026-10-30\n\n---\n${entries.join("\n\n---\n")}\n`;
const A1 = "**2026-10-30 09:00:00** laptop note";
const B1 = "**2026-10-30 09:30:00** desktop note";
const A2 = "**2026-10-30 11:00:00** later laptop note";

describe("mergeJournalContent", () => {
  it("is the sorted union of both machines' entries", () => {
    expect(mergeJournalContent(day(A1, A2), day(B1))).toBe(day(A1, B1, A2));
  });

  it("is commutative and idempotent, so every machine converges", () => {
    const a = day(A1, A2);
    const b = day(B1);
    const m = mergeJournalContent(a, b);
    expect(mergeJournalContent(b, a)).toBe(m);
    expect(mergeJournalContent(m, a)).toBe(m);
    expect(mergeJournalContent(m, b)).toBe(m);
    expect(mergeJournalContent(m, m)).toBe(m);
  });

  it("keeps duplicate entries once and ignores trailing whitespace differences", () => {
    expect(mergeJournalContent(day(A1), `${day(A1)}\n\n`)).toBe(day(A1));
  });

  it("matches the append format used by journal_write", () => {
    const first = "# Journal: 2026-10-30\n\n---\n**2026-10-30 09:00:00** a\n";
    const appended = `${first}\n---\n**2026-10-30 10:00:00** b\n`;
    expect(mergeJournalContent(first, appended)).toBe(appended);
  });

  it("copes with an empty or header-only file", () => {
    expect(mergeJournalContent("", day(A1))).toBe(mergeJournalContent(day(A1), ""));
    expect(mergeJournalContent("# Journal: 2026-10-30\n", "# Journal: 2026-10-30\n")).toBe("# Journal: 2026-10-30\n");
  });
});
