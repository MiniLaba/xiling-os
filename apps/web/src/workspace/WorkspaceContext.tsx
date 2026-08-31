import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { FREE_EXPLORATION_PROJECT_ID, type ResearchProject } from "@xiling/contracts";

type WorkspaceState = {
  projects: ResearchProject[];
  activeProject?: ResearchProject;
  activeProjectId: string;
  setActiveProjectId: (id: string) => void;
  refreshProjects: (preferredId?: string) => Promise<void>;
  loading: boolean;
  error?: string;
};

const WorkspaceContext = createContext<WorkspaceState | undefined>(undefined);
const storageKey = "xiling.activeProjectId";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState(() => localStorage.getItem(storageKey) ?? FREE_EXPLORATION_PROJECT_ID);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const setActiveProjectId = useCallback((id: string) => {
    setActiveProjectIdState(id);
    localStorage.setItem(storageKey, id);
  }, []);

  const refreshProjects = useCallback(async (preferredId?: string) => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/projects");
      if (!response.ok) throw new Error(`项目加载失败：${response.status}`);
      const all = await response.json() as ResearchProject[];
      const visible = all.filter((project) => project.status !== "archived");
      setProjects(visible);
      const requested = preferredId ?? activeProjectId;
      const next = visible.find((project) => project.id === requested)?.id ?? visible[0]?.id ?? "";
      if (next && next !== activeProjectId) setActiveProjectId(next);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, [activeProjectId, setActiveProjectId]);

  useEffect(() => { void refreshProjects(); }, []);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const value = useMemo<WorkspaceState>(() => ({ projects, ...(activeProject ? { activeProject } : {}), activeProjectId, setActiveProjectId, refreshProjects, loading, ...(error ? { error } : {}) }), [projects, activeProject, activeProjectId, setActiveProjectId, refreshProjects, loading, error]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}
