// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { StatusBar } from "./status-bar";

afterEach(() => {
  cleanup();
});

const BASE_PROPS = { globalRemoteUrl: null, status: "ok" as const, lastDoneAt: null, stage: null };

describe("StatusBar", () => {
  it("shows no update banner when up to date", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ currentVersion: "1.0.0", latestVersion: "1.0.0", updateAvailable: false }) })) as any;
    render(<StatusBar {...BASE_PROPS} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/version-check"));
    expect(screen.queryByText(/available/)).toBeNull();
  });

  it("shows a clickable update banner and opens Configure", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ currentVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true }) })) as any;
    const onOpenConfigure = vi.fn();
    render(<StatusBar {...BASE_PROPS} onOpenConfigure={onOpenConfigure} />);
    const banner = await waitFor(() => screen.getByText(/v2\.0\.0 available/));
    fireEvent.click(banner);
    expect(onOpenConfigure).toHaveBeenCalledOnce();
  });
});
