// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Dialog } from "./dialog";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(() => cleanup());

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    render(<Dialog open={false} onClose={() => {}} title="T"><p>body</p></Dialog>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders role=dialog with title and children when open", () => {
    render(<Dialog open onClose={() => {}} title="My Title"><p>body text</p></Dialog>);
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Radix also renders a hidden aria-describedby fallback echoing the title
    // (to avoid its "Missing Description" warning when no description is given),
    // so scope this to the visible heading rather than getByText, which would
    // match both nodes.
    expect(screen.getByText("My Title", { selector: "h2" })).toBeTruthy();
    expect(screen.getByText("body text")).toBeTruthy();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="T"><p>b</p></Dialog>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("has a close button that calls onClose", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="T"><p>b</p></Dialog>);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ConfirmDialog", () => {
  it("renders title, message, and calls onConfirm", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open onClose={() => {}} onConfirm={onConfirm} title="Delete file?" message="This is recoverable via Time Travel." />
    );
    expect(screen.getByText("This is recoverable via Time Travel.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("uses destructive styling and custom labels", () => {
    render(
      <ConfirmDialog open onClose={() => {}} onConfirm={() => {}} title="T" message="m" confirmLabel="Delete" destructive />
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toMatch(/btn-destructive/);
  });

  it("cancel button calls onClose", () => {
    const onClose = vi.fn();
    render(<ConfirmDialog open onClose={onClose} onConfirm={() => {}} title="T" message="m" />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
