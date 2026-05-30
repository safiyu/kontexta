// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InstallSection } from "./install-section";

beforeEach(() => {
  global.fetch = vi.fn(async (url: string) => {
    if (url.includes("install=docker")) {
      return { ok: true, json: async () => ({ kind: "shell", body: "docker run safiyu/kontexta", notes: [], detectedInstall: "docker" }) };
    }
    return { ok: true, json: async () => ({ kind: "shell", body: "npx -y kontexta-mcp", notes: [], detectedInstall: "docker" }) };
  }) as any;
});

afterEach(() => {
  cleanup();
});

describe("InstallSection", () => {
  it("renders snippet from default selection", async () => {
    render(<InstallSection />);
    await waitFor(() => expect(screen.getByText(/docker run/)).toBeTruthy());
  });
  it("re-fetches when install method changes", async () => {
    render(<InstallSection />);
    await waitFor(() => expect(screen.getByText(/docker run/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/install method/i), { target: { value: "npm" } });
    await waitFor(() => expect(screen.getByText(/npx -y/)).toBeTruthy());
  });
});
