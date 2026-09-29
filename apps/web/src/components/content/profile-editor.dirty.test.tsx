// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ProfileEditor } from "./profile-editor";

// Server content with a doubled H1 and stray spacing: never byte-equal to what the editor assembles.
const messy = "# Profile\n\n# Profile\n\n## Name\nsafi\n\n\n\n## Role\nlead\n";

afterEach(() => cleanup());

describe("ProfileEditor dirty state", () => {
  it("is clean after load and after save even when the server content is not canonical", async () => {
    global.fetch = vi.fn(async (_url: string, init?: any) => ({
      ok: true, status: 200,
      json: async () => (init?.method === "PUT" ? { content: messy } : { exists: true, content: messy }),
    })) as any;
    const onDirtyChange = vi.fn();
    render(<ProfileEditor onDirtyChange={onDirtyChange} onChanged={vi.fn()} />);
    await screen.findByDisplayValue("safi");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    fireEvent.change(screen.getByDisplayValue("safi"), { target: { value: "safiyu" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("clears its dirty flag when unmounted mid-edit", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ exists: true, content: messy }) })) as any;
    const onDirtyChange = vi.fn();
    const { unmount } = render(<ProfileEditor onDirtyChange={onDirtyChange} onChanged={vi.fn()} />);
    fireEvent.change(await screen.findByDisplayValue("safi"), { target: { value: "x" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});
