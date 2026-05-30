// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { DocsModal } from "./docs-modal";

afterEach(() => {
  cleanup();
});

describe("DocsModal", () => {
  it("renders four tab buttons when open", () => {
    render(<DocsModal open={true} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: /mcp server config/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /journal config/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /hands tools/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /mcp documentation/i })).toBeTruthy();
  });

  it("does not render when closed", () => {
    render(<DocsModal open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
