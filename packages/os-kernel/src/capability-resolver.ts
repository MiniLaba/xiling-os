// Capability Resolver：常驻上下文只暴露轻量目录，命中任务后才展开插件工具 schema。
// 这是上下文节省的机制边界，不依赖固定 token 上限，也不让模型看到无关工具。

import type { AgentId, AgentPluginManifest } from "@xiling/os-domain";
import type { KernelServices } from "./kernel-services.js";

export interface CapabilityCatalogEntry {
  pluginId: string;
  version: string;
  summary: string;
  actions: string[];
}

export interface ResolvedCapability extends CapabilityCatalogEntry {
  score: number;
  manifest: AgentPluginManifest;
}

export class CapabilityResolver {
  constructor(private readonly services: KernelServices) {}

  catalogFor(agentId: AgentId): CapabilityCatalogEntry[] {
    const definition = this.services.agents.get(agentId);
    return definition.pluginBindings.flatMap((binding) => {
      if (!this.services.plugins.isEnabled(binding.pluginId)) return [];
      let manifest: AgentPluginManifest;
      try { manifest = this.services.plugins.get(binding.pluginId); } catch { return []; }
      return [{
        pluginId: manifest.id,
        version: manifest.version,
        summary: manifest.provides.map((item) => item.description ?? item.action).join("；"),
        actions: manifest.provides.map((item) => item.action),
      }];
    });
  }

  resolveForTask(agentId: AgentId, goal: string, limit = 4): ResolvedCapability[] {
    const queryTerms = terms(goal);
    if (queryTerms.size === 0) return [];
    return this.catalogFor(agentId)
      .map((entry) => {
        const manifest = this.services.plugins.get(entry.pluginId);
        const haystack = [
          entry.pluginId,
          entry.summary,
          ...entry.actions,
          ...(manifest.tools ?? []).flatMap((tool) => [tool.name, tool.description]),
          ...(manifest.workflows ?? []),
        ].join(" ");
        const candidateTerms = terms(haystack);
        let score = 0;
        for (const term of queryTerms) if (candidateTerms.has(term)) score += term.length > 1 ? 2 : 1;
        return { ...entry, score, manifest };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.pluginId.localeCompare(b.pluginId))
      .slice(0, Math.max(0, limit));
  }
}

function terms(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().normalize("NFKC");
  const output = new Set(normalized.match(/[a-z0-9][a-z0-9._-]{1,}/gu) ?? []);
  const han = [...normalized].filter((character) => /\p{Script=Han}/u.test(character));
  for (let index = 0; index < han.length - 1; index += 1) output.add(`${han[index]}${han[index + 1]}`);
  return output;
}
