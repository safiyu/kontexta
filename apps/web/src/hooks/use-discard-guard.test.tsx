// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useDiscardGuard } from "./use-discard-guard";

let api: ReturnType<typeof useDiscardGuard>;
function Harness() {
  api = useDiscardGuard();
  return <>{api.dialog}</>;
}
afterEach(() => cleanup());

describe("useDiscardGuard", () => {
  it("proceeds immediately when clean, without any dialog", () => {
    render(<Harness />);
    expect(api.confirmDiscardIfDirty(vi.fn())).toBe(true);
    expect(screen.queryByText(/Discard them\?/)).toBeNull();
  });

  it("blocks when dirty, shows an in-app dialog, and re-runs the action on Discard", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<Harness />);
    api.setDirty("file:1", true);
    const retry = vi.fn();
    let allowed = true;
    act(() => { allowed = api.confirmDiscardIfDirty(retry); });
    expect(allowed).toBe(false);
    expect(retry).not.toHaveBeenCalled();
    expect(screen.getByText(/Discard them\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("tracks editors independently: clearing one key keeps the other blocking", () => {
    render(<Harness />);
    api.setDirty("file:1", true);
    api.setDirty("profile", true);
    api.setDirty("file:1", false);
    expect(api.confirmDiscardIfDirty(vi.fn())).toBe(false);
    api.setDirty("profile", false);
    expect(api.confirmDiscardIfDirty(vi.fn())).toBe(true);
  });

  it("drops the action on Cancel", () => {
    render(<Harness />);
    api.setDirty("file:1", true);
    const retry = vi.fn();
    act(() => { api.confirmDiscardIfDirty(retry); });
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(retry).not.toHaveBeenCalled();
    expect(screen.queryByText(/Discard them\?/)).toBeNull();
  });
});
