import { useEffect, useMemo, useState } from "react";
import type { CredentialProviderId, CredentialProviderStatus, InstalledSkillSummary, InstalledSkillsResponse, McpSettingsResponse, ModelCatalogEntry, ModelProviderId, ModelRouteSettings, ModelRuntimeStatus, ProviderConnectionTestResult } from "@xiling/contracts";
import { Moon, Sun } from "lucide-react";
import { ApiError, apiJson, jsonInit } from "../lib/api-client.js";
import { useTheme } from "../lib/theme.js";
import { McpSettingsPanel } from "./McpSettingsPanel.js";
import { ModelCapsule, type CapsuleReasoning, type CapsuleRoute } from "../components/ModelCapsule.js";

type SettingsSection = "appearance" | "agents" | "skills" | "mcp" | "model-apis" | "literature" | "data";
type ProviderCategory = CredentialProviderStatus["category"];
type InstalledAgentRole = { id: string; title: string; description: string; allowedCapabilities: string[]; defaultIsolation: "scoped" | "blind" | "execution"; dynamic?: boolean };
type RouteDraft = { providerId?: ModelProviderId; modelId: string; reasoning: ModelRouteSettings["reasoning"] };

const sections: Array<{ label: string; items: Array<{ id: SettingsSection; label: string; icon: string }> }> = [
  { label: "常规", items: [{ id: "appearance", label: "主题", icon: "◐" }] },
  { label: "智能体", items: [{ id: "agents", label: "子智能体", icon: "⑂" }, { id: "skills", label: "Skills", icon: "✦" }, { id: "mcp", label: "MCP", icon: "⌘" }] },
  { label: "连接", items: [{ id: "model-apis", label: "模型 API 连接", icon: "⌁" }, { id: "literature", label: "文献服务", icon: "⌕" }, { id: "data", label: "科研数据账户", icon: "≈" }] },
];

const sectionTitle: Record<SettingsSection, string> = {
  appearance: "主题", agents: "子智能体", skills: "Skills", mcp: "MCP", "model-apis": "模型 API 连接", literature: "文献服务", data: "科研数据账户",
};

const skillPresentation: Record<string, { title: string; glyph: string }> = {
  "artifact-inspection": { title: "科研产物检查", glyph: "图" },
  "literature-evidence": { title: "文献证据", glyph: "文" },
  "project-wiki-navigation": { title: "项目 Wiki 导航", glyph: "知" },
  "ocean-data-subsetting": { title: "海洋数据切片", glyph: "数" },
};

export function SettingsView() {
  const theme = useTheme();
  const [section, setSection] = useState<SettingsSection>("appearance");
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
      <div className="credential-fields">{provider.fields.map((item) => <label key={item.id}><span>{item.label}{provider.configuredFields.includes(item.id) ? <em> 已配置</em> : null}</span>{item.id === "apiStyle" ? <select aria-label={`${provider.title} ${item.label}`} value={values[provider.id]?.[item.id] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [provider.id]: { ...(current[provider.id] ?? {}), [item.id]: event.target.value } }))}><option value="">选择兼容协议</option><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option></select> : <input aria-label={`${provider.title} ${item.label}`} type={item.secret ? "password" : "text"} autoComplete="off" value={values[provider.id]?.[item.id] ?? ""} placeholder={provider.configuredFields.includes(item.id) ? item.secret ? "••••••••（留空则保持）" : "已保存（留空则保持）" : item.placeholder} onChange={(event) => setValues((current) => ({ ...current, [provider.id]: { ...(current[provider.id] ?? {}), [item.id]: event.target.value } }))} />}</label>)}</div>
      {testResults[provider.id] ? <div className={`connection-result ${testResults[provider.id]!.ok ? "ok" : "failed"}`}><b>{testResults[provider.id]!.ok ? "连接正常" : "连接失败"}</b><span>{testResults[provider.id]!.modelId} · {testResults[provider.id]!.latencyMs} ms</span></div> : null}
      <div className="provider-actions"><a href={provider.documentationUrl} target="_blank" rel="noreferrer">官方文档 ↗</a><div>{provider.category === "model" ? <button className="secondary" disabled={!provider.configured || busy === provider.id} onClick={() => void testConnection(provider)}>{busy === provider.id ? "测试中…" : "测试连接"}</button> : null}{provider.configured && provider.source !== "environment" ? <button className="clear" disabled={busy === provider.id} onClick={() => void clear(provider)}>{confirmClear === provider.id ? "确认清除" : "清除本地凭据"}</button> : null}<button disabled={busy === provider.id} onClick={() => void save(provider)}>{busy === provider.id ? "保存中…" : "保存"}</button></div></div>
    </article>)}</div></section>;
  };

  const renderSkills = () => <section className="skills-settings">
    <div className="skills-toolbar"><label><span>⌕</span><input aria-label="搜索已安装 Skills" value={skillQuery} placeholder="搜索能力或工具…" onChange={(event) => setSkillQuery(event.target.value)} /></label><button className="secondary" onClick={() => void refresh()}>刷新目录</button></div>
    <div className="skills-grid">{visibleSkills.map((skill: InstalledSkillSummary) => {
      const presentation = skillPresentation[skill.name] ?? { title: skill.name, glyph: "技" };
      return <article className="skill-card" key={skill.name}><header><span className="skill-glyph">{presentation.glyph}</span><div><h3>{presentation.title}</h3><code>{skill.name}</code></div><b>v{skill.version}</b></header><p>{skill.description}</p><section><small>关联能力</small><div>{skill.capabilities.map((capability) => <span className="skill-capability" key={capability.id} title={capability.description}><b>{capability.id}</b><em>{capability.toolName}</em></span>)}</div></section></article>;
    })}</div>
    {visibleSkills.length === 0 ? <div className="skills-empty">没有匹配的 Skill。</div> : null}
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
      return <article key={role.id}><header><span>{role.title.slice(0, 1)}</span><div><h3>{role.title}</h3><code>{role.id}</code></div><b>{role.defaultIsolation === "blind" ? "盲审隔离" : role.defaultIsolation === "execution" ? "执行隔离" : "任务切片"}</b></header><div className="agent-role-capsule"><ModelCapsule compact allowInherit inheritLabel="继承主模型" value={route ? { providerId: route.providerId, modelId: route.modelId, reasoning: route.reasoning } : undefined} catalog={catalog} configuredProviders={modelProviders} disabled={!runtime?.primary} disabledHint="请先在对话发送按钮左侧设置主模型" onCommit={(next) => void commitRoleRoute(role.id, next)} /></div><section><small>允许能力</small><div>{role.allowedCapabilities.map((capability) => <span key={capability}>{capability}</span>)}</div></section></article>;
    })}</div>
  </section>;

  const renderAppearance = () => <div className="settings-appearance">
    <section className="appearance-capsule-card">
      <div className="theme-capsule" role="radiogroup" aria-label="界面主题">
        <button role="radio" aria-checked={theme.resolved === "lingjing"} className={theme.resolved === "lingjing" ? "active" : ""} onClick={() => theme.setPreference("lingjing")}><Moon size={13} aria-hidden="true" />灵境</button>
        <button role="radio" aria-checked={theme.resolved === "poxiao"} className={theme.resolved === "poxiao" ? "active" : ""} onClick={() => theme.setPreference("poxiao")}><Sun size={13} aria-hidden="true" />破晓</button>
      </div>
    </section>
  </div>;

  return <div className="settings-view settings-shell">
    <aside className="settings-local-nav"><div><small>SETTINGS</small><strong>汐灵设置</strong></div>{sections.map((group) => <section key={group.label}><span>{group.label}</span>{group.items.map((item) => <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => { setSection(item.id); setMessage(""); }}><i>{item.icon}</i>{item.label}</button>)}</section>)}</aside>
    <main className="settings-content"><header className="settings-head"><h1>{sectionTitle[section]}</h1>{section === "skills" ? <span>{skills?.skills.length ?? 0} 已安装</span> : null}</header>{message ? <div className="settings-message" role="status">{message}</div> : null}
      {section === "appearance" ? renderAppearance() : section === "agents" ? renderAgents() : section === "skills" ? renderSkills() : section === "mcp" ? <McpSettingsPanel value={mcp} onChanged={setMcp} onMessage={setMessage} /> : section === "model-apis" ? renderProviderCategory("model") : section === "literature" ? renderProviderCategory("literature") : renderProviderCategory("data")}
    </main>
  </div>;
}
