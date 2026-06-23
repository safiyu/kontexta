"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface Project {
  id: number;
  name: string;
  path: string;
  remote_url: string | null;
  created_at: string;
  has_hands?: boolean;
}

interface UseProjectsReturn {
  projects: Project[];
  loading: boolean;
  refresh: () => void;
}

export function useProjects(): UseProjectsReturn {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  // Monotonic sequence so out-of-order responses don't clobber newer data.
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const mySeq = ++seqRef.current;
    try {
      setLoading(true);
      const response = await fetch("/api/projects");
      if (response.ok) {
        const data = await response.json();
        if (mySeq !== seqRef.current) return;
        setProjects(data);
      }
    } catch (error) {
      console.error("Failed to fetch projects:", error);
    } finally {
      if (mySeq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { projects, loading, refresh };
}
