import test from "node:test";
import assert from "node:assert/strict";
import type { AgentPluginManifest } from "@xiling/os-domain";
import { CordisPluginLifecycleHost } from "./cordis-plugin-host.js";

const manifest: AgentPluginManifest = {
  id: "fixture",
  version: "1.0.0",
  runtime: { entry: "verified://fixture" },
  provides: [],
};

test("Cordis 生命周期桥：prepare 不执行代码，activate/deactivate 清理 Fiber", async () => {
  let loads = 0;
  let activations = 0;
  let cleanups = 0;
  const host = new CordisPluginLifecycleHost(async () => {
    loads += 1;
    return {
      plugin: () => {
        activations += 1;
        return () => { cleanups += 1; };
      },
    };
  });
  await host.prepare(manifest);
  assert.equal(loads, 1);
  assert.equal(activations, 0);
  await host.activate(manifest);
  assert.equal(host.isActive(manifest.id), true);
  assert.equal(activations, 1);
  await host.deactivate(manifest.id);
  assert.equal(host.isActive(manifest.id), false);
  assert.equal(cleanups, 1);
  await host.shutdown();
});
