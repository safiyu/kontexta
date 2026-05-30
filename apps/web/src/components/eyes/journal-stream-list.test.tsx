// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { JournalStreamList, type JournalEntry } from "./journal-stream-list";

afterEach(() => cleanup());

const entries: JournalEntry[] = [
  { id: "1", timestamp: "14:02", text: "hands.run('test') · ok", live: true },
  { id: "2", timestamp: "13:58", text: "update_file_section · README.md" },
  { id: "3", timestamp: "13:51", text: "search · \"rebrand\"" },
];

describe("JournalStreamList", () => {
  it("renders every entry's text", () => {
    render(<JournalStreamList entries={entries} />);
    expect(screen.getByText(/hands.run/)).toBeTruthy();
    expect(screen.getByText(/update_file_section/)).toBeTruthy();
    expect(screen.getByText(/search/)).toBeTruthy();
  });

  it("marks the live entry with data-live='true'", () => {
    const { container } = render(<JournalStreamList entries={entries} />);
    const liveRows = container.querySelectorAll('[data-live="true"]');
    expect(liveRows.length).toBe(1);
  });

  it("renders timestamps", () => {
    render(<JournalStreamList entries={entries} />);
    expect(screen.getByText("14:02")).toBeTruthy();
    expect(screen.getByText("13:58")).toBeTruthy();
  });
});
