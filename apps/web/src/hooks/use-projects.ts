"use client";

import { useState, useEffect } from "react";

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

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/projects");
      if (response.ok) {
        const data = await response.json();
        setProjects(data);
      }
    } catch (error) {
      console.error("Failed to fetch projects:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  return {
    projects,
    loading,
    refresh: fetchProjects,
  };
}
