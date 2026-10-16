// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { TopBar } from "./top-bar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: "dark",
    setTheme: vi.fn(),
  }),
}));

const defaultProps = {
  onSearch: vi.fn(),
  onAbout: vi.fn(),
  onConfigure: vi.fn(),
  onPublish: vi.fn(),
  onViewPublished: vi.fn(),
};

describe("TopBar unresolved conflict badge", () => {
  beforeEach(() => {
    mockPush.mockReset();
  });

  it("does not render conflict badge when unresolvedConflicts is 0", () => {
    render(<TopBar {...defaultProps} unresolvedConflicts={0} />);

    expect(screen.queryByTestId("unresolved-conflicts-badge")).toBeNull();
    expect(screen.queryByText("Conflicts")).toBeNull();
  });

  it("renders conflict badge when unresolvedConflicts prop is greater than 0", () => {
    render(<TopBar {...defaultProps} unresolvedConflicts={3} />);

    const badge = screen.getByTestId("unresolved-conflicts-badge");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("href")).toBe("/conflicts");
    expect(screen.getByText("Conflicts")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(badge.getAttribute("aria-label")).toBe("3 unresolved conflicts");
  });

  it("fetches unresolved count from /api/conflicts when prop is undefined", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unresolved: 2, count: 2, conflicts: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TopBar {...defaultProps} />);

    // Initially 0 so badge is not visible before fetch completes
    expect(screen.queryByTestId("unresolved-conflicts-badge")).toBeNull();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/conflicts?status=unresolved"),
        expect.any(Object)
      );
    });

    await waitFor(() => {
      const badge = screen.getByTestId("unresolved-conflicts-badge");
      expect(badge).toBeTruthy();
      expect(badge.getAttribute("href")).toBe("/conflicts");
      expect(screen.getByText("Conflicts")).toBeTruthy();
      expect(screen.getByText("2")).toBeTruthy();
    });
  });

  it("navigates to /conflicts when clicked", () => {
    render(<TopBar {...defaultProps} unresolvedConflicts={1} />);

    const badge = screen.getByTestId("unresolved-conflicts-badge");
    fireEvent.click(badge);

    expect(mockPush).toHaveBeenCalledWith("/conflicts");
  });

  it("refreshes unresolved count on kontexta:conflicts-changed event", async () => {
    let unresolvedValue = 1;
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ unresolved: unresolvedValue, count: unresolvedValue, conflicts: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TopBar {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("1")).toBeTruthy();
    });

    // Update count and dispatch change event
    unresolvedValue = 4;
    window.dispatchEvent(new Event("kontexta:conflicts-changed"));

    await waitFor(() => {
      expect(screen.getByText("4")).toBeTruthy();
    });
  });
});
