// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ArgvChipEditor } from "./argv-chip-editor";

afterEach(() => {
  cleanup();
});

describe("ArgvChipEditor", () => {
  it("renders one chip per argv element", () => {
    render(<ArgvChipEditor value={["npx", "vitest", "{{filter}}"]} onChange={() => {}} declaredParams={["filter"]} />);
    expect(screen.getByText("npx")).toBeTruthy();
    expect(screen.getByText("vitest")).toBeTruthy();
    expect(screen.getByText("{{filter}}")).toBeTruthy();
  });
  it("flags placeholders without a matching param", () => {
    render(<ArgvChipEditor value={["echo", "{{undeclared}}"]} onChange={() => {}} declaredParams={[]} />);
    const bad = screen.getByText("{{undeclared}}");
    expect(bad.className).toMatch(/text-red/);
  });
  it("calls onChange when a chip is removed", () => {
    const onChange = vi.fn();
    render(<ArgvChipEditor value={["npx", "vitest"]} onChange={onChange} declaredParams={[]} />);
    fireEvent.click(screen.getAllByLabelText(/remove/i)[1]);
    expect(onChange).toHaveBeenCalledWith(["npx"]);
  });
  it("commits pending draft on blur", () => {
    const onChange = vi.fn();
    render(<ArgvChipEditor value={["npx"]} onChange={onChange} declaredParams={[]} />);
    const input = screen.getByPlaceholderText(/\+ arg/i);
    fireEvent.change(input, { target: { value: "vitest" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(["npx", "vitest"]);
  });
  it("commits pending draft on Tab", () => {
    const onChange = vi.fn();
    render(<ArgvChipEditor value={[]} onChange={onChange} declaredParams={[]} />);
    const input = screen.getByPlaceholderText(/\+ arg/i);
    fireEvent.change(input, { target: { value: "echo" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onChange).toHaveBeenCalledWith(["echo"]);
  });
});
