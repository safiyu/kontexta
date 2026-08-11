import { NextResponse } from "next/server";
import { currentVersion } from "@/lib/app-version";

const CACHE_MS = 60 * 60 * 1000; // re-check the registry at most once an hour
let cache: { latest: string; fetchedAt: number } | null = null;

// Simple x.y.z comparison — this repo only ever publishes bare semver.
function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

async function fetchLatestVersion(): Promise<string | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.latest;
  try {
    const res = await fetch("https://registry.npmjs.org/kontexta/latest", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return cache?.latest ?? null;
    const data = await res.json();
    const latest = String(data.version);
    cache = { latest, fetchedAt: Date.now() };
    return latest;
  } catch {
    return cache?.latest ?? null; // offline / registry unreachable — never block the page on this
  }
}

export async function GET() {
  const current = currentVersion();
  const latest = await fetchLatestVersion();
  return NextResponse.json({
    currentVersion: current,
    latestVersion: latest,
    updateAvailable: latest ? isNewer(latest, current) : false,
  });
}
