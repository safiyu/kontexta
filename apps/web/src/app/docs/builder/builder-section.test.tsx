// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BuilderSection } from "./builder-section";

afterEach(() => cleanup());

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const TOOLS_INITIAL: Record<string, any> = {
  "run-tests": { description: "run", command: ["npx", "vitest"] },
};

function makeFetchMock(initial: Record<string, any>, validation: { errors: string[]; warnings: string[] } = { errors: [], warnings: [] }) {
  let saved = initial;
  return vi.fn(async (url: string, init?: any) => {
    if (url.includes("/api/projects") && url.endsWith("/hands-config")) {
      if (!init || init.method === "GET" || !init.method) {
        return {
          ok: true,
          json: async () => ({
            exists: true,
            raw: JSON.stringify({ version: "1", tools: saved }),
            parsed: { version: "1", tools: saved },
            mtimeMs: 100,
          }),
        };
      }
      const body = JSON.parse(init.body);
      saved = body.config.tools;
      return { ok: true, json: async () => ({ mtimeMs: 200 }) };
    }
    if (url.endsWith("/api/projects")) {
      return { ok: true, json: async () => [{ id: 1, name: "demo", path: "/tmp/demo" }] };
    }
    if (url.includes("/api/hands/validate")) {
      return { ok: true, json: async () => ({ found: true, tools: saved, disabled: [], ...validation }) };
    }
    return { ok: true, json: async () => ({}) };
  }) as any;
}

beforeEach(() => {
  global.fetch = makeFetchMock(TOOLS_INITIAL);
});

describe("BuilderSection", () => {
  it("loads existing tools and renders one row each", async () => {
    render(<BuilderSection />);
    await waitFor(() => expect(screen.getByText("run-tests")).toBeTruthy());
  });

  it("delete removes row", async () => {
    render(<BuilderSection />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^edit$/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    // Confirm via the modal that replaced window.confirm.
    await waitFor(() => expect(screen.getByRole("dialog", { name: /confirm delete tool/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^delete tool$/i }));
    // After delete, the row's Edit button is gone (the empty-state TemplateGallery has no Edit button).
    await waitFor(() => expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull());
  });

  it("renders the template gallery in empty state", async () => {
    global.fetch = makeFetchMock({});
    render(<BuilderSection />);
    await waitFor(() => expect(screen.getByText("list-files")).toBeTruthy());
    expect(screen.getByText("run-tests")).toBeTruthy();
    expect(screen.getByText("deploy-staging")).toBeTruthy();
    expect(screen.getByText("remove-temp")).toBeTruthy();
    expect(screen.getByRole("button", { name: /start from scratch/i })).toBeTruthy();
  });

  it("save bar shows count after editing then disappears after save", async () => {
    render(<BuilderSection />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^edit$/i })).toBeTruthy());

    // Trigger a change by deleting the row — confirm via modal.
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: /confirm delete tool/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^delete tool$/i }));
    await waitFor(() => expect(screen.getByText("1 unsaved change")).toBeTruthy());

    // Click Save in the bar.
    // SaveBar's button is now just "Save"; modal also has a "Save" — but modal isn't open here.
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    // After PUT resolves, the snapshot refreshes and the bar slides out (count → 0).
    // SaveBar holds a 2s "Saved ✓" status before going hidden, so the wait must exceed that.
    await waitFor(() => {
      const bar = screen.getByRole("region", { name: /unsaved changes/i });
      expect(bar.className).toMatch(/translate-y-full/);
    }, { timeout: 3000 });
  });

  it("Save in modal stays enabled when adding a SECOND tool via template-then-add (real flow)", async () => {
    global.fetch = makeFetchMock({});
    render(<BuilderSection />);
    // Empty state — gallery shown. Click a template (most common first-tool flow).
    await waitFor(() => expect(screen.getByText("list-files")).toBeTruthy());
    fireEvent.click(screen.getByText("list-files"));
    // Wait for modal to open and click Save
    await waitFor(() => expect(screen.getByRole("heading", { name: /(add|edit) tool/i })).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: /^save$/i })[0]);

    // Wait for first row to appear and gallery to disappear.
    // list-files is in the gallery, so wait for something unique like the "+ Add tool" button.
    await waitFor(() => expect(screen.getByRole("button", { name: /\+ add tool/i })).toBeTruthy());

    // Click "+ Add tool" for the second tool
    fireEvent.click(screen.getByRole("button", { name: /\+ add tool/i }));

    // Fill second tool from scratch
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "second" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "second desc" } });
    const argvInput = screen.getAllByPlaceholderText(/\+ arg/)[0];
    fireEvent.change(argvInput, { target: { value: "echo" } });
    fireEvent.keyDown(argvInput, { key: "Enter" });

    // Both modal Save and SaveBar Save are named "Save" — pick the modal's (first in DOM).
    const saveBtn = screen.getAllByRole("button", { name: /^save$/i })[0];
    expect(saveBtn.hasAttribute("disabled")).toBe(false);
  });

  it("Save in modal stays enabled when adding a SECOND tool via blank-then-add", async () => {
    global.fetch = makeFetchMock({});
    render(<BuilderSection />);
    await waitFor(() => expect(screen.getByRole("button", { name: /start from scratch/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /start from scratch/i }));

    // Fill first tool
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "first" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "first desc" } });
    let argvInput = screen.getAllByPlaceholderText(/\+ arg/)[0];
    fireEvent.change(argvInput, { target: { value: "echo" } });
    fireEvent.keyDown(argvInput, { key: "Enter" });
    fireEvent.click(screen.getAllByRole("button", { name: /^save$/i })[0]);

    // Wait for first row to appear
    await waitFor(() => expect(screen.getByText("first")).toBeTruthy());

    // Click "+ Add tool" to open modal again for second tool
    fireEvent.click(screen.getByRole("button", { name: /\+ add tool/i }));

    // Fill second tool
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "second" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "second desc" } });
    argvInput = screen.getAllByPlaceholderText(/\+ arg/)[0];
    fireEvent.change(argvInput, { target: { value: "echo" } });
    fireEvent.keyDown(argvInput, { key: "Enter" });

    // Both modal Save and SaveBar Save are named "Save" — pick the modal's (first in DOM).
    const saveBtn = screen.getAllByRole("button", { name: /^save$/i })[0];
    expect(saveBtn.hasAttribute("disabled")).toBe(false);
  });

  it("Delete kontexta.json clears tools and removes the delete button", async () => {
    // Custom fetch mock that handles DELETE
    let exists = true;
    global.fetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes("/api/projects") && url.endsWith("/hands-config")) {
        if (init?.method === "DELETE") {
          exists = false;
          return { ok: true, json: async () => ({ deleted: true }) };
        }
        if (!init || init.method === "GET" || !init.method) {
          return {
            ok: true,
            json: async () => exists
              ? { exists: true, raw: JSON.stringify({ version: "1", tools: TOOLS_INITIAL }), parsed: { version: "1", tools: TOOLS_INITIAL }, mtimeMs: 100 }
              : { exists: false, raw: null, parsed: null, mtimeMs: null },
          };
        }
      }
      if (url.endsWith("/api/projects")) {
        return { ok: true, json: async () => [{ id: 1, name: "demo", path: "/tmp/demo" }] };
      }
      if (url.includes("/api/hands/validate")) {
        return { ok: true, json: async () => ({ found: true, tools: {}, disabled: [], warnings: [], errors: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as any;

    render(<BuilderSection />);
    // Wait for tool row + delete button (both depend on the async load completing)
    await waitFor(() => expect(screen.getByText("run-tests")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: /delete kontexta\.json/i })).toBeTruthy());

    // First click opens the confirm modal
    fireEvent.click(screen.getByRole("button", { name: /delete kontexta\.json/i }));
    // Modal renders
    await waitFor(() => expect(screen.getByRole("dialog", { name: /confirm delete kontexta\.json/i })).toBeTruthy());
    // Click the modal's Delete button (the trigger one is now also still in DOM; modal Delete is the last)
    const deleteButtons = screen.getAllByRole("button", { name: /delete kontexta\.json/i });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    // After delete: tools cleared, delete trigger gone, gallery shown
    await waitFor(() => expect(screen.queryByRole("button", { name: /delete kontexta\.json/i })).toBeNull());
    expect(screen.getByText("list-files")).toBeTruthy(); // gallery template
  });

  it("surfaces per-tool errors from validation.errors[] (not just warnings)", async () => {
    global.fetch = makeFetchMock(TOOLS_INITIAL, {
      errors: ["tool 'run-tests' rejected: argv[0] must be literal"],
      warnings: [],
    });
    render(<BuilderSection />);
    await waitFor(() =>
      expect(screen.getByText(/argv\[0\] must be literal/)).toBeTruthy(),
    );
  });
});
