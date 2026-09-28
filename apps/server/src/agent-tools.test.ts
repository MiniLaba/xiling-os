import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeService } from "@xiling/knowledge";
import { FileLiteratureCache, LiteratureSearchService, OpenAlexProvider, SemanticScholarProvider } from "@xiling/literature";
import { ScienceDomainRegistry } from "@xiling/science-domains";
import { OCEAN_CLIMATE_DOMAIN } from "@xiling/domain-ocean";
import { agentEntryReaderTool, agentHistorySearchTool, researchCapabilityCatalog, researchCapabilityCatalogFor, selectResearchCapabilities, selectResearchTools } from "./agent-tools.js";

describe("project-scoped Pi research tools", () => {
  it("activates only capabilities matched by the current prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "xiling-agent-tools-"));
    const knowledge = new KnowledgeService(join(root, "knowledge.sqlite"));
    const project = knowledge.createProject({ name: "海洋领域测试", description: "fixture", researchQuestion: "层结如何变化？", domainIds: ["ocean-climate"] });
    const fixtureFetch: typeof fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const literature = new LiteratureSearchService(new SemanticScholarProvider(fixtureFetch), new OpenAlexProvider(fixtureFetch), new FileLiteratureCache(join(root, "cache")));
    const services = {
      project,
      knowledge,
      literature,
      readArtifact: async (uri: string, offsetBytes: number, maxBytes: number) => ({ uri, offsetBytes, text: "fixture".slice(0, maxBytes), truncated: false }),
      readAgentEntry: async (entryId: string, offsetChars: number, maxChars: number) => ({ entryId, offsetChars, text: "durable-full-text".slice(offsetChars, offsetChars + maxChars), truncated: false }),
      searchAgentHistory: async (query: string, limit: number) => [{ entryId: "entry-1", kind: "assistant", excerpt: query, createdAt: String(limit) }],
    };
    const domains = new ScienceDomainRegistry(); domains.register(OCEAN_CLIMATE_DOMAIN);
    const oceanCatalog = researchCapabilityCatalogFor(domains.resolve(["ocean-climate"]).capabilities);

    expect(selectResearchTools("总结当前项目", services).map((tool) => tool.name)).toEqual(["read_project_context"]);
    expect(selectResearchTools("检索 Argo 海洋热浪论文并规划 NetCDF 切片", services, oceanCatalog).map((tool) => tool.name)).toEqual(["read_project_context", "search_literature", "plan_ocean_data_subset"]);
    expect(selectResearchTools("阅读 Wiki 里的已有结论", services).map((tool) => tool.name)).toEqual(["read_project_context", "read_project_wiki"]);
    expect(selectResearchTools("梳理北极内波研究现状与研究空白", services).map((tool) => tool.name)).toEqual(["read_project_context", "search_literature"]);
    expect(selectResearchTools("概括当前项目", services).map((tool) => tool.name)).toEqual(["read_project_context"]);
    const query = "检索 Argo 论文并规划 NetCDF 切片";
    expect(selectResearchCapabilities(query, oceanCatalog).map((capability) => capability.toolName)).toEqual(selectResearchTools(query, services, oceanCatalog).map((tool) => tool.name));
    expect(selectResearchCapabilities(query).map((capability) => capability.id)).not.toContain("ocean.subset.plan");
    expect(new Set(researchCapabilityCatalog.map((capability) => capability.toolName)).size).toBe(researchCapabilityCatalog.length);
    expect(selectResearchTools("分别检索三个数据库，并请独立审稿人复核", services).map((tool) => tool.name)).not.toContain("delegate_research_tasks");
    const artifact = selectResearchTools("检查 Artifact 审阅报告", services).find((tool) => tool.name === "read_artifact_excerpt")!;
    await expect(artifact.execute("call-1", { uri: `artifact://sha256/${"a".repeat(64)}`, offsetBytes: 0, maxBytes: 500 }, undefined, undefined)).resolves.toMatchObject({ details: { text: "fixture" } });
    await expect(agentHistorySearchTool(services).execute("call-2", { query: "旧决策", limit: 3 }, undefined, undefined)).resolves.toMatchObject({ details: [{ entryId: "entry-1", excerpt: "旧决策" }] });
    await expect(agentEntryReaderTool(services).execute("call-3", { entryId: "entry-1", offsetChars: 0, maxChars: 500 }, undefined, undefined)).resolves.toMatchObject({ details: { text: "durable-full-text" } });
    knowledge.close();
  });
});
