// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PatternTester } from "./pattern-tester";

beforeEach(() => {
  global.fetch = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (body.pattern === "(") return { ok: true, json: async () => ({ valid: false, error: "invalid" }) };
    return { ok: true, json: async () => ({ valid: true, matches: body.value === "abc" }) };
  }) as any;
});

afterEach(() => {
  cleanup();
});

describe("PatternTester", () => {
  it("shows ✓ when sample matches", async () => {
    render(<PatternTester pattern="^[a-z]+$" />);
    fireEvent.change(screen.getByPlaceholderText(/sample value/i), { target: { value: "abc" } });
    await waitFor(() => expect(screen.getByText("✓ matches")).toBeTruthy());
  });
  it("shows ✗ when sample doesn't match", async () => {
    render(<PatternTester pattern="^[a-z]+$" />);
    fireEvent.change(screen.getByPlaceholderText(/sample value/i), { target: { value: "ABC" } });
    await waitFor(() => expect(screen.getByText(/no match/i)).toBeTruthy());
  });
});
