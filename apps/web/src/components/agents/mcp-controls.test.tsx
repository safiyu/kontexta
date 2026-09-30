// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { McpControls } from "./mcp-controls";

const agent = (over: Record<string, unknown> = {}) => ({
  id: "gemini", name: "Gemini CLI", enabled: true, mcp_supported: true, mcp_installed: false, mcp_approval: "prompt", mcp_current: false, mcp_stale: false,
  mcp_config_path: "/h/.gemini/settings.json", mcp_approval_supported: true, mcp_notes: [], ...over,
}) as any;
const state = (over: Record<string, unknown> = {}) => ({
  install_mode: "npm", destructive_tools: ["files.delete", "folders.delete"], mcp_docker_commands: {}, ...over,
}) as any;
const ok = (over: Record<string, unknown> = {}): any => ({ ok: true, status: 200, outcome: { ok: true, changed: true, approval: "prompt", notes: [], ...over } });

afterEach(() => cleanup());

describe("McpControls", () => {
  it("connects with the default approval and reports the result", async () => {
    const mcpAction = vi.fn(async () => ok());
    render(<McpControls agent={agent()} state={state()} mcpAction={mcpAction} />);
    expect(screen.getByText(/not connected/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect MCP for Gemini CLI" }));
    await waitFor(() => expect(mcpAction).toHaveBeenCalledWith("gemini", "install", "prompt"));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringMatching(/connected/i));
  });

  it("'safe' applies straight away; 'all' first asks, listing the destructive tools, and Cancel does nothing", async () => {
    const mcpAction = vi.fn(async () => ok({ approval: "all" }));
    render(<McpControls agent={agent()} state={state()} mcpAction={mcpAction} />);
    const select = screen.getByLabelText("MCP approval for Gemini CLI");
    fireEvent.change(select, { target: { value: "safe" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect MCP for Gemini CLI" }));
    await waitFor(() => expect(mcpAction).toHaveBeenCalledWith("gemini", "install", "safe"));

    mcpAction.mockClear();
    fireEvent.change(select, { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect MCP for Gemini CLI" }));
    expect(await screen.findByText(/files\.delete/)).toBeTruthy();
    expect(screen.getByText(/folders\.delete/)).toBeTruthy();
    expect(mcpAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mcpAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Connect MCP for Gemini CLI" }));
    fireEvent.click(await screen.findByRole("button", { name: "Allow all" }));
    await waitFor(() => expect(mcpAction).toHaveBeenCalledWith("gemini", "install", "all"));
  });

  it("agents without a config-file allowlist get no picker and a note instead", () => {
    render(<McpControls agent={agent({ id: "cursor", name: "Cursor", mcp_approval_supported: false })} state={state()} mcpAction={vi.fn()} />);
    expect(screen.queryByLabelText("MCP approval for Cursor")).toBeNull();
    expect(screen.getByText(/approve kxta tools in the app/i)).toBeTruthy();
  });

  it("when connected it shows the level, can update and can disconnect", async () => {
    const mcpAction = vi.fn(async () => ok({ changed: true }));
    render(<McpControls agent={agent({ mcp_installed: true, mcp_current: true, mcp_approval: "safe" })} state={state()} mcpAction={mcpAction} />);
    expect(screen.getByText(/MCP connected/)).toBeTruthy();
    expect((screen.getByLabelText("MCP approval for Gemini CLI") as HTMLSelectElement).value).toBe("safe");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect MCP for Gemini CLI" }));
    await waitFor(() => expect(mcpAction).toHaveBeenCalledWith("gemini", "uninstall", "prompt"));
    expect(screen.getByRole("button", { name: "Update MCP for Gemini CLI" })).toBeTruthy();
  });

  it("flags an out-of-date registration", () => {
    render(<McpControls agent={agent({ mcp_installed: true, mcp_current: false })} state={state()} mcpAction={vi.fn()} />);
    expect(screen.getByText(/out of date/i)).toBeTruthy();
  });

  it("shows a failure from the installer", async () => {
    const mcpAction = vi.fn(async (): Promise<any> => ({ ok: true, status: 200, outcome: { ok: false, changed: false, approval: "prompt", notes: [], error: "Cursor config folder not found" } }));
    render(<McpControls agent={agent({ id: "cursor", name: "Cursor" })} state={state()} mcpAction={mcpAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect MCP for Cursor" }));
    expect(await screen.findByText(/config folder not found/)).toBeTruthy();
  });

  it("docker mode shows the host command with the chosen approval instead of a button", () => {
    const cmd = 'docker run --rm … connect install --home /host --no-db --agent gemini';
    render(<McpControls agent={agent()} state={state({ install_mode: "docker", mcp_docker_commands: { gemini: cmd } })} mcpAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Connect MCP/ })).toBeNull();
    expect(screen.getByText(cmd)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("MCP approval for Gemini CLI"), { target: { value: "safe" } });
    expect(screen.getByText(`${cmd} --approval safe`)).toBeTruthy();
  });
});
