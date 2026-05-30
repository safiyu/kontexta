"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface File {
  id: number;
  path: string;
  project_id: number;
  title: string;
  content: string;
  storage_type: "db" | "git";
  tags: string[] | null;
  favorite: boolean;
  folder: string | null;
  created_at: string;
  updated_at: string;
}

interface UseFilesOptions {
  project_id?: number | null;
  tag?: string;
  favorite?: boolean;
  folder?: string;
}

interface UseFilesReturn {
  files: File[];
  loading: boolean;
  refresh: () => void;
}

export function useFiles(options: UseFilesOptions = {}): UseFilesReturn {
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);

  // Capture filters in a ref so refresh() always sees the latest values
  // without forcing the caller to memoize the options object.
  const optsRef = useRef(options);
  optsRef.current = options;

  // Sequence + abort controller guard against races: a slower earlier
  // response must not clobber a fresher later one.
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchFiles = useCallback(async () => {
    const o = optsRef.current;
    const mySeq = ++seqRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (o.project_id !== undefined) {
        params.append("project_id", o.project_id === null ? "none" : o.project_id.toString());
      }
      if (o.tag) params.append("tag", o.tag);
      if (o.favorite !== undefined) params.append("favorite", o.favorite.toString());
      if (o.folder) params.append("folder", o.folder);

      const url = `/api/files${params.toString() ? `?${params.toString()}` : ""}`;
      const response = await fetch(url, { signal: ac.signal });

      if (mySeq !== seqRef.current) return; // a newer request started

      if (response.ok) {
        const data = await response.json();
        if (mySeq !== seqRef.current) return;
        setFiles(data);
      }
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      console.error("Failed to fetch files:", error);
    } finally {
      if (mySeq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setFiles([]);
    fetchFiles();
    return () => abortRef.current?.abort();
  }, [options.project_id, options.tag, options.favorite, options.folder, fetchFiles]);

  return {
    files,
    loading,
    refresh: fetchFiles,
  };
}
