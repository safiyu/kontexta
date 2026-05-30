// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { JsonSchemaTable } from "./json-schema-table";

afterEach(() => {
  cleanup();
});

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "File title" },
    destination: { type: "string", enum: ["knowledge", "project", "kontexta"] },
    project_id: { type: "number" },
  },
  required: ["title", "destination"],
};

describe("JsonSchemaTable", () => {
  it("renders one row per property", () => {
    render(<JsonSchemaTable schema={SCHEMA as any} />);
    expect(screen.getByText("title")).toBeTruthy();
    expect(screen.getByText("destination")).toBeTruthy();
    expect(screen.getByText("project_id")).toBeTruthy();
  });
  it("marks required vs optional", () => {
    render(<JsonSchemaTable schema={SCHEMA as any} />);
    const rows = screen.getAllByRole("row");
    expect(rows.find((r) => r.textContent?.includes("title") && r.textContent?.includes("required"))).toBeTruthy();
    expect(rows.find((r) => r.textContent?.includes("project_id") && r.textContent?.includes("optional"))).toBeTruthy();
  });
  it("shows enum values", () => {
    render(<JsonSchemaTable schema={SCHEMA as any} />);
    expect(screen.getByText(/knowledge \| project \| kontexta/)).toBeTruthy();
  });
});
