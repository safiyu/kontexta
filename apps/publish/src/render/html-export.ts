import { install, computeExecutablePath, resolveBuildId, Browser, BrowserPlatform, detectBrowserPlatform } from "@puppeteer/browsers";
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

function cacheDir(): string {
  const dir = process.env.KONTEXTA_CHROMIUM_CACHE ?? join(process.env.HOME ?? tmpdir(), ".cache", "kontexta", "chromium");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function ensureChromium(): Promise<{ executablePath: string; installed: boolean }> {
  const cache = cacheDir();
  const platform = detectBrowserPlatform() ?? BrowserPlatform.LINUX;
  const buildId = await resolveBuildId(Browser.CHROMIUM, platform, "latest");
  const exec = computeExecutablePath({ browser: Browser.CHROMIUM, buildId, cacheDir: cache });
  if (existsSync(exec)) return { executablePath: exec, installed: false };
  await install({ browser: Browser.CHROMIUM, buildId, cacheDir: cache });
  return { executablePath: exec, installed: true };
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
    const browser = await puppeteer.launch({ executablePath, args: ["--no-sandbox", "--disable-gpu"] });
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
