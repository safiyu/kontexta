// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { DropdownMenu } from "./dropdown-menu";

afterEach(() => cleanup());

describe("DropdownMenu", () => {
  it("opens on trigger click and fires onSelect", () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu
        trigger={<button>Open menu</button>}
        items={[{ label: "First action", onSelect }]}
      />
    );
    const trigger = screen.getByRole("button", { name: "Open menu" });
    // Radix's dropdown trigger opens on pointerdown, not click — jsdom's
    // fireEvent.click doesn't dispatch pointer events, so drive it directly.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.pointerUp(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("menuitem", { name: "First action" }));
    expect(onSelect).toHaveBeenCalled();
  });
});
