import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatSessionSummary } from "@xiling/contracts";
import { useWorkspace } from "./WorkspaceContext.js";

type ConversationState = {
  sessions: ChatSessionSummary[];
  activeSessionId: string;
  loading: boolean;
  selectSession: (id: string) => void;
  startNewConversation: () => void;
  createConversation: (firstPrompt: string) => Promise<ChatSessionSummary>;
  ensureSession: (firstPrompt: string) => Promise<ChatSessionSummary>;
  deleteSession: (id: string) => Promise<void>;
  refreshSessions: (preferredId?: string) => Promise<void>;
};

const ConversationContext = createContext<ConversationState | undefined>(undefined);
const sessionStorageKey = (projectId: string) => `xiling.activeSession.${projectId}`;
const titleFromPrompt = (prompt: string) => {
  const title = prompt.trim().replace(/\s+/g, " ");
  return title.length > 34 ? `${title.slice(0, 34)}…` : title || "新对话";
};

export function ConversationProvider({ children }: { children: ReactNode }) {
  const { activeProjectId } = useWorkspace();
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [selectedByProject, setSelectedByProject] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const activeSessionId = selectedByProject[activeProjectId] ?? "";

  const rememberSelection = useCallback((projectId: string, id: string) => {
    setSelectedByProject((current) => ({ ...current, [projectId]: id }));
    if (id) localStorage.setItem(sessionStorageKey(projectId), id);
    else localStorage.removeItem(sessionStorageKey(projectId));
  }, []);

  const refreshSessions = useCallback(async (preferredId?: string) => {
    if (!activeProjectId) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/gate4/chat-sessions?projectId=${encodeURIComponent(activeProjectId)}`);
      if (!response.ok) throw new Error(`会话加载失败：${response.status}`);
      const next = await response.json() as ChatSessionSummary[];
      setSessions(next);
      const remembered = preferredId ?? selectedByProject[activeProjectId] ?? localStorage.getItem(sessionStorageKey(activeProjectId)) ?? "";
      const valid = next.some((session) => session.id === remembered) ? remembered : next[0]?.id ?? "";
      rememberSelection(activeProjectId, valid);
    } finally { setLoading(false); }
  }, [activeProjectId, rememberSelection, selectedByProject]);

  useEffect(() => { void refreshSessions(); }, [activeProjectId]);

  const selectSession = useCallback((id: string) => rememberSelection(activeProjectId, id), [activeProjectId, rememberSelection]);
  const startNewConversation = useCallback(() => rememberSelection(activeProjectId, ""), [activeProjectId, rememberSelection]);
  const createConversation = useCallback(async (firstPrompt: string) => {
    const response = await fetch("/api/gate4/chat-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: activeProjectId, title: titleFromPrompt(firstPrompt) }),
    });
    if (!response.ok) throw new Error(`新建会话失败：${response.status}`);
    const created = await response.json() as ChatSessionSummary;
    setSessions((currentSessions) => [created, ...currentSessions]);
    rememberSelection(activeProjectId, created.id);
    return created;
  }, [activeProjectId, rememberSelection]);
  const ensureSession = useCallback(async (firstPrompt: string) => {
    const currentId = selectedByProject[activeProjectId] ?? "";
    const current = sessions.find((session) => session.id === currentId);
    return current ?? createConversation(firstPrompt);
  }, [activeProjectId, createConversation, selectedByProject, sessions]);
  const deleteSession = useCallback(async (id: string) => {
    const response = await fetch(`/api/gate4/chat-sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`删除会话失败：${response.status}`);
    setSelectedByProject((current) => {
      const next = { ...current };
      if (next[activeProjectId] === id) { delete next[activeProjectId]; localStorage.removeItem(sessionStorageKey(activeProjectId)); }
      return next;
    });
    await refreshSessions();
  }, [activeProjectId, refreshSessions]);

  const value = useMemo<ConversationState>(() => ({ sessions, activeSessionId, loading, selectSession, startNewConversation, createConversation, ensureSession, deleteSession, refreshSessions }), [sessions, activeSessionId, loading, selectSession, startNewConversation, createConversation, ensureSession, deleteSession, refreshSessions]);
  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

export function useConversations(): ConversationState {
  const value = useContext(ConversationContext);
  if (!value) throw new Error("useConversations must be used inside ConversationProvider");
  return value;
}
