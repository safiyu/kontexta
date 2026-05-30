// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { TemplateGallery } from "./template-gallery";
import { HAND_TOOL_TEMPLATES } from "@/lib/hand-tool-templates";

afterEach(() => cleanup());

describe("TemplateGallery", () => {
  it("renders one card per template plus a 'start from scratch' action", () => {
    render(<TemplateGallery onSelectTemplate={() => {}} onBlank={() => {}} />);
    for (const t of HAND_TOOL_TEMPLATES) {
      expect(screen.getByText(t.name)).toBeTruthy();
      expect(screen.getByText(t.oneLiner)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: /start from scratch/i })).toBeTruthy();
  });

  it("calls onSelectTemplate with the right name and def when a card is clicked", () => {
    const onSelectTemplate = vi.fn();
    render(<TemplateGallery onSelectTemplate={onSelectTemplate} onBlank={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /list-files/i }));
    expect(onSelectTemplate).toHaveBeenCalledWith("list-files", HAND_TOOL_TEMPLATES[0].def);
  });

  it("calls onBlank when 'start from scratch' is clicked", () => {
    const onBlank = vi.fn();
    render(<TemplateGallery onSelectTemplate={() => {}} onBlank={onBlank} />);
    fireEvent.click(screen.getByRole("button", { name: /start from scratch/i }));
    expect(onBlank).toHaveBeenCalled();
  });
});
