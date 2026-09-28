import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelCatalogEntry, ModelProviderId } from "@xiling/contracts";

export type CapsuleReasoning = "off" | "low" | "medium" | "high";
export interface CapsuleRoute { providerId: ModelProviderId; modelId: string; reasoning: CapsuleReasoning }

const reasoningLabel: Record<CapsuleReasoning, string> = { off: "关", low: "低", medium: "中", high: "高" };

const providerOrder: ModelProviderId[] = ["deepseek", "moonshotai", "zai", "openrouter", "openai", "anthropic", "google", "xai", "mistral", "groq", "custom"];
const looksLikeCredential = (modelId: string) => /^sk[-_]/i.test(modelId.trim());

interface Props {
  /** undefined 表示继承主模型（仅 allowInherit 时可用）。 */
  value: CapsuleRoute | undefined;
  allowInherit?: boolean;
  catalog: ModelCatalogEntry[];
  configuredProviders: Array<{ id: ModelProviderId; title: string; configured?: boolean }>;
  disabled?: boolean;
  compact?: boolean;
  inheritLabel?: string;
  /** disabled 时的提示文案。 */
  disabledHint?: string;
  onCommit: (route: CapsuleRoute | null, credential?: { apiKey: string }) => void;
}

/**
 * 胶囊模型选择入口：点击展开按提供商分组的模型列表，底部提供推理强度与
 * 自定义模型 ID。选中即通过 onCommit 提交，由调用方负责持久化。
 */
export function ModelCapsule({ value, allowInherit, inheritLabel = "继承主模型", catalog, configuredProviders, disabled, compact, disabledHint, onCommit }: Props) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customProvider, setCustomProvider] = useState<ModelProviderId>();
  const [customModelId, setCustomModelId] = useState("");
  const [pending, setPending] = useState<CapsuleRoute>();
  const [apiKey, setApiKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [reasoning, setReasoning] = useState<CapsuleReasoning>("medium");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => { setReasoning(value?.reasoning ?? "medium"); }, [open, value?.reasoning]);

  const providers = useMemo(
    () => [...configuredProviders].sort((left, right) => providerOrder.indexOf(left.id) - providerOrder.indexOf(right.id)),
    [configuredProviders],
  );
  const groups = useMemo(
    () => providers
      .map((provider) => ({ provider, models: catalog.filter((model) => model.providerId === provider.id).slice(0, 4) }))
      .filter((group) => group.models.length),
    [catalog, providers],
  );

  const label = value
    ? looksLikeCredential(value.modelId) ? "请重新选择模型" : catalog.find((model) => model.providerId === value.providerId && model.id === value.modelId)?.name ?? value.modelId
    : allowInherit ? "继承主模型" : "选择模型";

  const commit = (route: CapsuleRoute | null, credential?: { apiKey: string }) => {
    setOpen(false); setCustomOpen(false); setCustomModelId(""); setPending(undefined); setApiKey("");
    if (credential) onCommit(route, credential);
    else onCommit(route);
  };
  const needsKey = (providerId: ModelProviderId) => configuredProviders.find((provider) => provider.id === providerId)?.configured === false;
  const pick = (providerId: ModelProviderId, modelId: string) => {
    const route = { providerId, modelId, reasoning };
    if (needsKey(providerId)) { setPending(route); setCustomOpen(false); return; }
    commit(route);
  };
  const commitCustom = () => {
    const modelId = customModelId.trim();
    if (!customProvider || !modelId) return;
    if (looksLikeCredential(modelId)) { setKeyError("这是 API Key，不是模型名。请点选列表里的 DeepSeek V4 Pro，密钥填在密钥框。"); return; }
    setKeyError("");
    const route = { providerId: customProvider, modelId, reasoning };
    if (needsKey(customProvider)) { setPending(route); return; }
    commit(route);
  };
  const commitPending = () => {
    if (!pending || pending.providerId === "custom" || !apiKey.trim()) return;
    commit({ ...pending, reasoning }, { apiKey: apiKey.trim() });
  };

  return (
    <div className={`xl-model-capsule ${compact ? "compact" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="xl-model-capsule-trigger"
        disabled={disabled}
        title={disabled ? disabledHint ?? "主模型未配置" : "选择模型（保存为默认路由）"}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="xl-model-capsule-dot" />
        <span className="xl-model-capsule-label">{label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="xl-model-capsule-menu" role="listbox" aria-label="模型列表">
          {allowInherit ? (
            <button type="button" role="option" aria-selected={!value} className={!value ? "current" : ""} onClick={() => commit(null)}>
              <em>{inheritLabel}</em>
              {!value ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ) : null}
          {groups.map((group) => (
            <section key={group.provider.id}>
              <small>{group.provider.title}{group.provider.configured === false ? " · 需 API Key" : ""}</small>
              {group.models.map((model) => {
                const current = value?.providerId === model.providerId && value?.modelId === model.id;
                return (
                  <button type="button" key={`${model.providerId}:${model.id}`} role="option" aria-selected={current} className={current ? "current" : ""} onClick={() => pick(model.providerId, model.id)}>
                    <span>{model.name}</span>
                    {model.reasoning ? <em>推理</em> : null}
                    {current ? <Check size={14} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </section>
          ))}
          <div className="xl-model-capsule-reasoning" role="radiogroup" aria-label="推理强度">
            <small>推理</small>
            {(["off", "low", "medium", "high"] as CapsuleReasoning[]).map((level) => (
              <button type="button" key={level} role="radio" aria-checked={reasoning === level} className={reasoning === level ? "active" : ""} onClick={() => setReasoning(level)}>{reasoningLabel[level]}</button>
            ))}
          </div>
          {customOpen ? (
            <div className="xl-model-capsule-custom">
              <select aria-label="自定义模型提供商" value={customProvider ?? ""} onChange={(event) => setCustomProvider(event.target.value as ModelProviderId)}>
                <option value="">提供商</option>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.title}</option>)}
              </select>
              <input aria-label="自定义模型 ID" placeholder="模型 ID" value={customModelId} onChange={(event) => setCustomModelId(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitCustom(); } }} />
              <button type="button" disabled={!customProvider || !customModelId.trim()} onClick={commitCustom}>确定</button>
            </div>
          ) : (
            <button type="button" className="xl-model-capsule-custom-entry" onClick={() => setCustomOpen(true)}>自定义模型 ID…</button>
          )}
          {keyError ? <p className="xl-model-capsule-error">{keyError}</p> : null}
          {pending ? (
            <div className="xl-model-capsule-key">
              {pending.providerId === "custom" ? <p>自定义接口请到设置里填写名称、Base URL 和 API 风格。</p> : (
                <>
                  <input aria-label="API Key" type="password" autoComplete="off" placeholder="API Key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitPending(); } }} />
                  <button type="button" disabled={!apiKey.trim()} onClick={commitPending}>保存并使用</button>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
