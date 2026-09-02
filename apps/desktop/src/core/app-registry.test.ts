import assert from "node:assert/strict";
import test from "node:test";

import { assertCapability, BUILT_IN_APPS, validateManifest } from "./app-registry.js";

test("registry accepts declarative built-ins and rejects executable third-party entries", () => {
  const files = validateManifest(BUILT_IN_APPS[0]);
  assert.doesNotThrow(() => assertCapability(files, "workspace.read"));
  assert.throws(() => assertCapability(files, "network.access"));
  assert.throws(() =>
    validateManifest({
      id: "third.party",
      name: "Third party",
      version: "1.0.0",
      entry: "file:///untrusted.js",
      capabilities: [],
      builtIn: false,
    }),
  );
});
