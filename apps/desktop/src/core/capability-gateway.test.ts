import assert from "node:assert/strict";
import test from "node:test";

import { BUILT_IN_APPS } from "./app-registry.js";
import { CapabilityGateway } from "./capability-gateway.js";
import { SystemStore } from "./system-store.js";

test("capability gateway defaults local built-ins safely and requires consent for agents/network", () => {
  const store = new SystemStore(":memory:");
  for (const app of BUILT_IN_APPS) store.upsertApp(app);
  const gateway = new CapabilityGateway(store);

  assert.equal(gateway.authorize("system.files", "workspace.read").id, "system.files");
  assert.throws(() => gateway.authorize("system.research", "agent.invoke"), /explicit/);
  gateway.decide("system.research", "agent.invoke", "allow");
  assert.equal(gateway.authorize("system.research", "agent.invoke").id, "system.research");
  gateway.decide("system.research", "agent.invoke", "deny");
  assert.throws(() => gateway.authorize("system.research", "agent.invoke"), /denied/);
  store.close();
});
