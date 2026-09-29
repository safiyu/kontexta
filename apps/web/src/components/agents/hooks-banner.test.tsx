// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HooksBanner } from "./hooks-banner";

const stateWith = (alerts: Array<{ agent: string; name: string; installed: boolean }>) => ({
  install_mode: "npm", agents: [], alerts: alerts.map((a) => ({ ...a, verified_at: null })), prompt: null, docker_commands: {},
});
const serve = (state: unknown) => { global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => state })) as any; };

beforeEach(() => sessionStorage.clear());
afterEach(() => cleanup());

describe("HooksBanner", () => {
  it("renders nothing when there are no alerts", async () => {
    serve(stateWith([]));
    const { container } = render(<HooksBanner onOpen={() => {}} />);
    await waitFor(() => expect((global.fetch as any).mock.calls.length).toBeGreaterThan(0));
    expect(container.textContent).toBe("");
  });

  it("names the agents that need hooks and opens the Agents tab on click", async () => {
    serve(stateWith([{ agent: "claude-code", name: "Claude Code", installed: false }, { agent: "gemini", name: "Gemini CLI", installed: false }]));
    const onOpen = vi.fn();
    render(<HooksBanner onOpen={onOpen} />);
    expect(await screen.findByText(/Hooks not installed for Claude Code, Gemini CLI/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up hooks" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("distinguishes installed-but-silent agents", async () => {
    serve(stateWith([{ agent: "cursor", name: "Cursor", installed: true }]));
    render(<HooksBanner onOpen={() => {}} />);
    expect(await screen.findByText(/No events yet from Cursor/)).toBeTruthy();
  });

  it("dismissal sticks for the same alert set but not for a new one", async () => {
    serve(stateWith([{ agent: "gemini", name: "Gemini CLI", installed: false }]));
    const first = render(<HooksBanner onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(first.container.textContent).toBe(""));
    first.unmount();

    serve(stateWith([{ agent: "gemini", name: "Gemini CLI", installed: false }]));
    const same = render(<HooksBanner onOpen={() => {}} />);
    await waitFor(() => expect((global.fetch as any).mock.calls.length).toBeGreaterThan(0));
    expect(same.container.textContent).toBe("");
    same.unmount();

    serve(stateWith([{ agent: "gemini", name: "Gemini CLI", installed: false }, { agent: "codex", name: "Codex CLI", installed: false }]));
    render(<HooksBanner onOpen={() => {}} />);
    expect(await screen.findByText(/Gemini CLI, Codex CLI/)).toBeTruthy();
  });
});
