// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ToolFormModal } from "./tool-form-modal";

afterEach(() => {
  cleanup();
});

describe("ToolFormModal", () => {
  it("submits a minimal valid tool", () => {
    const onSave = vi.fn();
    render(<ToolFormModal open initial={null} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "say-hi" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "say hi" } });
    // command argv chip editor: type "echo", press Enter
    const argvInput = screen.getAllByPlaceholderText(/\+ arg/)[0];
    fireEvent.change(argvInput, { target: { value: "echo" } });
    fireEvent.keyDown(argvInput, { key: "Enter" });
    fireEvent.change(argvInput, { target: { value: "hi" } });
    fireEvent.keyDown(argvInput, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith("say-hi", expect.objectContaining({
      description: "say hi",
      command: ["echo", "hi"],
    }));
  });
  it("disables Save when name is invalid", () => {
    render(<ToolFormModal open initial={null} onSave={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Bad-Name" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "x" } });
    expect(screen.getByRole("button", { name: /^save$/i }).hasAttribute("disabled")).toBe(true);
  });
  it("Save enables on the SECOND open after a first-create cycle", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <ToolFormModal open initial={null} onSave={onSave} onClose={() => {}} />
    );
    // First tool
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "first" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "first desc" } });
    const argv1 = screen.getAllByPlaceholderText(/\+ arg/)[0];
    fireEvent.change(argv1, { target: { value: "echo" } });
    fireEvent.keyDown(argv1, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledTimes(1);

    // Close (parent flips open=false)
    rerender(<ToolFormModal open={false} initial={null} onSave={onSave} onClose={() => {}} />);
    // Reopen (parent flips open=true; initial still null for "+ Add tool")
    rerender(<ToolFormModal open initial={null} onSave={onSave} onClose={() => {}} />);

    // Second tool — fill in same fields
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "second" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "second desc" } });
    const argv2 = screen.getAllByPlaceholderText(/\+ arg/)[0];
    fireEvent.change(argv2, { target: { value: "echo" } });
    fireEvent.keyDown(argv2, { key: "Enter" });

    // Should be enabled
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn.hasAttribute("disabled")).toBe(false);
  });
});
