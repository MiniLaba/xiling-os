import { useEffect, useMemo, useState } from "react";
import type { CredentialProviderId, CredentialProviderStatus, InstalledSkillSummary, InstalledSkillsResponse, McpSettingsResponse, ModelCatalogEntry, ModelProviderId, ModelRouteSettings, ModelRuntimeStatus, ProviderConnectionTestResult } from "@xiling/contracts";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { ApiError, apiJson, jsonInit } from "../lib/api-client.js";
import { useTheme, type ThemePreference } from "../lib/theme.js";
import { McpSettingsPanel } from "./McpSettingsPanel.js";

type SettingsSection = "overview" | "appearance" | "model" | "agents" | "domains" | "skills" | "mcp" | "model-apis" | "literature" | "data" | "security";
type ProviderCategory = CredentialProviderStatus["category"];
type InstalledAgentRole = { id: string; title: string; description: string; allowedCapabilities: string[]; defaultIsolation: "scoped" | "blind" | "execution"; dynamic?: boolean };
type InstalledScienceDomain = { id: string; version: string; title: string; description: string; disciplines: string[]; capabilities: Array<{ id: string }>; agentRoles: Array<{ id: string }>; connectorKinds: string[]; artifactKinds: string[]; schemaNamespaces: string[] };
type RouteDraft = { providerId?: ModelProviderId; modelId: string; reasoning: ModelRouteSettings["reasoning"] };

const sections: Array<{ label: string; items: Array<{ id: SettingsSection; label: string; icon: string }> }> = [
  { label: "常规", items: [{ id: "overview", label: "设置概览", icon: "⌂" }, { id: "appearance", label: "外观与主题", icon: "◐" }] },
  { label: "智能体", items: [{ id: "model", label: "模型分配", icon: "◈" }, { id: "agents", label: "多智能体", icon: "⑂" }, { id: "domains", label: "科学领域", icon: "◉" }, { id: "skills", label: "Skills", icon: "✦" }, { id: "mcp", label: "MCP", icon: "⌘" }] },
  { label: "连接", items: [{ id: "model-apis", label: "模型 API 连接", icon: "⌁" }, { id: "literature", label: "文献服务", icon: "⌕" }, { id: "data", label: "科研数据账户", icon: "≈" }] },
  { label: "系统", items: [{ id: "security", label: "安全与运行", icon: "◇" }] },
];

const sectionCopy: Record<SettingsSection, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: "SETTINGS", title: "设置概览", description: "集中查看智能体、服务连接和本地安全状态。" },
  appearance: { eyebrow: "GENERAL · APPEARANCE", title: "外观与主题", description: "选择适合当前环境的界面明暗；更改即时生效并只保存在本机。" },
  model: { eyebrow: "AGENT · MODEL ROUTER", title: "模型分配", description: "配置主智能体和各科研角色使用的真实模型；Chat 中仍可为下一次运行临时切换。" },
  agents: { eyebrow: "AGENT · RESEARCH TEAM", title: "多智能体", description: "查看预置科研角色、上下文隔离和能力边界；主智能体只在任务值得拆分时按需委派。" },
  domains: { eyebrow: "EXTENSIONS · SCIENCE DOMAINS", title: "科学领域", description: "通用科研内核保持稳定，领域包按项目贡献提示、能力、角色、连接器与 Artifact 类型。" },
  skills: { eyebrow: "AGENT · LAZY CAPABILITIES", title: "已安装 Skills", description: "查看宿主目录中已注册的研究能力，以及它们何时加载、关联哪些工具。" },
  mcp: { eyebrow: "AGENT · MCP GATEWAY", title: "MCP 连接", description: "配置独立 MCP Host；服务器和工具 schema 按任务命中后惰性发现，不常驻 Agent 上下文。" },
  "model-apis": { eyebrow: "CONNECTIONS · MODEL", title: "模型 API 连接", description: "这里只管理连接和连通性测试；模型分配在“模型分配”中完成。" },
  literature: { eyebrow: "CONNECTIONS · LITERATURE", title: "文献服务", description: "配置文献图的主数据源与降级数据源。" },
  data: { eyebrow: "CONNECTIONS · RESEARCH DATA", title: "科研数据账户", description: "配置已安装领域包的数据账户；凭据只注入已批准的单次运行。" },
  security: { eyebrow: "SYSTEM · LOCAL FIRST", title: "安全与运行", description: "查看加密、凭据隔离、当前模型路由和上下文加载边界。" },
};

const themeOptions: Array<{ id: ThemePreference; title: string; description: string; icon: React.ReactNode }> = [
  { id: "system", title: "跟随系统", description: "自动匹配操作系统的深色或浅色外观。", icon: <Monitor size={19} aria-hidden="true" /> },
  { id: "lingjing", title: "灵境", description: "低眩光深色界面，适合专注阅读与长时研究。", icon: <Moon size={19} aria-hidden="true" /> },
  { id: "poxiao", title: "破晓", description: "清晰的浅色纸面感，适合日间工作与展示。", icon: <Sun size={19} aria-hidden="true" /> },
];

const skillPresentation: Record<string, { title: string; glyph: string }> = {
  "artifact-inspection": { title: "科研产物检查", glyph: "图" },
  "literature-evidence": { title: "文献证据", glyph: "文" },
  "project-wiki-navigation": { title: "项目 Wiki 导航", glyph: "知" },
  "ocean-data-subsetting": { title: "海洋数据切片", glyph: "数" },
};

export function SettingsView() {
  const theme = useTheme();
  const [section, setSection] = useState<SettingsSection>("overview");
  const [providers, setProviders] = useState<CredentialProviderStatus[]>([]);
  const [values, setValues] = useState<Partial<Record<CredentialProviderId, Record<string, string>>>>({});
  const [busy, setBusy] = useState<CredentialProviderId>();
  const [message, setMessage] = useState("");
  const [confirmClear, setConfirmClear] = useState<CredentialProviderId>();
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [runtime, setRuntime] = useState<ModelRuntimeStatus>();
  const [modelProvider, setModelProvider] = useState<ModelProviderId>();
  const [modelId, setModelId] = useState("");
  const [reasoning, setReasoning] = useState<ModelRouteSettings["reasoning"]>("medium");
  const [modelImageInput, setModelImageInput] = useState(false);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, RouteDraft>>({});
  const [testResults, setTestResults] = useState<Partial<Record<CredentialProviderId, ProviderConnectionTestResult>>>({});
  const [skills, setSkills] = useState<InstalledSkillsResponse>();
  const [mcp, setMcp] = useState<McpSettingsResponse>();
  const [skillQuery, setSkillQuery] = useState("");
  const [agentRoles, setAgentRoles] = useState<InstalledAgentRole[]>([]);
  const [scienceDomains, setScienceDomains] = useState<InstalledScienceDomain[]>([]);

  const refresh = async () => {
    try {
      const [nextProviders, models, nextSkills, nextMcp, nextAgentRoles, nextDomains] = await Promise.all([
        apiJson<CredentialProviderStatus[]>("/api/settings/providers"),
        apiJson<{ catalog: ModelCatalogEntry[]; runtime: ModelRuntimeStatus }>("/api/settings/models"),
        apiJson<InstalledSkillsResponse>("/api/settings/skills"),
        apiJson<McpSettingsResponse>("/api/settings/mcp"),
        apiJson<{ roles: InstalledAgentRole[] }>("/api/agent-center/roles"),
        apiJson<{ domains: InstalledScienceDomain[] }>("/api/science/domains"),
      ]);
      setProviders(nextProviders); setCatalog(models.catalog); setRuntime(models.runtime); setSkills(nextSkills); setMcp(nextMcp); setAgentRoles(nextAgentRoles.roles); setScienceDomains(nextDomains.domains);
      if (models.runtime.primary) { setModelProvider(models.runtime.primary.providerId); setModelId(models.runtime.primary.modelId); setReasoning(models.runtime.primary.reasoning); setModelImageInput(Boolean(models.runtime.primary.selectedModel?.inputModalities.includes("image"))); }
      setRoleDrafts(Object.fromEntries(nextAgentRoles.roles.map((role) => {
        const route = models.runtime.roleRoutes[role.id];
        return [role.id, route ? { providerId: route.providerId, modelId: route.modelId, reasoning: route.reasoning } : { modelId: "", reasoning: "medium" as const }];
      })));
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
    const candidateModel = modelProvider === provider.id && modelId.trim() ? modelId.trim() : undefined;
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
  const saveRuntime = async () => {
    const normalizedModelId = modelId.trim();
    if (!modelProvider || !normalizedModelId) { setMessage("请先选择主智能体的提供商并输入模型名称或模型 ID。"); return; }
    if (!providers.find((provider) => provider.id === modelProvider)?.configured) { setMessage("请先在“模型 API 连接”中保存所选提供商。"); return; }
    try {
      const roleRoutes = Object.fromEntries(Object.entries(roleDrafts).flatMap(([roleId, draft]) => draft.providerId && draft.modelId.trim() ? [[roleId, { providerId: draft.providerId, modelId: draft.modelId.trim(), reasoning: draft.reasoning, inputModalities: catalog.find((item) => item.providerId === draft.providerId && item.id === draft.modelId.trim())?.inputModalities ?? ["text"] }]] : []));
      const nextRuntime = await apiJson<ModelRuntimeStatus>("/api/settings/models", jsonInit("PUT", { primary: { providerId: modelProvider, modelId: normalizedModelId, reasoning, inputModalities: ["text", ...(modelImageInput ? ["image" as const] : [])] }, roleRoutes }));
      setRuntime(nextRuntime); setModelImageInput(Boolean(nextRuntime.primary?.selectedModel?.inputModalities.includes("image"))); setMessage("模型分配已保存；后续运行全部使用真实模型调用。");
    } catch (error) { const body = error instanceof ApiError ? error.body as { error?: string } : undefined; setMessage(`模型运行设置保存失败：${body?.error ?? (error instanceof Error ? error.message : "未知错误")}`); }
  };

  const configuredCount = providers.filter((provider) => provider.configured).length;
  const modelProviders = providers.filter((provider) => provider.category === "model");
  const selectedDraft = catalog.find((model) => model.providerId === modelProvider && model.id === modelId);
  const activeModelCapabilities = selectedDraft ?? (runtime?.primary && runtime.primary.providerId === modelProvider && runtime.primary.modelId === modelId ? runtime.primary.selectedModel : undefined);
  const imageCapabilityCanBeSelected = Boolean(modelProvider && modelId.trim() && (!selectedDraft || selectedDraft.inputModalities.includes("image")));
  const hasPersistedNativeProbe = Boolean(runtime?.primary && runtime.primary.providerId === modelProvider && runtime.primary.modelId === modelId && runtime.primary.capabilitySource === "native-probe" && modelImageInput);
  const capabilityState = selectedDraft ? "PI CATALOG" : hasPersistedNativeProbe ? "NATIVE PROBE" : modelImageInput ? "PROBE ON SAVE" : activeModelCapabilities ? "TEXT ONLY" : "WAITING FOR MODEL";
  const visibleSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase();
    if (!query) return skills?.skills ?? [];
    return (skills?.skills ?? []).filter((skill) => [skill.name, skill.description, ...skill.keywords, ...skill.capabilities.flatMap((item) => [item.id, item.description, item.toolName])].some((item) => item.toLocaleLowerCase().includes(query)));
  }, [skillQuery, skills]);

  const renderProviderCategory = (category: ProviderCategory) => {
    const items = providers.filter((provider) => provider.category === category);
    const targetSection: SettingsSection = category === "model" ? "model-apis" : category;
    return <section className="provider-section settings-provider-page"><header><div><small>{category.toUpperCase()}</small><h2>{sectionCopy[targetSection].title}</h2></div><span>{items.filter((provider) => provider.configured).length}/{items.length} 已配置</span></header><div className="provider-grid">{items.map((provider) => <article className={provider.configured ? "configured" : ""} key={provider.id}>
      <div className="provider-title"><div><i /><h3>{provider.title}</h3></div><span>{provider.configured ? provider.source === "environment" ? "环境变量" : "已加密保存" : "未配置"}</span></div>
      <p>{provider.description}</p>
      <div className="credential-fields">{provider.fields.map((item) => <label key={item.id}><span>{item.label}{provider.configuredFields.includes(item.id) ? <em> 已配置</em> : null}</span>{item.id === "apiStyle" ? <select aria-label={`${provider.title} ${item.label}`} value={values[provider.id]?.[item.id] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [provider.id]: { ...(current[provider.id] ?? {}), [item.id]: event.target.value } }))}><option value="">选择兼容协议</option><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option></select> : <input aria-label={`${provider.title} ${item.label}`} type={item.secret ? "password" : "text"} autoComplete="off" value={values[provider.id]?.[item.id] ?? ""} placeholder={provider.configuredFields.includes(item.id) ? item.secret ? "••••••••（留空则保持）" : "已保存（留空则保持）" : item.placeholder} onChange={(event) => setValues((current) => ({ ...current, [provider.id]: { ...(current[provider.id] ?? {}), [item.id]: event.target.value } }))} />}</label>)}</div>
      {testResults[provider.id] ? <div className={`connection-result ${testResults[provider.id]!.ok ? "ok" : "failed"}`}><b>{testResults[provider.id]!.ok ? "连接正常" : "连接失败"}</b><span>{testResults[provider.id]!.modelId} · {testResults[provider.id]!.latencyMs} ms</span></div> : null}
      <div className="provider-actions"><a href={provider.documentationUrl} target="_blank" rel="noreferrer">官方文档 ↗</a><div>{provider.category === "model" ? <button className="secondary" disabled={!provider.configured || busy === provider.id} onClick={() => void testConnection(provider)}>{busy === provider.id ? "测试中…" : "测试连接"}</button> : null}{provider.configured && provider.source !== "environment" ? <button className="clear" disabled={busy === provider.id} onClick={() => void clear(provider)}>{confirmClear === provider.id ? "确认清除" : "清除本地凭据"}</button> : null}<button disabled={busy === provider.id} onClick={() => void save(provider)}>{busy === provider.id ? "保存中…" : "保存"}</button></div></div>
    </article>)}</div></section>;
  };

  const renderModel = () => <section className="model-runtime-card settings-primary-card">
    <div className="model-runtime-title"><div><small>PI MODEL ROUTER</small><h2>主智能体模型</h2><p>作为 Research Director 的默认路由；未单独分配的子智能体自动继承它。</p></div><span className={`runtime-state ${runtime?.ready ? "live" : "blocked"}`}>{runtime?.ready ? "READY" : "NEEDS SETUP"}</span></div>
    <div className="model-runtime-fields">
      <label><span>提供商</span><select aria-label="默认模型提供商" value={modelProvider ?? ""} onChange={(event) => { const provider = event.target.value as ModelProviderId; setModelProvider(provider); setModelId(""); setModelImageInput(false); }}><option value="">选择提供商</option>{modelProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.title}{provider.configured ? " · 已连接" : " · 未连接"}</option>)}</select></label>
      <label className="model-id-field"><span>模型名称 / ID <em>可自由输入</em></span><input aria-label="默认模型" list="recommended-models" value={modelId} disabled={!modelProvider} placeholder={modelProvider ? "输入或选择模型 ID" : "请先选择提供商"} autoComplete="off" onChange={(event) => { const nextId = event.target.value; const known = catalog.find((model) => model.providerId === modelProvider && model.id === nextId); setModelId(nextId); setModelImageInput(Boolean(known?.inputModalities.includes("image"))); }} /><datalist id="recommended-models">{catalog.filter((model) => model.providerId === modelProvider).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist></label>
      <label><span>推理强度</span><select aria-label="默认推理强度" value={reasoning} onChange={(event) => setReasoning(event.target.value as ModelRouteSettings["reasoning"])}><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
    </div>
    <div className="model-native-capabilities"><div className="model-native-title"><div><b>当前模型可用的原生模态</b><small>按具体模型声明；不支持的输入在 Chat 中直接禁用</small></div><span>{capabilityState}</span></div>{modelProvider && modelId.trim() ? <><div className="model-native-rows"><div><span>输入</span><b>文字</b><label className={`model-modality-toggle ${modelImageInput ? "active" : ""}`}><input type="checkbox" checked={modelImageInput} disabled={!imageCapabilityCanBeSelected} onChange={(event) => setModelImageInput(event.target.checked)} />图像</label><b className="unavailable">音频 · 当前传输层不可用</b><b className="unavailable">视频 · 当前传输层不可用</b></div><div><span>输出</span><b>文字</b></div></div><p>{selectedDraft ? "能力来自 Pi 模型目录；目录明确不支持的模态不能开启。" : modelImageInput ? "目录外模型保存前会执行一次原生图像探针。" : "目录外模型默认仅文字；系统不会用转写或抽帧伪装原生模态。"}</p></> : <p>选择具体模型后显示原生能力。</p>}</div>
    <div className="role-route-section"><header><div><small>CHILD AGENTS</small><h3>子智能体模型</h3><p>留空即继承主模型；只有确有成本、上下文或审查隔离需求时才单独分配。</p></div><span>{Object.values(roleDrafts).filter((route) => route.providerId && route.modelId).length} 个专属路由</span></header><div className="role-route-list">{agentRoles.map((role) => { const draft = roleDrafts[role.id] ?? { modelId: "", reasoning: "medium" as const }; const inherited = !draft.providerId; return <article key={role.id}><div><b>{role.title}</b><small>{role.id}</small></div><label><span>路由</span><select aria-label={`${role.title} 模型提供商`} value={draft.providerId ?? ""} onChange={(event) => setRoleDrafts((current) => ({ ...current, [role.id]: event.target.value ? { providerId: event.target.value as ModelProviderId, modelId: "", reasoning: draft.reasoning } : { modelId: "", reasoning: draft.reasoning } }))}><option value="">继承主模型</option>{modelProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.title}</option>)}</select></label><label><span>模型 ID</span><input aria-label={`${role.title} 模型`} list={`role-models-${role.id}`} disabled={inherited} value={draft.modelId} placeholder={inherited ? "使用主模型" : "输入或选择模型 ID"} onChange={(event) => setRoleDrafts((current) => ({ ...current, [role.id]: { ...draft, modelId: event.target.value } }))} /><datalist id={`role-models-${role.id}`}>{catalog.filter((model) => model.providerId === draft.providerId).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist></label><label><span>推理</span><select aria-label={`${role.title} 推理强度`} disabled={inherited} value={draft.reasoning} onChange={(event) => setRoleDrafts((current) => ({ ...current, [role.id]: { ...draft, reasoning: event.target.value as ModelRouteSettings["reasoning"] } }))}><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label></article>; })}</div></div>
    <div className="model-runtime-meta"><span>{selectedDraft ? `${selectedDraft.contextWindow.toLocaleString()} context · ${selectedDraft.reasoning ? "支持推理" : "标准模型"}` : modelId.trim() ? `自定义模型：${modelId.trim()}` : "先连接提供商，再选择或输入模型 ID"}</span><div><button disabled={!modelProvider || !modelId.trim()} onClick={() => void saveRuntime()}>保存全部模型分配</button></div></div>
  </section>;

  const renderSkills = () => <section className="skills-settings">
    <div className="skills-policy"><div><span>✦</span><div><b>按需加载已启用</b><p>系统提示只保留 Skill 索引。任务命中关键词或 Capability 后才读取正文，并按版本缓存。</p></div></div><dl><div><dt>{skills?.skills.length ?? "—"}</dt><dd>已安装</dd></div><div><dt>0</dt><dd>常驻正文</dd></div><div><dt>{new Set((skills?.skills ?? []).flatMap((skill) => skill.capabilities.map((item) => item.id))).size}</dt><dd>关联能力</dd></div></dl></div>
    <div className="skills-toolbar"><label><span>⌕</span><input aria-label="搜索已安装 Skills" value={skillQuery} placeholder="搜索名称、触发词、能力或工具…" onChange={(event) => setSkillQuery(event.target.value)} /></label><button className="secondary" onClick={() => void refresh()}>刷新目录</button></div>
    <div className="skills-grid">{visibleSkills.map((skill: InstalledSkillSummary) => {
      const presentation = skillPresentation[skill.name] ?? { title: skill.name, glyph: "技" };
      return <article className="skill-card" key={skill.name}><header><span className="skill-glyph">{presentation.glyph}</span><div><h3>{presentation.title}</h3><code>{skill.name}</code></div><b>v{skill.version}</b></header><p>{skill.description}</p><section><small>关联能力</small><div>{skill.capabilities.map((capability) => <span className="skill-capability" key={capability.id} title={capability.description}><b>{capability.id}</b><em>{capability.toolName}</em></span>)}</div></section><section><small>匹配词</small><div className="skill-keywords">{skill.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div></section><footer><i />已安装 · 命中后读取正文</footer></article>;
    })}</div>
    {visibleSkills.length === 0 ? <div className="skills-empty">没有匹配的 Skill。清除搜索词可查看全部已安装能力。</div> : null}
    <p className="skills-footnote">Skill 的安装和版本目前由仓库 skills/catalog.json 管理；此页面不读取或展示 SKILL.md 正文，避免仅因打开设置就污染 Agent 上下文。</p>
  </section>;

  const renderAgents = () => <section className="agent-role-settings">
    <div className="skills-policy"><div><span>⑂</span><div><b>受控单层委派</b><p>Research Director 负责最终综合。子智能体使用独立 Session、最小科研图切片和角色能力白名单，不能继续创建子智能体。</p></div></div><dl><div><dt>{agentRoles.length}</dt><dd>预置角色</dd></div><div><dt>3</dt><dd>最大并发</dd></div><div><dt>0</dt><dd>递归层级</dd></div></dl></div>
    <div className="agent-role-grid">{agentRoles.map((role) => <article key={role.id}><header><span>{role.title.slice(0, 1)}</span><div><h3>{role.title}</h3><code>{role.id}</code></div><b>{role.defaultIsolation === "blind" ? "盲审隔离" : role.defaultIsolation === "execution" ? "执行隔离" : "任务切片"}</b></header><p>{role.description}</p><section><small>允许能力</small><div>{role.allowedCapabilities.map((capability) => <span key={capability}>{capability}</span>)}</div></section><footer><i />按任务命中 · 独立上下文 · 不直接写科研事实</footer></article>)}</div>
  </section>;

  const renderDomains = () => <section className="agent-role-settings"><div className="skills-policy"><div><span>◉</span><div><b>通用内核 + 领域包</b><p>领域包只声明贡献；工具适配器必须由 Server 显式注册，执行、下载和科研事实写入仍走原有审批。</p></div></div><dl><div><dt>{scienceDomains.length}</dt><dd>已安装</dd></div><div><dt>{scienceDomains.reduce((sum, domain) => sum + domain.capabilities.length, 0)}</dt><dd>领域能力</dd></div><div><dt>{scienceDomains.reduce((sum, domain) => sum + domain.agentRoles.length, 0)}</dt><dd>角色贡献</dd></div></dl></div><div className="agent-role-grid">{scienceDomains.map((domain) => <article key={domain.id}><header><span>{domain.title.slice(0, 1)}</span><div><h3>{domain.title}</h3><code>{domain.id} · v{domain.version}</code></div><b>{domain.id === "general-science" ? "基础内核" : "领域扩展"}</b></header><p>{domain.description}</p><section><small>学科与 Schema</small><div>{[...domain.disciplines, ...domain.schemaNamespaces].map((item) => <span key={item}>{item}</span>)}</div></section><footer><i />{domain.connectorKinds.length} 类连接器 · {domain.artifactKinds.length} 类 Artifact</footer></article>)}</div></section>;

  const renderOverview = () => <div className="settings-overview">
    <section className="settings-health-strip"><div><i className={runtime?.ready ? "ok" : ""} /><span><b>{runtime?.ready ? "智能体可用" : "需要配置主模型"}</b><small>{runtime?.primary?.selectedModel?.name ?? runtime?.primary?.modelId ?? "尚未选择真实模型"}</small></span></div><div><i className="ok" /><span><b>本地安全边界</b><small>凭据值不会回传浏览器</small></span></div></section>
    <div className="settings-overview-grid">
      <button onClick={() => setSection("appearance")}><span>◐</span><div><small>常规</small><h3>外观与主题</h3><p>{theme.preference === "system" ? `跟随系统 · 当前${theme.resolved === "lingjing" ? "灵境" : "破晓"}` : theme.preference === "lingjing" ? "灵境深色" : "破晓浅色"}</p></div><b>›</b></button>
      <button onClick={() => setSection("model")}><span>◈</span><div><small>智能体</small><h3>模型分配</h3><p>{runtime?.primary ? `主模型 ${runtime.primary.selectedModel?.name ?? runtime.primary.modelId} · ${Object.keys(runtime.roleRoutes).length} 个专属角色` : "尚未选择主模型"}</p></div><b>›</b></button>
      <button onClick={() => setSection("skills")}><span>✦</span><div><small>智能体</small><h3>{skills?.skills.length ?? 0} 个 Skills</h3><p>元数据常驻，正文按任务命中加载</p></div><b>›</b></button>
      <button onClick={() => setSection("agents")}><span>⑂</span><div><small>智能体</small><h3>{agentRoles.length} 个科研角色</h3><p>独立 Session · 受控并发 · 禁止递归</p></div><b>›</b></button>
      <button onClick={() => setSection("domains")}><span>◉</span><div><small>扩展</small><h3>{scienceDomains.length} 个科学领域</h3><p>通用内核 · 按项目组合领域能力</p></div><b>›</b></button>
      <button onClick={() => setSection("mcp")}><span>⌘</span><div><small>智能体</small><h3>{mcp?.servers.length ?? 0} 个 MCP 服务器</h3><p>单代理 schema · 惰性连接 · 独立进程</p></div><b>›</b></button>
      <button onClick={() => setSection("model-apis")}><span>⌁</span><div><small>服务连接</small><h3>{configuredCount}/{providers.length} 已配置</h3><p>模型、文献与数据服务相互隔离</p></div><b>›</b></button>
      <button onClick={() => setSection("security")}><span>◇</span><div><small>系统</small><h3>凭据与执行安全</h3><p>AES-256-GCM · 本地用户权限 · 容器执行</p></div><b>›</b></button>
    </div>
    <section className="security-notice"><b>配置原则</b><p>设置只决定宿主如何连接能力，不会把所有模型、Skill 或服务说明注入 Agent。每轮任务仍由 Capability Catalog 选择最小相关集合。</p></section>
  </div>;

  const renderAppearance = () => <div className="settings-appearance">
    <section className="appearance-summary">
      <div><small>当前生效</small><b>{theme.resolved === "lingjing" ? "灵境深色" : "破晓浅色"}</b></div>
      <p>{theme.preference === "system" ? "外观会随操作系统设置自动变化。" : "当前使用手动选择；不会随系统外观变化。"}</p>
    </section>
    <section className="appearance-group" aria-labelledby="theme-choice-title">
      <div className="appearance-group-title"><div><h2 id="theme-choice-title">系统主题</h2><p>影响整个汐灵工作区，包括对话、科研画布、Wiki 与设置。</p></div><span>无需重启</span></div>
      <div className="theme-choice-grid" role="radiogroup" aria-label="系统主题">
        {themeOptions.map((option) => {
          const selected = theme.preference === option.id;
          return <button className={`theme-choice ${selected ? "selected" : ""}`} key={option.id} role="radio" aria-checked={selected} onClick={() => { theme.setPreference(option.id); setMessage(`已切换为${option.title}。`); }}>
            <div className={`theme-preview theme-preview-${option.id}`} aria-hidden="true"><span /><span /><span /></div>
            <div className="theme-choice-copy"><i>{option.icon}</i><span><b>{option.title}</b><small>{option.description}</small></span>{selected ? <em><Check size={15} aria-hidden="true" /></em> : null}</div>
          </button>;
        })}
      </div>
    </section>
    <section className="appearance-note"><b>显示原则</b><p>科研对象的证据立场、关系类型和运行状态使用独立语义色；切换主题不会改变它们所表达的含义。</p></section>
  </div>;

  const renderSecurity = () => <div className="settings-security-page"><section className="security-notice"><b>本地凭据</b><p>凭据使用 AES-256-GCM 加密，主密钥与密文分离并限制为当前用户读取。环境变量优先；浏览器只能读取“是否配置”。</p></section><section className="security-list"><div><span>模型路由</span><b>{runtime?.ready ? "真实调用已就绪" : "模型路由被阻止"}</b><p>{runtime?.primary?.selectedModel?.name ?? runtime?.primary?.modelId ?? "尚未配置主模型"}</p></div><div><span>子智能体路由</span><b>{Object.keys(runtime?.roleRoutes ?? {}).length} 个专属分配</b><p>其余角色继承主智能体模型</p></div><div><span>Skill 上下文</span><b>按需加载</b><p>{skills?.skills.length ?? 0} 个已安装，0 个正文常驻</p></div><div><span>科研执行</span><b>隔离容器</b><p>下载、计算与外部写入必须先审批</p></div></section><section className="runtime-boundary"><b>运行时状态</b><span>{runtime?.ready ? `Chat 默认使用 ${runtime.primary?.selectedModel?.name ?? runtime.primary?.modelId}；可在对话页为下一次运行临时切换。` : "没有可用主模型时服务端会拒绝产品调用，不会自动降级为离线回答。"}</span></section></div>;

  const copy = sectionCopy[section];
  return <div className="settings-view settings-shell">
    <aside className="settings-local-nav"><div><small>SETTINGS</small><strong>汐灵设置</strong></div>{sections.map((group) => <section key={group.label}><span>{group.label}</span>{group.items.map((item) => <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => { setSection(item.id); setMessage(""); }}><i>{item.icon}</i>{item.label}</button>)}</section>)}</aside>
    <main className="settings-content"><header className="settings-head"><div><small>{copy.eyebrow}</small><h1>{copy.title}</h1><p>{copy.description}</p></div>{section === "overview" ? <span>{configuredCount}/{providers.length} 已配置</span> : section === "skills" ? <span>{skills?.skills.length ?? 0} 已安装</span> : null}</header>{message ? <div className="settings-message" role="status">{message}</div> : null}
      {section === "overview" ? renderOverview() : section === "appearance" ? renderAppearance() : section === "model" ? renderModel() : section === "agents" ? renderAgents() : section === "domains" ? renderDomains() : section === "skills" ? renderSkills() : section === "mcp" ? <McpSettingsPanel value={mcp} onChanged={setMcp} onMessage={setMessage} /> : section === "model-apis" ? renderProviderCategory("model") : section === "literature" ? renderProviderCategory("literature") : section === "data" ? renderProviderCategory("data") : renderSecurity()}
    </main>
  </div>;
}
