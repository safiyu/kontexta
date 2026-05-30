// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { SaveBar } from "./save-bar";

afterEach(() => cleanup());

describe("SaveBar", () => {
  it("hides itself (translate-y-full) when count is 0", () => {
    render(<SaveBar count={0} errorCount={0} onDiscard={() => {}} onSave={() => {}} />);
    const bar = screen.getByRole("region", { name: /unsaved changes/i });
    expect(bar.className).toMatch(/translate-y-full/);
  });

  it("shows singular 'unsaved change' when count is 1", () => {
    render(<SaveBar count={1} errorCount={0} onDiscard={() => {}} onSave={() => {}} />);
    expect(screen.getByText("1 change")).toBeTruthy();
  });

  it("shows plural 'unsaved changes' for count > 1", () => {
    render(<SaveBar count={3} errorCount={0} onDiscard={() => {}} onSave={() => {}} />);
    expect(screen.getByText("3 changes")).toBeTruthy();
  });

  it("Save click calls onSave when no errors", () => {
    const onSave = vi.fn();
    render(<SaveBar count={1} errorCount={0} onDiscard={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    expect(onSave).toHaveBeenCalled();
  });

  it("Save is disabled and labelled 'Fix N error(s)' when errorCount > 0", () => {
    render(<SaveBar count={1} errorCount={2} onDiscard={() => {}} onSave={() => {}} />);
    const btn = screen.getByRole("button", { name: /^fix 2 error\(s\)$/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("Discard click opens confirm modal; modal Discard calls onDiscard", () => {
    const onDiscard = vi.fn();
    render(<SaveBar count={2} errorCount={0} onDiscard={onDiscard} onSave={() => {}} />);
    // Initial click opens the modal — onDiscard NOT yet called.
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /confirm discard/i })).toBeTruthy();
    // Click the modal's Discard button (now there are TWO; the modal one is the 2nd).
    const buttons = screen.getAllByRole("button", { name: /^discard$/i });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onDiscard).toHaveBeenCalled();
  });

  it("Cancel in confirm modal does NOT call onDiscard and closes the modal", () => {
    const onDiscard = vi.fn();
    render(<SaveBar count={2} errorCount={0} onDiscard={onDiscard} onSave={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /confirm discard/i })).toBeNull();
  });
});
