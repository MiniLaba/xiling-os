// 科研窗口的共享作用域：项目按窗口显式绑定，绑定事实在核心进程的注册表里。
//
// 渲染器不做授权判断：这里只负责"把窗口 ID 带上，让核心进程决定这个窗口能读写哪个项目"。
// 因此 components 不再持有全局选中项目，也不把 projectId 当权限。

import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchProject } from "@xiling/contracts";

export interface ScopeBindingView {
  windowId: string;
  projectId: string;
  boundAt: string;
}

export interface ResearchScopeApi {
  ready: boolean;
  error: string;
  busy: boolean;
  projects: ResearchProject[];
  binding?: ScopeBindingView | undefined;
  /** 已绑定项目；未绑定时为空串。 */
  projectId: string;
  project?: ResearchProject | undefined;
  selectProject: (projectId: string) => Promise<void>;
  createProject: (name: string, researchQuestion: string) => Promise<void>;
  unbind: () => Promise<void>;
  /** 调用统一科研服务；自动携带 windowId，projectId 由核心进程按绑定解析。 */
  run: <T = Record<string, unknown>>(action: string, extra?: Record<string, unknown>) => Promise<T>;
  describeError: (reason: unknown) => string;
}

export function useResearchScope(windowId: string): ResearchScopeApi {
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [binding, setBinding] = useState<ScopeBindingView | undefined>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const describeError = useCallback((reason: unknown) => (reason instanceof Error ? reason.message : String(reason)), []);

  const bridge = () => {
    const value = window.xilingDesktop;
    if (!value) throw new Error("请使用原生科研 OS：桌面网桥未就绪");
    return value;
  };

  const run = useCallback(async <T,>(action: string, extra: Record<string, unknown> = {}): Promise<T> => {
    const result = await bridge().researchKnowledge({ action, windowId, ...extra });
    return result as T;
  }, [windowId]);

  const load = useCallback(async () => {
    setError("");
    try {
      const listed = await bridge().researchKnowledge({ action: "projects.list" });
      if (!alive.current) return;
      setProjects(listed.projects ?? []);
      const status = await bridge().researchKnowledge({ action: "scope.status", windowId });
      if (!alive.current) return;
      setBinding(status.binding ?? undefined);
    } catch (reason) {
      if (alive.current) setError(describeError(reason));
    } finally {
      if (alive.current) setReady(true);
    }
  }, [describeError, windowId]);

  useEffect(() => { void load(); }, [load]);

  const selectProject = useCallback(async (nextProjectId: string) => {
    setBusy(true); setError("");
    try {
      // confirm: 显式用户操作；核心进程仍会校验项目是否存在
      const result = await bridge().researchKnowledge({ action: "scope.bind", windowId, projectId: nextProjectId, confirm: true });
      if (alive.current) setBinding(result.binding ?? undefined);
    } catch (reason) {
      if (alive.current) setError(describeError(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [describeError, windowId]);

  const createProject = useCallback(async (name: string, researchQuestion: string) => {
    setBusy(true); setError("");
    try {
      const created = await bridge().researchKnowledge({ action: "projects.create", name, researchQuestion });
      if (!alive.current) return;
      setProjects(created.projects ?? []);
      const match = (created.projects ?? []).find((project) => project.name === name.trim());
      if (match) {
        const bound = await bridge().researchKnowledge({ action: "scope.bind", windowId, projectId: match.id, confirm: true });
        if (alive.current) setBinding(bound.binding ?? undefined);
      }
    } catch (reason) {
      if (alive.current) setError(describeError(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [describeError, windowId]);

  const unbind = useCallback(async () => {
    setBusy(true);
    try {
      await bridge().researchKnowledge({ action: "scope.unbind", windowId });
      if (alive.current) setBinding(undefined);
    } catch (reason) {
      if (alive.current) setError(describeError(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [describeError, windowId]);

  const projectId = binding?.projectId ?? "";
  return {
    ready, error, busy, projects,
    ...(binding === undefined ? {} : { binding }),
    projectId,
    ...(projects.find((project) => project.id === projectId) === undefined ? {} : { project: projects.find((project) => project.id === projectId) }),
    selectProject, createProject, unbind, run, describeError,
  };
}

/** 未绑定项目时所有科研窗口共用的入口：选一个已有项目，或新建（必须带研究问题）。 */
export function ResearchScopeGate({ api, children }: { api: ResearchScopeApi; children: React.ReactNode }) {
  const [name, setName] = useState("");
  const [question, setQuestion] = useState("");
  if (!api.ready) return <p className="research-window-status">正在读取项目…</p>;
  if (api.binding && api.projectId) {
    return (
      <>
        <div className="research-window-scope">
          <label>所属项目
            <select aria-label="本窗口所属项目" value={api.projectId} disabled={api.busy} onChange={(event) => void api.selectProject(event.target.value)}>
              {api.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <span className="research-window-question">{api.project?.researchQuestion ?? ""}</span>
          {api.error ? <span role="alert" className="research-window-error">{api.error}</span> : null}
        </div>
        {children}
      </>
    );
  }
  return <div className="research-window-gate">
    <h3>先为这个窗口选定科研项目</h3>
    <p>项目作用域按窗口绑定：选中的项目决定这个窗口能读写哪些事项、Wiki 与证据，跨项目访问会被拒绝。文件夹只是工作区，不等于项目。</p>
    <label>已有项目<select aria-label="选择项目" value="" disabled={api.busy} onChange={(event) => { if (event.target.value) void api.selectProject(event.target.value); }}>
      <option value="">{api.projects.length ? "选择项目…" : "还没有项目"}</option>
      {api.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select></label>
    <form onSubmit={(event) => { event.preventDefault(); void api.createProject(name, question); }}>
      <label>项目名称<input aria-label="项目名称" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>核心研究问题<input aria-label="核心研究问题" maxLength={2000} value={question} onChange={(event) => setQuestion(event.target.value)} /></label>
      <p className="research-window-hint">科研项目必须声明研究问题：科研图谱会为它建立"研究问题"节点，空问题会让关系投影整批失败。</p>
      <button type="submit" disabled={api.busy || !name.trim() || !question.trim()}>创建并绑定</button>
    </form>
    {api.error ? <p role="alert" className="research-window-error">{api.error}</p> : null}
  </div>;
}
