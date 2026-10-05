// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentsPanel } from "./agents-panel";

const row = (over: Record<string, unknown>) => ({
  id: "claude-code", name: "Claude Code", enabled: false, hooks_supported: true, onboardable: true, hooks_installed: false,
  hooks_version: null, hooks_verified_at: null, last_hook_event_at: null, config_present: false, emitter_stale: false, notes: [], ...over,
});

let state: any;
let calls: Array<{ url: string; method: string; body?: any }>;

function mockFetch(handler?: (url: string, init?: RequestInit) => any) {
  calls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const custom = handler?.(url, init);
    if (custom) return custom;
    return { ok: true, status: 200, json: async () => state };
  }) as any;
}

beforeEach(() => {
  state = { install_mode: "npm", agents: [row({}), row({ id: "aider", name: "Aider", hooks_supported: false })], alerts: [], prompt: null, docker_commands: {} };
});
afterEach(() => cleanup());

describe("AgentsPanel", () => {
  it("lists agents; hook-less agents say 'MCP capture only' and offer no hook install", async () => {
    mockFetch();
    render(<AgentsPanel />);
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("MCP capture only")).toBeTruthy();
    expect(screen.queryByLabelText("Install hooks for Aider")).toBeNull();
  });

  it("enabling an agent PATCHes it, shows the install result, then shows the refreshed state", async () => {
    mockFetch((url, init) => {
      if (init?.method === "PATCH") {
        state = { ...state, agents: [row({ enabled: true, hooks_installed: true }), state.agents[1]] };
        return { ok: true, status: 200, json: async () => ({ agent: "claude-code", enabled: true, install: { ok: true, changed: true, notes: [] }, docker_command: null, note: null }) };
      }
    });
    render(<AgentsPanel />);
    fireEvent.click(await screen.findByLabelText("Enable Claude Code"));
    expect(await screen.findByText("Hooks installed.")).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/agents/claude-code", body: { enabled: true } });
    await waitFor(() => expect(screen.getByText(/waiting for the first event/)).toBeTruthy());
  });

  it("surfaces an install failure instead of hiding it", async () => {
    mockFetch((url, init) => {
      if (init?.method === "PATCH") return { ok: true, status: 200, json: async () => ({ agent: "claude-code", enabled: true, install: { ok: false, changed: false, error: "settings.json is not valid JSON", notes: [] }, docker_command: null, note: null }) };
    });
    render(<AgentsPanel />);
    fireEvent.click(await screen.findByLabelText("Enable Claude Code"));
    expect(await screen.findByText(/Install failed: settings\.json is not valid JSON/)).toBeTruthy();
  });

  it("docker mode shows a copyable command instead of install buttons", async () => {
    state = { ...state, install_mode: "docker", agents: [row({ enabled: true }), state.agents[1]], docker_commands: { "claude-code": "docker run --rm safiyu/kontexta hooks install --agent claude-code" } };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockFetch();
    render(<AgentsPanel />);
    expect(await screen.findByText(/hooks install --agent claude-code/)).toBeTruthy();
    expect(screen.queryByLabelText("Install hooks for Claude Code")).toBeNull();
    fireEvent.click(screen.getByLabelText("Copy install command for Claude Code"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("docker run --rm safiyu/kontexta hooks install --agent claude-code"));
  });

  it("shows verified status with the last event time", async () => {
    state = { ...state, agents: [row({ enabled: true, hooks_installed: true, hooks_verified_at: "2026-09-29T09:00:00.000Z", last_hook_event_at: "2026-09-29T10:00:00.000Z" }), state.agents[1]] };
    mockFetch();
    render(<AgentsPanel />);
    expect(await screen.findByText(/verified · last event/)).toBeTruthy();
  });

  it("shows an error when the agents API is unavailable", async () => {
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<AgentsPanel />);
    expect(await screen.findByText(/Could not load agents/)).toBeTruthy();
  });

  it("tells the user to replace <DATA_DIR> when the command still contains the placeholder", async () => {
    state = { ...state, install_mode: "docker", agents: [row({ enabled: true }), state.agents[1]], docker_commands: { "claude-code": 'docker run --rm -v "<DATA_DIR>":/app/data safiyu/kontexta hooks install --agent claude-code' } };
    mockFetch();
    render(<AgentsPanel />);
    expect(await screen.findByText(/Replace <DATA_DIR> with the absolute path/)).toBeTruthy();
  });

  it("offers MCP controls for enabled, MCP-capable agents only, and points the rest at the snippets", async () => {
    state = {
      ...state,
      destructive_tools: ["files_delete"], mcp_docker_commands: {},
      agents: [
        row({ enabled: true, mcp_supported: true, mcp_installed: false, mcp_approval: "prompt", mcp_approval_supported: true }),
        row({ id: "cursor", name: "Cursor", enabled: false, mcp_supported: true, mcp_installed: false, mcp_approval: "prompt" }),
        row({ id: "codex", name: "Codex CLI", enabled: true, mcp_supported: false }),
      ],
    };
    mockFetch();
    render(<AgentsPanel />);
    expect(await screen.findByRole("button", { name: "Connect MCP for Claude Code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect MCP for Cursor" })).toBeNull();
    expect(screen.getByText(/INSTALL tab snippet/i)).toBeTruthy();
  });
});
