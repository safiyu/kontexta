"use client";

import { useState, useEffect } from "react";

export function useFolders(projectId: number | null, refreshKey: number = 0) {
  const [folders, setFolders] = useState<string[]>([]);
  const [basePath, setBasePath] = useState<string>("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setFolders([]);
    setBasePath("");
    // Guard against a stale response overwriting fresh state when
    // refreshKey is bumped twice quickly.
    let cancelled = false;
    const ac = new AbortController();
    async function fetchFolders() {
      setLoading(true);
      try {
        const url = projectId ? `/api/folders?projectId=${projectId}` : "/api/folders";
        const response = await fetch(url, { signal: ac.signal });
        if (cancelled) return;
        if (response.ok) {
          const data = await response.json();
          if (cancelled) return;
          setFolders(data.folders);
          setBasePath(data.basePath);
        }
      } catch (error: any) {
        if (error?.name === "AbortError") return;
        console.error("Failed to fetch folders:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchFolders();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [projectId, refreshKey]);

  return { folders, basePath, loading };
}
