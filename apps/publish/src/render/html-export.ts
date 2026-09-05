import { install, computeExecutablePath, resolveBuildId, getInstalledBrowsers, Browser, BrowserPlatform, detectBrowserPlatform } from "@puppeteer/browsers";
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export function chromiumCachePath(): string {
  return process.env.KONTEXTA_CHROMIUM_CACHE ?? join(homedir() || tmpdir(), ".cache", "kontexta", "chromium");
}

function cacheDir(): string {
  const dir = chromiumCachePath();
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Memoized in-flight promise: makes concurrent calls within a process share one install instead of racing to write the same archive, and skips the network round-trip entirely once something is cached.
let chromiumPromise: Promise<{ executablePath: string; installed: boolean }> | undefined;

export function ensureChromium(): Promise<{ executablePath: string; installed: boolean }> {
  if (!chromiumPromise) {
    chromiumPromise = ensureChromiumUncached().catch((err) => {
      chromiumPromise = undefined;
      throw err;
    });
  }
  return chromiumPromise;
}

async function ensureChromiumUncached(): Promise<{ executablePath: string; installed: boolean }> {
  const cache = cacheDir();
  const installed = await getInstalledBrowsers({ cacheDir: cache });
  const found = installed.find((b) => b.browser === Browser.CHROMIUM && existsSync(b.executablePath));
  if (found) return { executablePath: found.executablePath, installed: false };
  const platform = detectBrowserPlatform() ?? BrowserPlatform.LINUX;
  const buildId = await resolveBuildId(Browser.CHROMIUM, platform, "latest");
  const exec = computeExecutablePath({ browser: Browser.CHROMIUM, buildId, cacheDir: cache });
  await install({ browser: Browser.CHROMIUM, buildId, cacheDir: cache });
  return { executablePath: exec, installed: true };
}

// Chromium's own sandbox needs unprivileged user namespaces, which many CI runners (GitHub's ubuntu-latest since Ubuntu 23.10+) and most Docker containers disable by default.
const NO_SANDBOX_ARG = "--no-sandbox";

// Memoized per-process: a failed sandboxed launch attempt is expensive (Chromium spawns, crashes, and crashpad dumps a full stack trace to disk before Puppeteer detects the exit) — discovering "this environment needs --no-sandbox" once and reusing that for every subsequent render avoids paying that tax on every single call, which was slow enough to blow past page.goto's own 30s navigation timeout on the second render.
let needsNoSandbox: boolean | undefined;

/** Test-only: clears the memoized sandbox-capability discovery between test cases. */
export function resetChromiumSandboxMemo(): void {
  needsNoSandbox = undefined;
}

export async function launchChromium(executablePath: string): Promise<any> {
  // --disable-dev-shm-usage: CI/Docker's /dev/shm is often tiny (64MB default), which starves the renderer under memory pressure and hangs page loads instead of cleanly failing — always safe, since it just makes Chrome use /tmp instead.
  const baseArgs = ["--disable-gpu", "--disable-dev-shm-usage"];
  const forceNoSandbox = process.env.KONTEXTA_CHROMIUM_NO_SANDBOX === "1";
  if (needsNoSandbox === true || forceNoSandbox) {
    return await puppeteer.launch({ executablePath, args: [...baseArgs, NO_SANDBOX_ARG] });
  }
  try {
    const browser = await puppeteer.launch({ executablePath, args: baseArgs });
    needsNoSandbox = false;
    return browser;
  } catch (err) {
    console.warn("[kxta-publish] Chromium launch failed with its sandbox enabled — retrying with --no-sandbox (typical in CI/Docker) and remembering that for the rest of this process.");
    needsNoSandbox = true;
    return await puppeteer.launch({ executablePath, args: [...baseArgs, NO_SANDBOX_ARG] });
  }
}

async function withPage<T>(html: string, opts: { assetsDir?: string }, fn: (page: any) => Promise<T>): Promise<T> {
  const { executablePath } = await ensureChromium();
  const tmp = mkdtempSync(join(tmpdir(), "kxta-html-"));
  try {
    if (opts.assetsDir && existsSync(opts.assetsDir)) {
      const dst = join(tmp, "resources");
      mkdirSync(dst, { recursive: true });
      const { copyFileSync, readdirSync } = await import("node:fs");
      for (const n of readdirSync(opts.assetsDir)) copyFileSync(join(opts.assetsDir, n), join(dst, n));
    }
    const file = join(tmp, "index.html");
    const wrapped = `<!doctype html><html><head><meta charset="utf-8"><base href="./"></head><body>${html}</body></html>`;
    writeFileSync(file, wrapped, "utf8");
    const browser = await launchChromium(executablePath);
    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (r: any) => {
        if (r.url().startsWith("file://")) r.continue();
        else r.abort();
      });
      // "load" (not "networkidle0"): our content is sanitizer-stripped of scripts, so nothing loads asynchronously after resources finish — "load" waits for images too, without networkidle0's flaky reliance on Chromium's background connection count ever reaching zero, which can hang indefinitely in network-restricted CI/containers.
      await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
      return await fn(page);
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function renderHtmlToPdf(html: string, opts: { assetsDir?: string }): Promise<Buffer> {
  return withPage(html, opts, async (page) => Buffer.from(await page.pdf({ format: "A4", printBackground: true, margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" } })));
}

export async function renderHtmlToPng(html: string, opts: { assetsDir?: string; width?: number }): Promise<Buffer> {
  return withPage(html, opts, async (page) => {
    await page.setViewport({ width: opts.width ?? 1024, height: 768, deviceScaleFactor: 2 });
    return Buffer.from(await page.screenshot({ type: "png", fullPage: true }));
  });
}
