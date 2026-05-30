// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { HandsRunTrace, type HandsRun } from "./hands-run-trace";

afterEach(() => cleanup());

const run: HandsRun = {
  id: "root",
  label: "deploy",
  status: "pending",
  children: [
    { id: "build", label: "build", status: "ok" },
    { id: "test", label: "test", status: "ok" },
  ],
};

describe("HandsRunTrace", () => {
  it("renders the root label and status", () => {
    render(<HandsRunTrace run={run} />);
    expect(screen.getByText(/deploy/)).toBeTruthy();
    expect(screen.getByText(/pending/)).toBeTruthy();
  });

  it("renders each child label and status", () => {
    render(<HandsRunTrace run={run} />);
    expect(screen.getByText(/build/)).toBeTruthy();
    expect(screen.getByText(/^test ·/)).toBeTruthy();
    const okBadges = screen.getAllByText(/ok/);
    expect(okBadges.length).toBeGreaterThanOrEqual(2);
  });

  it("renders an SVG spine and one circle per node", () => {
    const { container } = render(<HandsRunTrace run={run} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    const circles = container.querySelectorAll("svg circle");
    expect(circles.length).toBe(3);
  });
});
