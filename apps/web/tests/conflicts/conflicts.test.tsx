// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ConflictsClient } from "@/app/conflicts/conflicts-client";
import { ConflictList } from "@/components/conflicts/conflict-list";
import { ConflictDiff, parseDiff } from "@/components/conflicts/conflict-diff";
import { ResolveActions, STRATEGY_META } from "@/components/conflicts/resolve-actions";
import type { ConflictRecord, ConflictStrategy } from "kxta-core";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  usePathname: () => "/conflicts",
}));

const mockToast = {
  success: vi.fn(),
  error: vi.fn(),
};
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}));

const mockConflict1: ConflictRecord = {
  gid: "1@clientA",
  file_path: "notes/spec.md",
  origin: "client-beta",
  origin_label: "Laptop Beta",
  status: "unresolved",
  base_version: 1,
  server_seq: 10,
  local_content: "# Spec\nLocal version\nLine 2\n",
  remote_content: "# Spec\nRemote version\nLine 2\n",
  diff: "--- notes/spec.md (local)\n+++ notes/spec.md (remote)\n@@ -1,3 +1,3 @@\n # Spec\n-Local version\n+Remote version\n Line 2",
  additions: 1,
  deletions: 1,
  created_at: Date.now() - 60000,
};

const mockConflict2: ConflictRecord = {
  gid: "2@clientA",
  file_path: "todo.txt",
  origin: "client-gamma",
  origin_label: "Desktop Gamma",
  status: "unresolved",
  base_version: 2,
  server_seq: 15,
  local_content: "Buy milk\n",
  remote_content: "Buy milk\nBuy eggs\n",
  diff: "--- todo.txt\n+++ todo.txt\n@@ -1 +1,2 @@\n Buy milk\n+Buy eggs",
  additions: 1,
  deletions: 0,
  created_at: Date.now() - 120000,
};

const mockResolvedConflict: ConflictRecord = {
  gid: "3@clientA",
  file_path: "done.md",
  origin: "client-delta",
  origin_label: "Server Delta",
  status: "resolved",
  resolution: "keep-mine",
  resolved_at: Date.now() - 30000,
  base_version: 1,
  server_seq: 5,
  local_content: "Done\n",
  remote_content: "Done!\n",
  diff: "",
  additions: 0,
  deletions: 0,
  created_at: Date.now() - 300000,
};

describe("Conflict Manager Workflows (conflicts.test.tsx)", () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockToast.success.mockReset();
    mockToast.error.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("ConflictsClient — End-to-End Conflict Workflows", () => {
    it("renders empty state when there are no unresolved conflicts", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/api/conflicts")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ conflicts: [], unresolved: 0 }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(screen.getByText("No open conflicts")).toBeTruthy();
        expect(screen.getByText("0 open")).toBeTruthy();
        expect(screen.getByText("Select a conflict")).toBeTruthy();
      });
    });

    it("loads conflicts list and auto-selects the first conflict", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/api/conflicts")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              conflicts: [mockConflict1, mockConflict2],
              unresolved: 2,
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(screen.getByText("2 open")).toBeTruthy();
        expect(screen.getAllByText("notes/spec.md").length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText("todo.txt")).toBeTruthy();
      });

      // Auto-selected detail header
      await waitFor(() => {
        const headings = screen.getAllByText("notes/spec.md");
        expect(headings.length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("Laptop Beta").length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText("1 added / 1 removed")).toBeTruthy();
        expect(screen.getByText("base v1")).toBeTruthy();
        expect(screen.getByText("server #10")).toBeTruthy();
      });

      // Unified diff content is displayed
      expect(screen.getByText("+ Remote version")).toBeTruthy();
      expect(screen.getByText("- Local version")).toBeTruthy();

      // Merged content editor is initialized with local content
      const textarea = screen.getByLabelText("Merged content") as HTMLTextAreaElement;
      expect(textarea.value).toBe(mockConflict1.local_content);
    });

    it("switches selected conflict when a user clicks another conflict in list", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/api/conflicts")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              conflicts: [mockConflict1, mockConflict2],
              unresolved: 2,
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(screen.getByText("todo.txt")).toBeTruthy();
      });

      // Click on todo.txt in sidebar
      fireEvent.click(screen.getByText("todo.txt"));

      await waitFor(() => {
        expect(screen.getAllByText("Desktop Gamma").length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText("1 added / 0 removed")).toBeTruthy();
        expect(screen.getByText("base v2")).toBeTruthy();
        expect(screen.getByText("server #15")).toBeTruthy();
      });

      const textarea = screen.getByLabelText("Merged content") as HTMLTextAreaElement;
      expect(textarea.value).toBe(mockConflict2.local_content);
    });

    it("switches filter between 'unresolved' and 'all'", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("status=all")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              conflicts: [mockConflict1, mockConflict2, mockResolvedConflict],
              unresolved: 2,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conflicts: [mockConflict1, mockConflict2],
            unresolved: 2,
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(screen.getAllByText("notes/spec.md").length).toBeGreaterThanOrEqual(1);
        expect(screen.queryByText("done.md")).toBeNull();
      });

      // Click "all" filter
      const allFilterBtn = screen.getByRole("button", { name: /^all$/i });
      fireEvent.click(allFilterBtn);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("status=all"),
          expect.any(Object)
        );
        expect(screen.getByText("done.md")).toBeTruthy();
      });
    });

    it("toggles between unified and side-by-side diff views", async () => {
      const fetchMock = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          conflicts: [mockConflict1],
          unresolved: 1,
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(screen.getByText("+ Remote version")).toBeTruthy();
      });

      // Click Side by side button
      const splitBtn = screen.getByRole("button", { name: "Side by side" });
      fireEvent.click(splitBtn);

      await waitFor(() => {
        expect(screen.getAllByText("Remote (Laptop Beta)").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("Local (this machine)").length).toBeGreaterThanOrEqual(1);
      });

      // Toggle back to Unified
      const unifiedBtn = screen.getByRole("button", { name: "Unified" });
      fireEvent.click(unifiedBtn);

      await waitFor(() => {
        expect(screen.getByText("+ Remote version")).toBeTruthy();
      });
    });

    it("executes 'keep-server' resolution workflow with confirmation dialog", async () => {
      const conflictsEventSpy = vi.fn();
      window.addEventListener("kontexta:conflicts-changed", conflictsEventSpy);

      let conflictsState = [mockConflict1];
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          conflictsState = [];
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, strategy: "keep-server" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conflicts: conflictsState,
            unresolved: conflictsState.length,
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(screen.getByTestId("strategy-keep-server")).toBeTruthy();
      });

      // 1. Click keep-server
      fireEvent.click(screen.getByTestId("strategy-keep-server"));

      // Confirmation dialog opens
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getAllByText("Keep the server version?").length).toBeGreaterThanOrEqual(1);

      // 2. Test cancel: click cancel button
      const cancelBtn = within(dialog).getByRole("button", { name: "Cancel" });
      fireEvent.click(cancelBtn);

      // Dialog closes, no POST was executed
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/conflicts/1%40clientA"),
        expect.objectContaining({ method: "POST" })
      );

      // 3. Click keep-server again and confirm
      fireEvent.click(screen.getByTestId("strategy-keep-server"));
      const dialogAgain = await screen.findByRole("dialog");
      const confirmBtn = within(dialogAgain).getByRole("button", { name: "Keep server" });
      fireEvent.click(confirmBtn);

      // Verify POST call
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/conflicts/1%40clientA"),
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ strategy: "keep-server" }),
          })
        );
      });

      // Verify toast, event dispatch, and UI refresh
      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith("Conflict resolved (keep-server)");
        expect(conflictsEventSpy).toHaveBeenCalled();
        expect(screen.getByText("No open conflicts")).toBeTruthy();
      });

      window.removeEventListener("kontexta:conflicts-changed", conflictsEventSpy);
    });

    it("executes 'keep-mine' resolution workflow directly", async () => {
      const conflictsEventSpy = vi.fn();
      window.addEventListener("kontexta:conflicts-changed", conflictsEventSpy);

      let conflictsState = [mockConflict1];
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          conflictsState = [];
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, strategy: "keep-mine" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conflicts: conflictsState,
            unresolved: conflictsState.length,
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(screen.getByTestId("strategy-keep-mine")).toBeTruthy();
      });

      // Click keep-mine
      fireEvent.click(screen.getByTestId("strategy-keep-mine"));

      // Verify POST call was executed without confirmation dialog
      expect(screen.queryByRole("dialog")).toBeNull();

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/conflicts/1%40clientA"),
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ strategy: "keep-mine" }),
          })
        );
        expect(mockToast.success).toHaveBeenCalledWith("Conflict resolved (keep-mine)");
        expect(conflictsEventSpy).toHaveBeenCalled();
      });

      window.removeEventListener("kontexta:conflicts-changed", conflictsEventSpy);
    });

    it("executes 'keep-both' resolution workflow directly", async () => {
      const conflictsEventSpy = vi.fn();
      window.addEventListener("kontexta:conflicts-changed", conflictsEventSpy);

      let conflictsState = [mockConflict1];
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          conflictsState = [];
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, strategy: "keep-both" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conflicts: conflictsState,
            unresolved: conflictsState.length,
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(screen.getByTestId("strategy-keep-both")).toBeTruthy();
      });

      // Click keep-both
      fireEvent.click(screen.getByTestId("strategy-keep-both"));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/conflicts/1%40clientA"),
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ strategy: "keep-both" }),
          })
        );
        expect(mockToast.success).toHaveBeenCalledWith("Conflict resolved (keep-both)");
        expect(conflictsEventSpy).toHaveBeenCalled();
      });

      window.removeEventListener("kontexta:conflicts-changed", conflictsEventSpy);
    });

    it("executes 'merged' workflow with editor, reset helpers, and apply button", async () => {
      const conflictsEventSpy = vi.fn();
      window.addEventListener("kontexta:conflicts-changed", conflictsEventSpy);

      let conflictsState = [mockConflict1];
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          conflictsState = [];
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, strategy: "merged" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conflicts: conflictsState,
            unresolved: conflictsState.length,
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      const textarea = (await screen.findByLabelText("Merged content")) as HTMLTextAreaElement;
      expect(textarea.value).toBe(mockConflict1.local_content);

      // Test "Use remote" button
      const useRemoteBtn = screen.getByRole("button", { name: /use remote/i });
      fireEvent.click(useRemoteBtn);
      expect(textarea.value).toBe(mockConflict1.remote_content);

      // Test "Use local" button
      const useLocalBtn = screen.getByRole("button", { name: /use local/i });
      fireEvent.click(useLocalBtn);
      expect(textarea.value).toBe(mockConflict1.local_content);

      // Manually edit the merged text
      const customMergedText = "# Spec\nResolved Manually\n";
      fireEvent.change(textarea, { target: { value: customMergedText } });
      expect(textarea.value).toBe(customMergedText);

      // Click "Apply merged & resolve" button
      const applyBtn = screen.getByTestId("apply-merged-button");
      fireEvent.click(applyBtn);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/conflicts/1%40clientA"),
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              strategy: "merged",
              mergedContent: customMergedText,
            }),
          })
        );
        expect(mockToast.success).toHaveBeenCalledWith("Conflict resolved (merged)");
        expect(conflictsEventSpy).toHaveBeenCalled();
      });

      window.removeEventListener("kontexta:conflicts-changed", conflictsEventSpy);
    });

    it("triggers merged resolution when clicking the strategy-merged toolbar button", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, strategy: "merged" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conflicts: [mockConflict1],
            unresolved: 1,
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      const textarea = (await screen.findByLabelText("Merged content")) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Edited via toolbar" } });

      const strategyMergedBtn = screen.getByTestId("strategy-merged");
      fireEvent.click(strategyMergedBtn);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/conflicts/1%40clientA"),
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              strategy: "merged",
              mergedContent: "Edited via toolbar",
            }),
          })
        );
      });
    });

    it("handles resolve API failure gracefully with error toast", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: "Conflict copy missing on disk" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conflicts: [mockConflict1],
            unresolved: 1,
          }),
        };
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(screen.getByTestId("strategy-keep-mine")).toBeTruthy();
      });

      fireEvent.click(screen.getByTestId("strategy-keep-mine"));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("Conflict copy missing on disk");
      });

      // App stays functional and conflict is still selected
      expect(screen.getAllByText("Laptop Beta").length).toBeGreaterThanOrEqual(1);
    });

    it("handles fetch failure on initial load gracefully", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Internal server error" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("Failed to load conflicts (500)");
      });
    });

    it("navigates back to home on breadcrumb or close button click", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ conflicts: [], unresolved: 0 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<ConflictsClient />);

      // Click "Home" in breadcrumb
      const homeLink = screen.getByText("Home");
      fireEvent.click(homeLink);
      expect(mockPush).toHaveBeenCalledWith("/");

      mockPush.mockReset();

      // Click "Close" X button in header
      const closeBtn = screen.getByRole("button", { name: /close conflict manager/i });
      fireEvent.click(closeBtn);
      expect(mockPush).toHaveBeenCalledWith("/");
    });
  });

  describe("ResolveActions — Standalone Component Tests", () => {
    it("renders all 4 strategy buttons with correct hints and accessible labels", () => {
      const onResolve = vi.fn();
      render(<ResolveActions conflict={mockConflict1} onResolve={onResolve} />);

      const strategies: ConflictStrategy[] = ["keep-server", "keep-mine", "keep-both", "merged"];
      strategies.forEach((s) => {
        const btn = screen.getByTestId(`strategy-${s}`);
        expect(btn).toBeTruthy();
        expect(btn.getAttribute("aria-label")).toBe(STRATEGY_META[s].label);
      });

      // Hover over keep-both to update hint text
      fireEvent.mouseEnter(screen.getByTestId("strategy-keep-both"));
      expect(screen.getByTestId("strategy-hint").textContent).toBe(STRATEGY_META["keep-both"].hint);

      fireEvent.mouseLeave(screen.getByTestId("strategy-keep-both"));
      expect(screen.getByTestId("strategy-hint").textContent).toBe(STRATEGY_META["keep-server"].hint);
    });

    it("renders resolved banner when conflict status is resolved", () => {
      render(<ResolveActions conflict={mockResolvedConflict} onResolve={vi.fn()} />);

      expect(screen.getByTestId("resolved-status")).toBeTruthy();
      expect(screen.getByText("Resolved")).toBeTruthy();
      expect(screen.getByText("keep-mine")).toBeTruthy();
      expect(screen.queryByRole("toolbar")).toBeNull();
      expect(screen.queryByLabelText("Merged content")).toBeNull();
    });

    it("shows loading label and disables buttons when busy", () => {
      render(
        <ResolveActions
          conflict={mockConflict1}
          onResolve={vi.fn()}
          busy="keep-mine"
        />
      );

      const keepMineBtn = screen.getByTestId("strategy-keep-mine");
      expect(keepMineBtn.textContent).toContain("Keeping mine…");
      expect(keepMineBtn.hasAttribute("disabled")).toBe(true);

      const keepServerBtn = screen.getByTestId("strategy-keep-server");
      expect(keepServerBtn.hasAttribute("disabled")).toBe(true);

      const textarea = screen.getByLabelText("Merged content");
      expect(textarea.hasAttribute("disabled")).toBe(true);
    });

    it("invokes controlled callbacks onMergedText and onApplyMerged when provided", () => {
      const onMergedText = vi.fn();
      const onApplyMerged = vi.fn();
      render(
        <ResolveActions
          conflict={mockConflict1}
          onResolve={vi.fn()}
          mergedText="controlled text"
          onMergedText={onMergedText}
          onApplyMerged={onApplyMerged}
        />
      );

      const textarea = screen.getByLabelText("Merged content") as HTMLTextAreaElement;
      expect(textarea.value).toBe("controlled text");

      fireEvent.change(textarea, { target: { value: "new text" } });
      expect(onMergedText).toHaveBeenCalledWith("new text");

      fireEvent.click(screen.getByTestId("apply-merged-button"));
      expect(onApplyMerged).toHaveBeenCalled();
    });
  });

  describe("ConflictDiff & parseDiff — Standalone Tests", () => {
    it("parseDiff decomposes diff output into typed line segments", () => {
      const diffStr =
        "--- file.txt\n+++ file.txt\n@@ -1,2 +1,2 @@\n context\n-removed\n+added\n";
      const parsed = parseDiff(diffStr);

      expect(parsed).toEqual([
        { type: "header", text: "--- file.txt" },
        { type: "header", text: "+++ file.txt" },
        { type: "hunk", text: "@@ -1,2 +1,2 @@" },
        { type: "ctx", text: "context" },
        { type: "del", text: "removed" },
        { type: "add", text: "added" },
        { type: "blank", text: "" },
      ]);
    });

    it("returns empty array when diff is empty or undefined", () => {
      expect(parseDiff(undefined)).toEqual([]);
      expect(parseDiff("")).toEqual([]);
    });

    it("renders 'No differences' fallback when diff has no lines", () => {
      render(
        <ConflictDiff
          conflict={{ ...mockConflict1, diff: "" }}
          diffView="unified"
          onDiffView={vi.fn()}
        />
      );

      expect(screen.getByText("No differences")).toBeTruthy();
    });

    it("triggers onDiffView when switching view modes", () => {
      const onDiffView = vi.fn();
      render(
        <ConflictDiff
          conflict={mockConflict1}
          diffView="unified"
          onDiffView={onDiffView}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
      expect(onDiffView).toHaveBeenCalledWith("split");

      fireEvent.click(screen.getByRole("button", { name: "Unified" }));
      expect(onDiffView).toHaveBeenCalledWith("unified");
    });
  });

  describe("ConflictList — Standalone Tests", () => {
    it("renders loading empty state when loading=true", () => {
      render(
        <ConflictList
          conflicts={[]}
          selectedGid={null}
          onSelect={vi.fn()}
          loading={true}
          unresolvedCount={0}
          emptyTitle="No open conflicts"
        />
      );

      expect(screen.getByText("Loading conflicts…")).toBeTruthy();
    });

    it("renders empty message when no conflicts exist", () => {
      render(
        <ConflictList
          conflicts={[]}
          selectedGid={null}
          onSelect={vi.fn()}
          loading={false}
          unresolvedCount={0}
          emptyTitle="No conflicts found"
          emptyHint="Everything is synchronized."
        />
      );

      expect(screen.getByText("No conflicts found")).toBeTruthy();
      expect(screen.getByText("Everything is synchronized.")).toBeTruthy();
    });

    it("highlights selected item and calls onSelect callback", () => {
      const onSelect = vi.fn();
      render(
        <ConflictList
          conflicts={[mockConflict1, mockConflict2]}
          selectedGid="1@clientA"
          onSelect={onSelect}
          loading={false}
          unresolvedCount={2}
          emptyTitle="No open conflicts"
        />
      );

      expect(screen.getByText("notes/spec.md")).toBeTruthy();
      expect(screen.getByText("todo.txt")).toBeTruthy();

      fireEvent.click(screen.getByText("todo.txt"));
      expect(onSelect).toHaveBeenCalledWith(mockConflict2);
    });
  });
});
