// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { IconRail, type IconRailItem } from "./icon-rail";

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
  usePathname: () => "/",
}));

const mockItems: IconRailItem[] = [
  { id: "p-1", label: "Project Alpha", active: true, onClick: vi.fn() },
  { id: "p-2", label: "Project Beta", active: false, onClick: vi.fn() },
];

const mockFooter: IconRailItem = {
  id: "kb",
  label: "Knowledge Base",
  active: false,
  onClick: vi.fn(),
};

describe("IconRail navigation and Conflict Manager", () => {
  beforeEach(() => {
    mockPush.mockReset();
  });

  it("renders primary items and Knowledge Base footer", () => {
    render(<IconRail items={mockItems} footer={mockFooter} conflictsItem={null} />);

    expect(screen.getByTestId("rail-button-p-1")).toBeTruthy();
    expect(screen.getByTestId("rail-button-p-2")).toBeTruthy();
    expect(screen.getByTestId("rail-button-kb")).toBeTruthy();
    expect(screen.getAllByText("P").length).toBe(2);
    expect(screen.queryByTestId("rail-button-conflicts")).toBeNull();
  });

  it("renders default Conflict Manager navigation item pointing to /conflicts", () => {
    render(<IconRail items={mockItems} footer={mockFooter} unresolvedConflicts={0} />);

    const conflictsBtn = screen.getByTestId("rail-button-conflicts");
    expect(conflictsBtn).toBeTruthy();
    expect(conflictsBtn.getAttribute("aria-label")).toBe("Conflict Manager");
    expect(conflictsBtn.getAttribute("title")).toBe("Conflict Manager");

    fireEvent.click(conflictsBtn);
    expect(mockPush).toHaveBeenCalledWith("/conflicts");
  });

  it("renders a Brain navigation item pointing to /brain", () => {
    render(<IconRail items={mockItems} footer={mockFooter} unresolvedConflicts={0} />);

    const brainBtn = screen.getByTestId("rail-button-brain");
    expect(brainBtn.getAttribute("aria-label")).toBe("Brain");

    fireEvent.click(brainBtn);
    expect(mockPush).toHaveBeenCalledWith("/brain");
  });

  it("renders unresolved conflicts badge when count > 0", () => {
    render(<IconRail items={mockItems} footer={mockFooter} unresolvedConflicts={3} />);

    const badge = screen.getByTestId("rail-badge-conflicts");
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe("3");
    expect(screen.getByTestId("rail-button-conflicts").getAttribute("title")).toBe("Conflict Manager (3 unresolved)");
  });

  it("fetches unresolved count from /api/conflicts when count is not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unresolved: 5, conflicts: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<IconRail items={mockItems} footer={mockFooter} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/conflicts?status=unresolved"),
        expect.any(Object)
      );
    });

    await waitFor(() => {
      const badge = screen.getByTestId("rail-badge-conflicts");
      expect(badge).toBeTruthy();
      expect(badge.textContent).toBe("5");
    });
  });

  it("refreshes unresolved count on kontexta:conflicts-changed event", async () => {
    let unresolvedValue = 1;
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ unresolved: unresolvedValue, count: unresolvedValue }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<IconRail items={mockItems} footer={mockFooter} />);

    await waitFor(() => {
      expect(screen.getByTestId("rail-badge-conflicts").textContent).toBe("1");
    });

    unresolvedValue = 4;
    window.dispatchEvent(new Event("kontexta:conflicts-changed"));

    await waitFor(() => {
      expect(screen.getByTestId("rail-badge-conflicts").textContent).toBe("4");
    });
  });

  it("allows overriding conflictsItem with custom item", () => {
    const customOnClick = vi.fn();
    const customConflicts: IconRailItem = {
      id: "conflicts",
      label: "Custom Conflicts",
      active: true,
      onClick: customOnClick,
    };

    render(<IconRail items={mockItems} footer={mockFooter} conflictsItem={customConflicts} />);

    const btn = screen.getByTestId("rail-button-conflicts");
    expect(btn.getAttribute("aria-label")).toBe("Custom Conflicts");

    fireEvent.click(btn);
    expect(customOnClick).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
