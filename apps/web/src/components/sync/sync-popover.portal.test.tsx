// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { SyncPopover } from "./sync-popover";

afterEach(() => cleanup());

describe("SyncPopover stacking", () => {
  it("renders on document.body so an overflow-hidden, blurred header cannot clip or re-anchor it", () => {
    const { container } = render(
      <header style={{ overflow: "hidden" }}>
        <SyncPopover open onClose={vi.fn()} log={[]} globalRemoteUrl={null} onSyncAll={async () => {}} onUpdateRemote={async () => {}} />
      </header>,
    );
    const dialog = screen.getByRole("dialog");
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.closest("body")).toBe(document.body);
  });
});
