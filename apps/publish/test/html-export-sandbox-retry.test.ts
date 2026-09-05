import { describe, it, expect, vi, beforeEach } from "vitest";

const launchMock = vi.fn();
vi.mock("puppeteer-core", () => ({
  default: { launch: (...args: any[]) => launchMock(...args) },
}));

const { launchChromium, resetChromiumSandboxMemo } = await import("../src/render/html-export.js");

describe("launchChromium sandbox retry", () => {
  beforeEach(() => {
    launchMock.mockReset();
    delete process.env.KONTEXTA_CHROMIUM_NO_SANDBOX;
    resetChromiumSandboxMemo();
  });

  it("retries once with --no-sandbox after a sandboxed launch failure", async () => {
    const fakeBrowser = { close: vi.fn() };
    launchMock
      .mockRejectedValueOnce(new Error("Failed to launch the browser process: No usable sandbox!"))
      .mockResolvedValueOnce(fakeBrowser);

    const browser = await launchChromium("/fake/chrome");

    expect(browser).toBe(fakeBrowser);
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(launchMock.mock.calls[0][0].args).not.toContain("--no-sandbox");
    expect(launchMock.mock.calls[1][0].args).toContain("--no-sandbox");
  });

  it("propagates the error if the retry also fails", async () => {
    launchMock.mockRejectedValue(new Error("still broken"));
    await expect(launchChromium("/fake/chrome")).rejects.toThrow("still broken");
    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it("skips straight to --no-sandbox when KONTEXTA_CHROMIUM_NO_SANDBOX=1", async () => {
    process.env.KONTEXTA_CHROMIUM_NO_SANDBOX = "1";
    const fakeBrowser = { close: vi.fn() };
    launchMock.mockResolvedValueOnce(fakeBrowser);

    const browser = await launchChromium("/fake/chrome");

    expect(browser).toBe(fakeBrowser);
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock.mock.calls[0][0].args).toContain("--no-sandbox");
  });

  it("does not retry when KONTEXTA_CHROMIUM_NO_SANDBOX=1 and launch still fails", async () => {
    process.env.KONTEXTA_CHROMIUM_NO_SANDBOX = "1";
    launchMock.mockRejectedValue(new Error("still broken"));
    await expect(launchChromium("/fake/chrome")).rejects.toThrow("still broken");
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it("remembers a sandboxed-launch failure and skips straight to --no-sandbox on the next call", async () => {
    const fakeBrowser1 = { close: vi.fn() };
    const fakeBrowser2 = { close: vi.fn() };
    launchMock
      .mockRejectedValueOnce(new Error("No usable sandbox!"))
      .mockResolvedValueOnce(fakeBrowser1)
      .mockResolvedValueOnce(fakeBrowser2);

    const first = await launchChromium("/fake/chrome");
    expect(first).toBe(fakeBrowser1);
    expect(launchMock).toHaveBeenCalledTimes(2); // failed attempt + retry

    launchMock.mockClear();
    const second = await launchChromium("/fake/chrome");
    expect(second).toBe(fakeBrowser2);
    // The whole point of the fix: no repeated failed attempt on the second call.
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock.mock.calls[0][0].args).toContain("--no-sandbox");
  });

  it("remembers a successful sandboxed launch and doesn't add --no-sandbox on later calls", async () => {
    const fakeBrowser1 = { close: vi.fn() };
    const fakeBrowser2 = { close: vi.fn() };
    launchMock.mockResolvedValueOnce(fakeBrowser1).mockResolvedValueOnce(fakeBrowser2);

    await launchChromium("/fake/chrome");
    launchMock.mockClear();
    await launchChromium("/fake/chrome");

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock.mock.calls[0][0].args).not.toContain("--no-sandbox");
  });
});
