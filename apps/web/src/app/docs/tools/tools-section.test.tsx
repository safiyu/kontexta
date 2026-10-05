// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ToolsSection } from "./tools-section";

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      categoryOrder: ["Read", "Write"],
      tools: [
        { name: "files_read", description: "Read one file by ID.", inputSchema: { type: "object", properties: {} }, category: "Read" },
        { name: "files_create", description: "Create a new markdown file.", inputSchema: { type: "object", properties: {} }, category: "Write" },
      ],
    }),
  })) as any;
});

afterEach(() => {
  cleanup();
});

describe("ToolsSection", () => {
  it("renders tools grouped by category after fetch", async () => {
    render(<ToolsSection />);
    await waitFor(() => expect(screen.getByText("files_read")).toBeTruthy());
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByText("Write")).toBeTruthy();
  });
  it("filters by search input", async () => {
    render(<ToolsSection />);
    await waitFor(() => expect(screen.getByText("files_read")).toBeTruthy());
    const input = screen.getByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: "create" } });
    expect(screen.queryByText("files_read")).toBeNull();
    expect(screen.getByText("files_create")).toBeTruthy();
  });
});
