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

// Chromium's own sandbox needs unprivileged user namespaces, which many CI runners (GitHub's ubuntu-latest since Ubuntu 23.10+) and most Docker containers disable by default — retrying once with --no-sandbox after a launch failure covers both without requiring per-environment configuration.
export async function launchChromium(executablePath: string): Promise<any> {
  const baseArgs = ["--disable-gpu"];
  const forceNoSandbox = process.env.KONTEXTA_CHROMIUM_NO_SANDBOX === "1";
  try {
    return await puppeteer.launch({ executablePath, args: forceNoSandbox ? [...baseArgs, "--no-sandbox"] : baseArgs });
  } catch (err) {
    if (forceNoSandbox) throw err;
    console.warn("[kxta-publish] Chromium launch failed with its sandbox enabled — retrying with --no-sandbox (typical in CI/Docker; set KONTEXTA_CHROMIUM_NO_SANDBOX=1 to skip the first attempt).");
    return await puppeteer.launch({ executablePath, args: [...baseArgs, "--no-sandbox"] });
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
      await page.goto(pathToFileURL(file).href, { waitUntil: "networkidle0" });
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
