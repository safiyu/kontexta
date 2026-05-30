// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import DocsPage from "./page";

afterEach(() => {
  cleanup();
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=install"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

describe("DocsPage", () => {
  it("renders three tab buttons", () => {
    render(<DocsPage />);
    expect(screen.getByRole("tab", { name: /mcp tools doc/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /mcp server config/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /hand tools config/i })).toBeTruthy();
  });

  it("activates the tab from ?tab= query param", () => {
    render(<DocsPage />);
    const installTab = screen.getByRole("tab", { name: /mcp server config/i });
    expect(installTab.getAttribute("aria-selected")).toBe("true");
  });
});
