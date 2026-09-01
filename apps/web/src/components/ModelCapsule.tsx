import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelCatalogEntry, ModelProviderId } from "@xiling/contracts";

export type CapsuleReasoning = "off" | "low" | "medium" | "high";
export interface CapsuleRoute { providerId: ModelProviderId; modelId: string; reasoning: CapsuleReasoning }

const reasoningLabel: Record<CapsuleReasoning, string> = { off: "关", low: "低", medium: "中", high: "高" };

interface Props {
  /** undefined 表示继承主模型（仅 allowInherit 时可用）。 */
  value: CapsuleRoute | undefined;
  allowInherit?: boolean;
  catalog: ModelCatalogEntry[];
  configuredProviders: Array<{ id: ModelProviderId; title: string }>;
  disabled?: boolean;
  compact?: boolean;
  inheritLabel?: string;
  /** disabled 时的提示文案。 */
  disabledHint?: string;
  onCommit: (route: CapsuleRoute | null) => void;
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
  const [reasoning, setReasoning] = useState<CapsuleReasoning>("medium");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => { setReasoning(value?.reasoning ?? "medium"); }, [open, value?.reasoning]);

  const groups = useMemo(
    () => configuredProviders
      .map((provider) => ({ provider, models: catalog.filter((model) => model.providerId === provider.id) }))
      .filter((group) => group.models.length),
    [catalog, configuredProviders],
  );

  const label = value
    ? catalog.find((model) => model.providerId === value.providerId && model.id === value.modelId)?.name ?? value.modelId
    : allowInherit ? "继承主模型" : "选择模型";

  const commit = (route: CapsuleRoute | null) => { setOpen(false); setCustomOpen(false); setCustomModelId(""); onCommit(route); };
  const pick = (providerId: ModelProviderId, modelId: string) => commit({ providerId, modelId, reasoning });
  const commitCustom = () => {
    const modelId = customModelId.trim();
    if (!customProvider || !modelId) return;
    commit({ providerId: customProvider, modelId, reasoning });
  };

  return (
    <div className={`xl-model-capsule ${compact ? "compact" : ""}`} ref={rootRef}>
      <button
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
            <button role="option" aria-selected={!value} className={!value ? "current" : ""} onClick={() => commit(null)}>
              <em>{inheritLabel}</em>
              {!value ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ) : null}
          {groups.map((group) => (
            <section key={group.provider.id}>
              <small>{group.provider.title}</small>
              {group.models.map((model) => {
                const current = value?.providerId === model.providerId && value?.modelId === model.id;
                return (
                  <button key={`${model.providerId}:${model.id}`} role="option" aria-selected={current} className={current ? "current" : ""} onClick={() => pick(model.providerId, model.id)}>
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
              <button key={level} role="radio" aria-checked={reasoning === level} className={reasoning === level ? "active" : ""} onClick={() => setReasoning(level)}>{reasoningLabel[level]}</button>
            ))}
          </div>
          {customOpen ? (
            <div className="xl-model-capsule-custom">
              <select aria-label="自定义模型提供商" value={customProvider ?? ""} onChange={(event) => setCustomProvider(event.target.value as ModelProviderId)}>
                <option value="">提供商</option>
                {configuredProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.title}</option>)}
              </select>
              <input aria-label="自定义模型 ID" placeholder="模型 ID" value={customModelId} onChange={(event) => setCustomModelId(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitCustom(); } }} />
              <button disabled={!customProvider || !customModelId.trim()} onClick={commitCustom}>确定</button>
            </div>
          ) : (
            <button className="xl-model-capsule-custom-entry" onClick={() => setCustomOpen(true)}>自定义模型 ID…</button>
          )}
        </div>
      ) : null}
    </div>
  );
}
