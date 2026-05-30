// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { ToolListRow } from "./tool-list-row";
import type { ToolDef } from "./tool-form";

afterEach(() => cleanup());

const baseDef: ToolDef = { description: "x", command: ["echo", "hi"] };

describe("ToolListRow", () => {
  it("renders no stripe when danger is safe (or omitted)", () => {
    const { container } = render(
      <ToolListRow name="t" def={baseDef} onEdit={() => {}} onDelete={() => {}} />
    );
    expect(container.querySelector('[data-testid="danger-stripe"]')).toBeNull();
  });

  it("renders amber stripe when danger is moderate", () => {
    const { container } = render(
      <ToolListRow name="t" def={{ ...baseDef, danger: "moderate" }} onEdit={() => {}} onDelete={() => {}} />
    );
    const stripe = container.querySelector('[data-testid="danger-stripe"]');
    expect(stripe?.className).toMatch(/bg-amber-500/);
  });

  it("renders red stripe when danger is high", () => {
    const { container } = render(
      <ToolListRow name="t" def={{ ...baseDef, danger: "high" }} onEdit={() => {}} onDelete={() => {}} />
    );
    const stripe = container.querySelector('[data-testid="danger-stripe"]');
    expect(stripe?.className).toMatch(/bg-red-500/);
  });

  it("renders confirm lock icon when confirm is true", () => {
    render(
      <ToolListRow name="t" def={{ ...baseDef, confirm: true }} onEdit={() => {}} onDelete={() => {}} />
    );
    expect(screen.getByLabelText(/requires confirm/i)).toBeTruthy();
  });

  it("does NOT render lock icon when confirm is false", () => {
    render(<ToolListRow name="t" def={baseDef} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.queryByLabelText(/requires confirm/i)).toBeNull();
  });

  it("dims and shows disabled glyph when disabled is true", () => {
    const { container } = render(
      <ToolListRow name="t" def={{ ...baseDef, disabled: true }} onEdit={() => {}} onDelete={() => {}} />
    );
    expect(screen.getByLabelText(/disabled/i)).toBeTruthy();
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/opacity-50/);
  });

  it("renders inline error line when errorBadge is truthy", () => {
    render(
      <ToolListRow name="t" def={baseDef} onEdit={() => {}} onDelete={() => {}} errorBadge="argv[0] must be literal" />
    );
    expect(screen.getByText(/argv\[0\] must be literal/)).toBeTruthy();
  });

  it("renders no inline error line when errorBadge is null", () => {
    render(<ToolListRow name="t" def={baseDef} onEdit={() => {}} onDelete={() => {}} errorBadge={null} />);
    expect(screen.queryByText(/⚠/)).toBeNull();
  });
});
