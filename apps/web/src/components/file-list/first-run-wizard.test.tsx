// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FirstRunWizard } from "./first-run-wizard";

const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, enabled: false, hooks_supported: true, onboardable: true, hooks_installed: false, hooks_version: null,
  hooks_verified_at: null, last_hook_event_at: null, config_present: false, emitter_stale: false, notes: [], ...over,
});

let state: any;
let patches: Array<{ id: string; enabled: boolean }>;
let failing: Set<string>;

beforeEach(() => {
  patches = []; failing = new Set();
  state = { install_mode: "npm", agents: [row("claude-code", "Claude Code"), row("gemini", "Gemini CLI"), row("aider", "Aider", { hooks_supported: false })], alerts: [], prompt: null, docker_commands: {} };
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const m = /^\/api\/agents\/([^/]+)$/.exec(url);
    if (m && init?.method === "PATCH") {
      const enabled = JSON.parse(String(init.body)).enabled;
      patches.push({ id: m[1], enabled });
      const a = state.agents.find((x: any) => x.id === m[1]);
      a.enabled = enabled;
      const ok = !failing.has(m[1]);
      if (enabled && a.hooks_supported && ok) a.hooks_installed = true;
      const install = enabled && a.hooks_supported ? (ok ? { ok: true, changed: true, notes: [] } : { ok: false, changed: false, error: "settings.json is not valid JSON", notes: [] }) : null;
      return { ok: true, status: 200, json: async () => ({ agent: m[1], enabled, install, docker_command: null, note: null }) };
    }
    if (url === "/api/agents") return { ok: true, status: 200, json: async () => state };
    return { ok: true, status: 200, json: async () => ({}) };
  }) as any;
});
afterEach(() => cleanup());

const renderWizard = () => render(<FirstRunWizard open onClose={() => {}} projects={[]} onSaved={() => {}} />);

describe("FirstRunWizard", () => {
  it("step 1 lists agents; hook-less ones are marked MCP capture only", async () => {
    renderWizard();
    expect(await screen.findByText("Which coding agents do you use?")).toBeTruthy();
    expect(screen.getByLabelText("Claude Code")).toBeTruthy();
    expect(screen.getByText("MCP capture only")).toBeTruthy();
  });

  it("enabling agents applies them (installing hooks) and step 2 reports each result, with a retry for failures", async () => {
    failing.add("gemini");
    renderWizard();
    fireEvent.click(await screen.findByLabelText("Claude Code"));
    fireEvent.click(screen.getByLabelText("Gemini CLI"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Install hooks")).toBeTruthy();
    expect(patches).toEqual([{ id: "claude-code", enabled: true }, { id: "gemini", enabled: true }]);
    expect(await screen.findByText(/Install failed: settings\.json is not valid JSON/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Gemini CLI" })).toBeTruthy();
    expect(screen.getByText(/Claude Code installed/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Set Up Your Profile")).toBeTruthy();
  });

  it("'Skip for now' jumps to the profile step without enabling anything", async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText("Set Up Your Profile")).toBeTruthy();
    expect(patches).toEqual([]);
  });

  it("docker mode shows the host command with a copy button instead of installing", async () => {
    state.install_mode = "docker";
    state.docker_commands = { "claude-code": "docker run --rm safiyu/kontexta hooks install --agent claude-code" };
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/agents/claude-code" && init?.method === "PATCH") {
        state.agents[0].enabled = true;
        return { ok: true, status: 200, json: async () => ({ agent: "claude-code", enabled: true, install: null, docker_command: state.docker_commands["claude-code"], note: null }) };
      }
      return { ok: true, status: 200, json: async () => state };
    }) as any;
    renderWizard();
    fireEvent.click(await screen.findByLabelText("Claude Code"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/hooks install --agent claude-code/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy install command for Claude Code" })).toBeTruthy();
  });

  it("the profile step is the final step and finishes the wizard on save", async () => {
    let closed = false;
    let saved = false;
    render(
      <FirstRunWizard
        open
        onClose={() => { closed = true; }}
        projects={[]}
        onSaved={() => { saved = true; }}
      />
    );
    fireEvent.click(await screen.findByLabelText("Claude Code"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Install hooks");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Set Up Your Profile");
    expect(screen.getByRole("button", { name: "Finish & Launch" })).toBeTruthy();
    expect(screen.queryByText("Onboard an Agent")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Finish & Launch" }));
    await vi.waitFor(() => {
      expect(saved).toBe(true);
      expect(closed).toBe(true);
    });
  });
});
