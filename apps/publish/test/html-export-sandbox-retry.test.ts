import { describe, it, expect, vi, beforeEach } from "vitest";

const launchMock = vi.fn();
vi.mock("puppeteer-core", () => ({
  default: { launch: (...args: any[]) => launchMock(...args) },
}));

const { launchChromium } = await import("../src/render/html-export.js");

describe("launchChromium sandbox retry", () => {
  beforeEach(() => {
    launchMock.mockReset();
    delete process.env.KONTEXTA_CHROMIUM_NO_SANDBOX;
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
});
