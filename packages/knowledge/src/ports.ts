import type {
  CanvasBranchContext, ChatSessionSummary, ContextCapsule, EvidenceRecord,
  ResearchProject, PaperRecord, ProjectItem, ProjectItemKind, ResourceUri, WikiPageDetail,
  WikiPageSummary, WikiSearchResult,
} from "@xiling/contracts";

export interface ProjectStore {
  listProjects(): ResearchProject[];
  getProject(id: string): ResearchProject | undefined;
  createProject(input: { id?: string; name: string; description: string; researchQuestion: string; domainIds: string[] }): ResearchProject;
  updateProject(id: string, patch: Partial<Pick<ResearchProject, "name" | "description" | "researchQuestion" | "domainIds" | "status">>): ResearchProject | undefined;
}
export interface ProjectItemStore {
  listItems(projectId: string): ProjectItem[];
  createItem(projectId: string, input: { kind: ProjectItemKind; title: string; notes: string }): ProjectItem;
  updateItem(id: string, patch: Partial<Pick<ProjectItem, "title" | "notes" | "status">>): ProjectItem | undefined;
  deleteItem(id: string): boolean;
}
export interface ConversationStore {
  listChatSessions(projectId: string): ChatSessionSummary[];
  createChatSession(projectId: string, title: string): ChatSessionSummary;
  getChatSession(id: string): ChatSessionSummary | undefined;
  archiveChatSession(id: string): boolean;
  getChatSessionContext(sessionId: string): CanvasBranchContext | undefined;
  setChatSessionContext(sessionId: string, context: Omit<CanvasBranchContext, "updatedAt">): CanvasBranchContext;
}
export interface ContextCapsuleStore {
  listContextCapsules(projectId: string): ContextCapsule[];
  upsertContextCapsule(projectId: string, capsule: ContextCapsule): ContextCapsule;
  pruneContextCapsules(projectId: string, validNodeIds: string[]): number;
}
export interface WikiStore {
  listWikiPages(projectId?: string): WikiPageSummary[];
  searchWikiPages(projectId: string, query: string, limit?: number): WikiSearchResult[];
  createWikiPage(input: { projectId?: string; title: string; markdown: string; artifactUris?: ResourceUri[] }): WikiPageDetail;
  getWikiPage(id: string): WikiPageDetail | undefined;
  reviseWikiPage(id: string, input: { markdown: string; artifactUris?: ResourceUri[]; title?: string }): WikiPageDetail | undefined;
  restoreWikiRevision(id: string, version: number): WikiPageDetail | undefined;
  archiveWikiPage(id: string): boolean;
}
export interface EvidenceStore {
  saveEvidence(projectId: string, paper: PaperRecord, note?: string, stance?: EvidenceRecord["stance"], confidence?: number, source?: Pick<EvidenceRecord, "sourceQuote" | "sourceLocator" | "limitations" | "claimRevisionId">): EvidenceRecord;
  listEvidence(projectId?: string): EvidenceRecord[];
}
export interface ResearchProjectionOutboxRecord {
  id: string;
  projectionKey: string;
  projectId: string;
  sourceId: string;
  eventType: "knowledge.project.upserted" | "knowledge.wiki.revision.created" | "knowledge.evidence.saved" | "knowledge.science.artifacts.registered";
  payload: unknown;
  createdAt: string;
  appliedAt?: string;
}
export interface ResearchProjectionOutboxStore {
  listProjectionOutbox(limit?: number): ResearchProjectionOutboxRecord[];
  markProjectionOutboxApplied(projectionKeys: string[], appliedAt?: string): number;
}
export type KnowledgeStore = ProjectStore & ProjectItemStore & ConversationStore & ContextCapsuleStore & WikiStore & EvidenceStore & ResearchProjectionOutboxStore;
export type AgentKnowledgeReader = ProjectItemStore & Pick<WikiStore, "listWikiPages" | "getWikiPage"> & Pick<EvidenceStore, "listEvidence">;
