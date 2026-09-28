import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { CredentialProviderId, CredentialProviderStatus, InstalledSkillSummary, InstalledSkillsResponse, McpSettingsResponse, ModelCatalogEntry, ModelProviderId, ModelRouteSettings, ModelRuntimeStatus, ProviderConnectionTestResult } from "@xiling/contracts";
import { Moon, Sun } from "lucide-react";
import { ApiError, apiJson, jsonInit } from "../lib/api-client.js";
import { useTheme } from "../lib/theme.js";
import { useLocale } from "../lib/locale.js";
import { McpSettingsPanel } from "./McpSettingsPanel.js";
import { useWorkspace } from "../workspace/WorkspaceContext.js";
const ProjectView = lazy(async () => ({ default: (await import("../project/ProjectView.js")).ProjectView }));
import { ModelCapsule, type CapsuleReasoning, type CapsuleRoute } from "../components/ModelCapsule.js";

export type SettingsSection = "appearance" | "runtime" | "background" | "projects" | "execution" | "skills" | "mcp" | "model-apis" | "literature" | "data";
type ProviderCategory = CredentialProviderStatus["category"];
type InstalledAgentRole = { id: string; title: string; description: string; allowedCapabilities: string[]; defaultIsolation: "scoped" | "blind" | "execution"; dynamic?: boolean };
type RouteDraft = { providerId?: ModelProviderId; modelId: string; reasoning: ModelRouteSettings["reasoning"] };

const sections: Array<{ label: string; items: Array<{ id: SettingsSection; label: string; icon: string }> }> = [
  { label: "常规", items: [{ id: "appearance", label: "主题", icon: "◐" }] },
  { label: "智能体", items: [{ id: "runtime", label: "模型选择", icon: "◎" }, { id: "background", label: "后台运行", icon: "◷" }, { id: "execution", label: "执行目标", icon: "▷" }, { id: "skills", label: "技能", icon: "✦" }, { id: "mcp", label: "MCP", icon: "⌘" }] },
  { label: "项目", items: [{ id: "projects", label: "项目管理", icon: "▣" }] },
  { label: "连接", items: [{ id: "model-apis", label: "模型 API 连接", icon: "⌁" }, { id: "literature", label: "文献服务", icon: "⌕" }, { id: "data", label: "科研数据账户", icon: "≈" }] },
];

const sectionTitle: Record<SettingsSection, string> = {
  appearance: "主题", runtime: "模型选择", background: "后台运行", projects: "项目管理", execution: "执行目标", skills: "技能", mcp: "MCP", "model-apis": "模型 API 连接", literature: "文献服务", data: "科研数据账户",
};

const skillPresentation: Record<string, { title: string; glyph: string }> = {
  "artifact-inspection": { title: "科研产物检查", glyph: "图" },
  "literature-evidence": { title: "文献证据", glyph: "文" },
  "project-wiki-navigation": { title: "项目 Wiki 导航", glyph: "知" },
  "ocean-data-subsetting": { title: "海洋数据切片", glyph: "数" },
};

export function SettingsView({ initialSection = "appearance" }: { initialSection?: SettingsSection }) {
  const { locale, setLocale, t } = useLocale();
  const { projects, activeProjectId, setActiveProjectId, refreshProjects } = useWorkspace();
  const theme = useTheme();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  useEffect(() => { setSection(initialSection); }, [initialSection]);
  const [providers, setProviders] = useState<CredentialProviderStatus[]>([]);
  const [values, setValues] = useState<Partial<Record<CredentialProviderId, Record<string, string>>>>({});
  const [busy, setBusy] = useState<CredentialProviderId>();
  const [message, setMessage] = useState("");
  const [confirmClear, setConfirmClear] = useState<CredentialProviderId>();
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [runtime, setRuntime] = useState<ModelRuntimeStatus>();
  const [testResults, setTestResults] = useState<Partial<Record<CredentialProviderId, ProviderConnectionTestResult>>>({});
  const [skills, setSkills] = useState<InstalledSkillsResponse>();
  const [mcp, setMcp] = useState<McpSettingsResponse>();
  const [skillQuery, setSkillQuery] = useState("");
  const [agentRoles, setAgentRoles] = useState<InstalledAgentRole[]>([]);
  const [selection, setSelection] = useState<"manual" | "auto">("manual");
  const [autoProviders, setAutoProviders] = useState<ModelProviderId[]>([]);
  const [costCapUsd, setCostCapUsd] = useState(1);
  const [backgroundEnabled, setBackgroundEnabled] = useState(false);
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(18);
  const [taskBudgetUsd, setTaskBudgetUsd] = useState(2);
  const [reminder, setReminder] = useState<"none" | "desktop">("none");
  const [executionTarget, setExecutionTarget] = useState<"local" | "ssh" | "vm">("vm");
  const [sshHost, setSshHost] = useState("");

  const refresh = async () => {
    try {
      const [nextProviders, models, nextSkills, nextMcp, nextAgentRoles] = await Promise.all([
        apiJson<CredentialProviderStatus[]>("/api/settings/providers"),
        apiJson<{ catalog: ModelCatalogEntry[]; runtime: ModelRuntimeStatus }>("/api/settings/models"),
        apiJson<InstalledSkillsResponse>("/api/settings/skills"),
        apiJson<McpSettingsResponse>("/api/settings/mcp"),
        apiJson<{ roles: InstalledAgentRole[] }>("/api/agent-center/roles"),
      ]);
      setProviders(nextProviders); setCatalog(models.catalog); setRuntime(models.runtime); setSkills(nextSkills); setMcp(nextMcp); setAgentRoles(nextAgentRoles.roles);
      setSelection(models.runtime.selection ?? "manual");
      setAutoProviders(models.runtime.autoProviders ?? []);
      setCostCapUsd(models.runtime.costCapUsd ?? 1);
      setBackgroundEnabled(Boolean(models.runtime.background?.enabled));
      setStartHour(models.runtime.background?.startHour ?? 9);
      setEndHour(models.runtime.background?.endHour ?? 18);
      setTaskBudgetUsd(models.runtime.background?.taskBudgetUsd ?? 2);
      setReminder(models.runtime.background?.reminder ?? "none");
      setExecutionTarget(models.runtime.execution?.target ?? "vm");
      setSshHost(models.runtime.execution?.sshHost ?? "");
    } catch (error) { setMessage(error instanceof Error ? `设置加载失败：${error.message}` : "设置加载失败。"); }
  };
  useEffect(() => { void refresh(); }, []);

  const save = async (provider: CredentialProviderStatus) => {
    const providerValues = values[provider.id] ?? {};
    if (Object.values(providerValues).every((value) => !value)) { setMessage("请至少填写一项凭据。"); return; }
    setBusy(provider.id); setMessage("");
    try {
      await apiJson(`/api/settings/providers/${provider.id}`, jsonInit("PUT", { values: providerValues }));
      setValues((current) => ({ ...current, [provider.id]: {} })); setMessage(`${provider.title} 已安全保存；密钥值不会再次显示。`); await refresh();
    } catch (error) { setMessage(`保存失败：${error instanceof ApiError ? "请检查必填字段" : error instanceof Error ? error.message : "未知错误"}`); }
    finally { setBusy(undefined); }
  };
  const clear = async (provider: CredentialProviderStatus) => {
    if (confirmClear !== provider.id) { setConfirmClear(provider.id); setMessage(`再次点击“确认清除”将删除 ${provider.title} 的本地凭据。`); return; }
    setBusy(provider.id);
    try { await apiJson(`/api/settings/providers/${provider.id}`, jsonInit("DELETE")); setMessage(`${provider.title} 本地凭据已清除。`); await refresh(); }
    catch { setMessage("清除失败。"); }
    finally { setBusy(undefined); setConfirmClear(undefined); }
  };
  const testConnection = async (provider: CredentialProviderStatus) => {
    setBusy(provider.id); setMessage(`${provider.title} 正在执行最短文字连通测试…`);
    const candidateModel = runtime?.primary && runtime.primary.providerId === provider.id ? runtime.primary.modelId : undefined;
    const runTest = (payload: Record<string, string>) => apiJson<ProviderConnectionTestResult>(`/api/settings/providers/${provider.id}/test`, jsonInit("POST", payload));
    try {
      const body = await runTest(candidateModel ? { modelId: candidateModel } : {});
      setTestResults((current) => ({ ...current, [provider.id]: body })); setMessage(`${provider.title} 连接成功，延迟 ${body.latencyMs} ms。`);
    } catch (error) {
      const body = error instanceof ApiError ? error.body as { message?: string } : undefined;
      const detail = body?.message ?? "请检查密钥、Base URL 和模型 ID";
      if (!candidateModel || !/区域|region/i.test(detail)) { setMessage(`${provider.title} 连接失败：${detail}`); }
      else {
        // 区域限制在密钥校验前生效：再用默认（区域可用）模型测一次，把"服务连通性"与"所选模型可用性"分开呈现
        try {
          const fallback = await runTest({});
          setMessage(`${provider.title} 连接失败：模型 ${candidateModel} 在当前区域不可用，但服务本身连通正常（默认模型 ${fallback.modelId} 测试成功）。请在"模型分配"中改用 DeepSeek、Kimi、Qwen 等本区域可用模型。`);
        } catch (fallbackError) {
          const fallbackBody = fallbackError instanceof ApiError ? fallbackError.body as { message?: string } : undefined;
          setMessage(`${provider.title} 连接失败：${detail}（改用默认模型重试：${fallbackBody?.message ?? "仍然失败"}）`);
        }
      }
    } finally { setBusy(undefined); }
  };
  const visibleSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase();
    if (!query) return skills?.skills ?? [];
    return (skills?.skills ?? []).filter((skill) => [skill.name, skill.description, ...skill.keywords, ...skill.capabilities.flatMap((item) => [item.id, item.description, item.toolName])].some((item) => item.toLocaleLowerCase().includes(query)));
  }, [skillQuery, skills]);

  const renderProviderCategory = (category: ProviderCategory) => {
    const items = providers.filter((provider) => provider.category === category);
    const targetSection: SettingsSection = category === "model" ? "model-apis" : category;
    return <section className="provider-section settings-provider-page"><header><div><small>{category.toUpperCase()}</small><h2>{sectionTitle[targetSection]}</h2></div><span>{items.filter((provider) => provider.configured).length}/{items.length} 已配置</span></header><div className="provider-grid">{items.map((provider) => <article className={provider.configured ? "configured" : ""} key={provider.id}>
      <div className="provider-title"><div><i /><h3>{provider.title}</h3></div><span>{provider.configured ? provider.source === "environment" ? "环境变量" : "已加密保存" : "未配置"}</span></div>
      <div className="credential-fields">{provider.fields.map((item) => <label key={item.id}><span>{item.label}{provider.configuredFields.includes(item.id) ? <em> 已配置</em> : null}</span>{item.id === "apiStyle" ? <select aria-label={`${provider.title} ${item.label}`} value={values[provider.id]?.[item.id] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [provider.id]: { ...(current[provider.id] ?? {}), [item.id]: event.target.value } }))}><option value="">{t("选择兼容协议")}</option><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option></select> : <input aria-label={`${provider.title} ${item.label}`} type={item.secret ? "password" : "text"} autoComplete="off" value={values[provider.id]?.[item.id] ?? ""} placeholder={provider.configuredFields.includes(item.id) ? item.secret ? "••••••••（留空则保持）" : "已保存（留空则保持）" : item.placeholder} onChange={(event) => setValues((current) => ({ ...current, [provider.id]: { ...(current[provider.id] ?? {}), [item.id]: event.target.value } }))} />}</label>)}</div>
      {testResults[provider.id] ? <div className={`connection-result ${testResults[provider.id]!.ok ? "ok" : "failed"}`}><b>{testResults[provider.id]!.ok ? "连接正常" : "连接失败"}</b><span>{testResults[provider.id]!.modelId} · {testResults[provider.id]!.latencyMs} ms</span></div> : null}
      <div className="provider-actions"><a href={provider.documentationUrl} target="_blank" rel="noreferrer">官方文档 ↗</a><div>{provider.category === "model" ? <button className="secondary" disabled={!provider.configured || busy === provider.id} onClick={() => void testConnection(provider)}>{busy === provider.id ? "测试中…" : "测试连接"}</button> : null}{provider.configured && provider.source !== "environment" ? <button className="clear" disabled={busy === provider.id} onClick={() => void clear(provider)}>{confirmClear === provider.id ? "确认清除" : "清除本地凭据"}</button> : null}<button disabled={busy === provider.id} onClick={() => void save(provider)}>{busy === provider.id ? "保存中…" : "保存"}</button></div></div>
    </article>)}</div></section>;
  };

  const renderSkills = () => <section className="skills-settings">
    <div className="skills-toolbar"><label><span>⌕</span><input aria-label="搜索已安装 Skills" value={skillQuery} placeholder="搜索能力或工具…" onChange={(event) => setSkillQuery(event.target.value)} /></label><button className="secondary" onClick={() => void refresh()}>{t("刷新目录")}</button></div>
    <div className="skills-grid">{visibleSkills.map((skill: InstalledSkillSummary) => {
      const presentation = skillPresentation[skill.name] ?? { title: skill.name, glyph: "技" };
      return <article className="skill-card" key={skill.name}><header><h3>{locale === "en" ? skill.name : presentation.title}</h3></header><p>{skill.description}</p><section><small>{t("关联能力")}</small><div>{skill.capabilities.map((capability) => <span className="skill-capability" key={capability.id} title={capability.description}><b>{capability.id}</b><em>{capability.toolName}</em></span>)}</div></section></article>;
    })}</div>
    {visibleSkills.length === 0 ? <div className="skills-empty">{locale === "en" ? "No matching skills." : "没有匹配的技能。"}</div> : null}
  </section>;

  const modelProviders = providers.filter((provider) => provider.category === "model" && provider.configured).map((provider) => ({ id: provider.id as ModelProviderId, title: provider.title }));
  const commitRoleRoute = async (roleId: string, route: CapsuleRoute | null) => {
    if (!runtime?.primary) { setMessage("请先在对话发送按钮左侧设置主模型。"); return; }
    type RoleRouteSettings = { providerId: ModelProviderId; modelId: string; reasoning: CapsuleReasoning; inputModalities?: Array<"text" | "image"> };
    const roleRoutes: Record<string, RoleRouteSettings> = Object.fromEntries(Object.entries(runtime.roleRoutes).filter(([id]) => id !== roleId).map(([id, existing]) => [id, { providerId: existing.providerId, modelId: existing.modelId, reasoning: existing.reasoning, inputModalities: (existing.selectedModel?.inputModalities ?? ["text"]).filter((m): m is "text" | "image" => m === "text" || m === "image") }]));
    if (route) {
      const modalities = (catalog.find((model) => model.providerId === route.providerId && model.id === route.modelId)?.inputModalities ?? ["text"]).filter((m): m is "text" | "image" => m === "text" || m === "image");
      roleRoutes[roleId] = { providerId: route.providerId, modelId: route.modelId, reasoning: route.reasoning, inputModalities: modalities };
    }
    try {
      const next = await apiJson<ModelRuntimeStatus>("/api/settings/models", jsonInit("PUT", { primary: { providerId: runtime.primary.providerId, modelId: runtime.primary.modelId, reasoning: runtime.primary.reasoning, inputModalities: runtime.primary.selectedModel?.inputModalities ?? ["text"] }, roleRoutes }));
      setRuntime(next); setMessage(route ? "子智能体模型已保存。" : "已恢复继承主模型。");
    } catch (error) { setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`); }
  };

  const renderAgents = () => <section className="agent-role-settings">
    <div className="agent-role-grid">{agentRoles.map((role) => {
      const route = runtime?.roleRoutes[role.id];
      return <article key={role.id}><header><h3>{locale === "en" ? role.id : role.title}</h3></header><div className="agent-role-capsule"><ModelCapsule compact allowInherit inheritLabel="继承主模型" value={route ? { providerId: route.providerId, modelId: route.modelId, reasoning: route.reasoning } : undefined} catalog={catalog} configuredProviders={modelProviders} disabled={!runtime?.primary} disabledHint="请先在对话发送按钮左侧设置主模型" onCommit={(next) => void commitRoleRoute(role.id, next)} /></div><section><small>{t("允许能力")}</small><div>{role.allowedCapabilities.map((capability) => <span key={capability}>{capability}</span>)}</div></section></article>;
    })}</div>
  </section>;

  const renderAppearance = () => <div className="settings-appearance">
    <section className="appearance-capsule-card language-card">
      <label htmlFor="interface-language">{t("界面语言")}</label>
      <select id="interface-language" value={locale} onChange={(event) => setLocale(event.target.value as "en" | "zh-CN")}><option value="zh-CN">{t("简体中文")}</option><option value="en">English</option></select>
    </section>
    <section className="appearance-capsule-card">
      <div className="theme-capsule" role="radiogroup" aria-label="界面主题">
        <button role="radio" aria-checked={theme.resolved === "lingjing"} className={theme.resolved === "lingjing" ? "active" : ""} onClick={() => theme.setPreference("lingjing")}><Moon size={13} aria-hidden="true" />{t("灵境")}</button>
        <button role="radio" aria-checked={theme.resolved === "poxiao"} className={theme.resolved === "poxiao" ? "active" : ""} onClick={() => theme.setPreference("poxiao")}><Sun size={13} aria-hidden="true" />{t("破晓")}</button>
      </div>
    </section>
  </div>;

  const saveWorkspace = async (patch: Record<string, unknown>) => {
    const next = await apiJson<ModelRuntimeStatus>("/api/settings/workspace", jsonInit("PUT", patch));
    setRuntime(next);
    setMessage("已保存。自动选择只在指定提供商、所需输入模态和费用上限内挑模型；后台只在有未完成任务且处于时段内时继续。");
  };
  const configuredModelIds = providers.filter((provider) => provider.category === "model" && provider.configured).map((provider) => provider.id as ModelProviderId);

  return <div className="settings-view settings-shell">
    <aside className="settings-local-nav"><div><small>SETTINGS</small><strong>{t("汐灵设置")}</strong></div>{sections.map((group) => <section key={group.label}><span>{t(group.label)}</span>{group.items.map((item) => <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => { setSection(item.id); setMessage(""); }}><i>{item.icon}</i>{t(item.label)}</button>)}</section>)}</aside>
    <main className="settings-content"><header className="settings-head"><h1>{t(sectionTitle[section])}</h1>{section === "skills" ? <span>{skills?.skills.length ?? 0} {t("已安装")}</span> : null}</header>{message ? <div className="settings-message" role="status">{message}</div> : null}
      {section === "appearance" ? renderAppearance()
        : section === "runtime" ? <form className="settings-runtime" onSubmit={(event) => { event.preventDefault(); void saveWorkspace({ selection, autoProviders, costCapUsd }); }}><p>手动固定沿用主模型。自动选择只在下面勾选的提供商里挑，并且必须满足本轮输入模态、不超过费用上限。回复会标出实际模型。</p><label>模式<select value={selection} onChange={(event) => setSelection(event.target.value as "manual" | "auto")}><option value="manual">手动固定</option><option value="auto">自动选择</option></select></label><fieldset><legend>允许的提供商</legend>{configuredModelIds.map((id) => <label key={id}><input type="checkbox" checked={autoProviders.includes(id)} onChange={(event) => setAutoProviders((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id))} />{id}</label>)}</fieldset><label>单轮费用上限（美元）<input type="number" min={0} step={0.1} value={costCapUsd} onChange={(event) => setCostCapUsd(Number(event.target.value))} /></label><button type="submit">保存模型策略</button></form>
        : section === "background" ? <form className="settings-runtime" onSubmit={(event) => { event.preventDefault(); void saveWorkspace({ background: { enabled: backgroundEnabled, startHour, endHour, taskBudgetUsd, reminder } }); }}><p>后台运行单独开启。队列空闲时不会调用模型。把结束小时设为 24 只表示未完成任务可以跨时段继续。</p><label><input type="checkbox" checked={backgroundEnabled} onChange={(event) => setBackgroundEnabled(event.target.checked)} />允许后台推进未完成的 Bot 任务</label><label>开始小时<input type="number" min={0} max={23} value={startHour} onChange={(event) => setStartHour(Number(event.target.value))} /></label><label>结束小时<input type="number" min={1} max={24} value={endHour} onChange={(event) => setEndHour(Number(event.target.value))} /></label><label>任务预算（美元）<input type="number" min={0} step={0.5} value={taskBudgetUsd} onChange={(event) => setTaskBudgetUsd(Number(event.target.value))} /></label><label>提醒<select value={reminder} onChange={(event) => setReminder(event.target.value as "none" | "desktop")}><option value="none">不提醒</option><option value="desktop">桌面</option></select></label><button type="submit">保存后台策略</button></form>
        : section === "projects" ? <Suspense fallback={<p>正在打开项目…</p>}><ProjectView projectId={activeProjectId} projects={projects} onProjectChange={setActiveProjectId} onProjectsChange={refreshProjects} /></Suspense>
        : section === "execution" ? <form className="settings-runtime" onSubmit={(event) => { event.preventDefault(); void saveWorkspace({ execution: { target: executionTarget, ...(sshHost.trim() ? { sshHost: sshHost.trim() } : {}) } }); }}><p>Pi 仍然是唯一的模型循环。执行可以落在本机、SSH 或虚拟机，而且不能绕过审批去改正式结论或下载大规模数据。</p><label>目标<select value={executionTarget} onChange={(event) => setExecutionTarget(event.target.value as "local" | "ssh" | "vm")}><option value="local">本机</option><option value="ssh">远程 SSH</option><option value="vm">虚拟机</option></select></label>{executionTarget === "ssh" ? <label>SSH 主机<input value={sshHost} onChange={(event) => setSshHost(event.target.value)} /></label> : null}<button type="submit">保存执行目标</button></form>
        : section === "skills" ? renderSkills() : section === "mcp" ? <McpSettingsPanel value={mcp} onChanged={setMcp} onMessage={setMessage} /> : section === "model-apis" ? renderProviderCategory("model") : section === "literature" ? renderProviderCategory("literature") : renderProviderCategory("data")}
    </main>
  </div>;
}
