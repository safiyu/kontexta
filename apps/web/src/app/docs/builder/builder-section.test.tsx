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
  "run-tests": { description: "run tests", command: ["npx", "vitest"] },
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
  it("loads existing tools and renders them in the Registry sidebar", async () => {
    render(<BuilderSection />);
    await waitFor(() => expect(screen.getByText("run-tests")).toBeTruthy());
  });

  it("delete stages removal and removes the tool from Registry", async () => {
    render(<BuilderSection />);
    await waitFor(() => expect(screen.getByText("run-tests")).toBeTruthy());
    
    // Wait for registry delete icon to appear, then click it
    await waitFor(() => expect(screen.getAllByTitle("Delete tool").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTitle("Delete tool")[0]);
    
    // Confirm via the modal dialog — modal's confirm button is the last one named /delete tool/
    await waitFor(() => expect(screen.getByRole("dialog", { name: /confirm delete tool/i })).toBeTruthy());
    const deleteToolBtns = screen.getAllByRole("button", { name: /delete tool/i });
    fireEvent.click(deleteToolBtns[deleteToolBtns.length - 1]);
    
    // Verify the tool name is removed from the Registry sidebar items
    await waitFor(() => expect(screen.queryByText("run-tests", { selector: "span.font-mono" })).toBeNull());
  });

  it("renders the template gallery in empty state", async () => {
    global.fetch = makeFetchMock({});
    render(<BuilderSection />);
    
    // Left pane empty state
    await waitFor(() => expect(screen.getByText("No tools defined yet.")).toBeTruthy());
    
    // Right pane template gallery should be expanded by default and list templates
    await waitFor(() => expect(screen.getByText("list-files")).toBeTruthy());
    expect(screen.getByText("run-tests")).toBeTruthy();
    expect(screen.getByText("deploy-staging")).toBeTruthy();
    expect(screen.getByText("remove-temp")).toBeTruthy();
    expect(screen.getByRole("button", { name: /start from scratch/i })).toBeTruthy();
  });

  it("save bar shows count after editing then disappears after save", async () => {
    render(<BuilderSection />);
    // Wait for the tool to appear in the Registry
    await waitFor(() => expect(screen.getByText("run-tests")).toBeTruthy());

    // Wait for registry delete icon, then click it
    await waitFor(() => expect(screen.getAllByTitle("Delete tool").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTitle("Delete tool")[0]);
    await waitFor(() => expect(screen.getByRole("dialog", { name: /confirm delete tool/i })).toBeTruthy());
    const deleteToolBtns = screen.getAllByRole("button", { name: /delete tool/i });
    fireEvent.click(deleteToolBtns[deleteToolBtns.length - 1]);
    
    // The inline SaveBar should now show "1 change" (BuilderSection uses inline prop)
    await waitFor(() => expect(screen.getByText("1 change")).toBeTruthy());

    // Click Save Changes — the inline SaveBar's save button
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    
    // After PUT resolves the count drops to 0, so "1 change" text disappears
    await waitFor(() => expect(screen.queryByText("1 change")).toBeNull(), { timeout: 3000 });
  });

  it("allows selecting a template and creating a tool inline", async () => {
    global.fetch = makeFetchMock({});
    render(<BuilderSection />);
    
    // Wait for the gallery to load
    await waitFor(() => expect(screen.getByText("list-files")).toBeTruthy());
    
    // Select the "list-files" template
    fireEvent.click(screen.getByText("list-files"));
    
    // The inline editor should now display with the prefilled name (h3 heading)
    await waitFor(() => expect(screen.getByText("list-files", { selector: "h3" })).toBeTruthy());
    
    // When initial.name is non-empty the ToolForm button reads "Update Tool"
    fireEvent.click(screen.getByRole("button", { name: /update tool/i }));
    
    // It should now show up in the Registry sidebar span
    await waitFor(() => expect(screen.getByText("list-files", { selector: "span" })).toBeTruthy());
  });

  it("allows creating a tool from scratch inline", async () => {
    global.fetch = makeFetchMock({});
    render(<BuilderSection />);
    
    // Click start from scratch
    await waitFor(() => expect(screen.getByRole("button", { name: /start from scratch/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /start from scratch/i }));
    
    // Fill in name & description
    await waitFor(() => expect(screen.getByLabelText(/^name$/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "my-custom-tool" } });
    fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: "some custom tool" } });
    
    // Add command argument
    const argvInput = screen.getAllByPlaceholderText(/\+ arg/)[0];
    fireEvent.change(argvInput, { target: { value: "echo" } });
    fireEvent.keyDown(argvInput, { key: "Enter" });
    
    // Create the tool (initial.name is "" so button reads "Create Tool")
    fireEvent.click(screen.getByRole("button", { name: /create tool/i }));
    
    // Should render in the Registry sidebar
    await waitFor(() => expect(screen.getByText("my-custom-tool")).toBeTruthy());
  });

  it("Delete kontexta.json clears tools and shows empty state template gallery", async () => {
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
    await waitFor(() => expect(screen.getByText("run-tests")).toBeTruthy());
    await waitFor(() => expect(screen.getByTitle("Remove kontexta.json from this project")).toBeTruthy());

    // First click opens the confirm modal
    fireEvent.click(screen.getByTitle("Remove kontexta.json from this project"));
    await waitFor(() => expect(screen.getByRole("dialog", { name: /confirm delete kontexta\.json/i })).toBeTruthy());
    
    // Click the modal's confirm button
    fireEvent.click(screen.getByRole("button", { name: /delete file/i }));

    // After delete: tools are cleared and gallery is expanded
    await waitFor(() => expect(screen.queryByTitle("Remove kontexta.json from this project")).toBeNull());
    expect(screen.getByText("list-files")).toBeTruthy(); // template gallery is back
  });

  it("surfaces per-tool errors from validation.errors[] (not just warnings)", async () => {
    global.fetch = makeFetchMock(TOOLS_INITIAL, {
      errors: ["tool 'run-tests' rejected: argv[0] must be literal"],
      warnings: [],
    });
    render(<BuilderSection />);
    await waitFor(() =>
      // The error badge is rendered as a title attr on the red dot in the Registry sidebar
      expect(screen.getByTitle("tool 'run-tests' rejected: argv[0] must be literal")).toBeTruthy(),
    );
  });
});
