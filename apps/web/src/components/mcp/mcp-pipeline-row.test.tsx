// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { MCPPipelineRow } from "./mcp-pipeline-row";

afterEach(() => cleanup());

describe("MCPPipelineRow", () => {
  it("renders label and result text", () => {
    render(<MCPPipelineRow label="kxta.search" result="42 hits" status="active" />);
    expect(screen.getByText("kxta.search")).toBeTruthy();
    expect(screen.getByText("42 hits")).toBeTruthy();
  });

  it("marks the row as active via data-status attribute", () => {
    const { container } = render(
      <MCPPipelineRow label="kxta.search" result="42 hits" status="active" />,
    );
    const row = container.querySelector('[data-status="active"]');
    expect(row).not.toBeNull();
  });

  it("marks the row as idle via data-status attribute", () => {
    const { container } = render(
      <MCPPipelineRow label="kxta.commit_backup" result="idle" status="idle" />,
    );
    const row = container.querySelector('[data-status="idle"]');
    expect(row).not.toBeNull();
  });
});
