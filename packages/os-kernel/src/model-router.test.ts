import test from "node:test";
import assert from "node:assert/strict";
import { ModelRouter } from "./model-router.js";
import { OSKernel } from "./kernel.js";

test("模型路由：精确保留自定义模型名，Worker 策略可独立解析", () => {
  const router = new ModelRouter();
  router.register({
    address: { providerId: "custom-lab", modelId: "ocean/v3-preview" },
    nativeInputs: ["text", "video"], nativeOutputs: ["text"], contextWindowTokens: 128_000,
    reasoning: true, supportsToolUse: true, source: "native-probe", verifiedAt: "2026-09-04T00:00:00.000Z",
  });
  const route = router.resolve(
    { preferred: { providerId: "custom-lab", modelId: "ocean/v3-preview" } },
    { nativeInputs: ["text", "video"], nativeOutputs: ["text"], reasoning: true },
  );
  assert.deepEqual(route.address, { providerId: "custom-lab", modelId: "ocean/v3-preview" });
  assert.equal(route.capabilities.contextWindowTokens, 128_000);
  assert.equal(route.reason, "agent-preference");
});

test("模型路由：不支持的原生视频输入直接拒绝，不做非原生降级", () => {
  const router = new ModelRouter();
  router.register({
    address: { providerId: "vendor", modelId: "text-only" },
    nativeInputs: ["text"], nativeOutputs: ["text"], contextWindowTokens: 32_000, source: "provider-catalog",
  });
  assert.throws(
    () => router.resolve(
      { preferred: { providerId: "vendor", modelId: "text-only" }, allowedProviders: ["vendor"] },
      { nativeInputs: ["text", "video"] },
    ),
    /不原生支持输入 video/,
  );
});

test("模型路由：不支持的图像输出直接拒绝", () => {
  const router = new ModelRouter();
  router.register({
    address: { providerId: "vendor", modelId: "text-only" },
    nativeInputs: ["text", "image"], nativeOutputs: ["text"], contextWindowTokens: 32_000, source: "provider-catalog",
  });
  assert.throws(
    () => router.resolve(
      { preferred: { providerId: "vendor", modelId: "text-only" }, allowedProviders: ["vendor"] },
      { nativeOutputs: ["image"] },
    ),
    /不原生支持输出 image/,
  );
});

test("模型路由：用户声明不能冒充已经验证的非文本原生能力", () => {
  const router = new ModelRouter();
  router.register({
    address: { providerId: "custom-lab", modelId: "claimed-video" },
    nativeInputs: ["text", "video"], nativeOutputs: ["text", "image"], contextWindowTokens: 64_000,
    source: "user-declared",
  });
  assert.throws(
    () => router.resolve({ preferred: { providerId: "custom-lab", modelId: "claimed-video" } }, { nativeInputs: ["video"] }),
    /只有用户声明，尚无原生能力证据/,
  );
  assert.throws(
    () => router.resolve({ preferred: { providerId: "custom-lab", modelId: "claimed-video" } }, { nativeOutputs: ["image"] }),
    /只有用户声明，尚无原生能力证据/,
  );
});

test("模型目录：能力声明形成可重放事实，使用中的模型不能删除", async () => {
  const kernel = new OSKernel();
  const declaration = {
    address: { providerId: "lab", modelId: "multimodal-v1" },
    nativeInputs: ["text", "image"] as const,
    nativeOutputs: ["text"] as const,
    contextWindowTokens: 64_000,
    source: "user-declared" as const,
  };
  kernel.modelCatalog.register({ ...declaration, nativeInputs: [...declaration.nativeInputs], nativeOutputs: [...declaration.nativeOutputs] });
  const agent = await kernel.agents.create({
    name: "main", runtimeName: "scripted", allowedActions: [], modelPolicy: { preferred: declaration.address },
  });
  assert.equal(kernel.modelCatalog.list().length, 1);
  assert.throws(() => kernel.modelCatalog.remove(declaration.address), /正被 Agent 使用/);

  const replayed = new OSKernel();
  replayed.events.hydrate(kernel.events.all());
  assert.equal(replayed.modelCatalog.get(declaration.address)?.contextWindowTokens, 64_000);
  assert.deepEqual(replayed.agents.get(agent.id).modelPolicy.preferred, declaration.address);
});
