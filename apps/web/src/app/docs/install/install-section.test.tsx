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

describe("InstallSection — enabled-agent filter", () => {
  const agentRow = (id: string, enabled: boolean) => ({ id, name: id, enabled, hooks_supported: true, onboardable: true, hooks_installed: false, hooks_version: null, hooks_verified_at: null, last_hook_event_at: null, config_present: false, emitter_stale: false, notes: [] });
  const serve = (agents: { ok: boolean; json: () => Promise<unknown> }) => {
    global.fetch = vi.fn(async (url: string) => {
      if (url === "/api/agents") return agents;
      return { ok: true, json: async () => ({ kind: "shell", body: "docker run safiyu/kontexta", notes: [], detectedInstall: "docker" }) };
    }) as any;
  };
  const clientLabels = () => Array.from((screen.getByLabelText("AI client") as HTMLSelectElement).options).map((o) => o.textContent);

  it("lists only enabled agents plus Generic JSON", async () => {
    serve({ ok: true, json: async () => ({ install_mode: "npm", agents: [agentRow("claude-code", true), agentRow("cursor", true), agentRow("gemini", false)], alerts: [], prompt: null, docker_commands: {} }) });
    render(<InstallSection />);
    await waitFor(() => expect(clientLabels()).toEqual(["Claude Code", "Cursor", "Generic JSON"]));
  });

  it("with nothing enabled shows Generic JSON and a hint to use the AGENTS tab", async () => {
    serve({ ok: true, json: async () => ({ install_mode: "npm", agents: [agentRow("claude-code", false)], alerts: [], prompt: null, docker_commands: {} }) });
    render(<InstallSection />);
    await waitFor(() => expect(clientLabels()).toEqual(["Generic JSON"]));
    expect(screen.getByText(/enable the agents you use in the AGENTS tab/i)).toBeTruthy();
    expect(screen.getByText(/enabling an agent installs kontexta hooks into that agent's config file/i)).toBeTruthy();
  });

  it("re-selects a visible client when the default one is hidden", async () => {
    serve({ ok: true, json: async () => ({ install_mode: "npm", agents: [agentRow("cursor", true)], alerts: [], prompt: null, docker_commands: {} }) });
    render(<InstallSection />);
    await waitFor(() => expect((screen.getByLabelText("AI client") as HTMLSelectElement).value).toBe("cursor"));
  });

  it("fails open when the agents API errors or returns an unexpected shape", async () => {
    serve({ ok: false, json: async () => ({}) });
    const first = render(<InstallSection />);
    await waitFor(() => expect(clientLabels()).toHaveLength(12));
    first.unmount();
    serve({ ok: true, json: async () => ({ unexpected: true }) });
    render(<InstallSection />);
    await waitFor(() => expect(clientLabels()).toHaveLength(12));
  });
});
