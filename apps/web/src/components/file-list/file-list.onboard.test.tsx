// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FileList } from "./file-list";

const project = { id: 7, name: "demo", path: "/tmp/demo", remote_url: null, agent_rules: { status: "outdated" as const, latest_version: "3.1.0" } };

function renderList(extra: Record<string, unknown> = {}) {
  const props = {
    files: [], selectedFileId: null, onSelectFile: vi.fn(), sortBy: "updated_at" as const, onSortChange: vi.fn(),
    selectedFolder: null, selectedProject: project, selectedSection: "projects" as const, onSync: vi.fn(),
    projects: [project], onRefresh: vi.fn(), onNewFile: vi.fn(), ...extra,
  };
  render(<FileList {...props} />);
  return props;
}

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any;
});
afterEach(() => cleanup());

describe("FileList — outdated agent rules alert", () => {
  it("reloads the projects list after onboarding so the alert clears without a page refresh", async () => {
    const onOnboarded = vi.fn();
    const props = renderList({ onOnboarded });
    expect(screen.getByText(/agent rules are outdated/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Onboard Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Onboard agent" }));

    await waitFor(() => expect(onOnboarded).toHaveBeenCalledOnce());
    // The "Scan for New Files" reindex does not reload projects, so it must not be what onboarding relies on.
    expect(props.onRefresh).not.toHaveBeenCalled();
  });

  it("still refreshes files when no dedicated onOnboarded handler is given", async () => {
    const props = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Onboard Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Onboard agent" }));
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce());
  });
});
