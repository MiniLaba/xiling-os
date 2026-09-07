import test from "node:test";
import assert from "node:assert/strict";
import { harnessCredentials } from "./harness-credentials.js";

test("only selected credential is forwarded; refresh reads current store; errors redact it", () => {
  let key = "test-secret-one";
  const read = (id: string) => { assert.equal(id, "deepseek"); return key; };
  const parent = { Path: "C:\\工具", HOME: "/home/user", OPENAI_API_KEY: "other", NASA_TOKEN: "private", NODE_OPTIONS: "--inspect" };
  const first = harnessCredentials("deepseek-official", read, parent);
  assert.deepEqual(first.env, { Path: parent.Path, HOME: parent.HOME, DEEPSEEK_API_KEY: key });
  assert.equal(first.redactError(`error ${key}`), "error [REDACTED]");
  key = "test-secret-two";
  assert.equal(harnessCredentials("deepseek", read, parent).env.DEEPSEEK_API_KEY, key);
  assert.equal(parent.OPENAI_API_KEY, "other");
  assert.throws(() => harnessCredentials("unknown", read, parent), /不支持/);
  assert.throws(() => harnessCredentials("deepseek", () => undefined, parent), /API Key/);
});

test("custom endpoint uses stored protocol and optional local key without exposing it in profile", () => {
  const fields: Record<string, string> = { baseUrl: "http://127.0.0.1:8080/v1", apiStyle: "openai-completions", apiKey: "local-secret" };
  const read = (_provider: string, field = "apiKey") => fields[field];
  const custom = harnessCredentials("custom", read, {});
  assert.deepEqual(custom.profile, { apiKeyEnv: "XILING_CUSTOM_API_KEY", baseURL: fields.baseUrl, api: fields.apiStyle });
  assert.equal(custom.env.XILING_CUSTOM_API_KEY, "local-secret");
  delete fields.apiKey;
  assert.equal(harnessCredentials("custom", read, {}).env.XILING_CUSTOM_API_KEY, "xiling-local");
  fields.baseUrl = "https://name:secret@example.com/v1";
  assert.throws(() => harnessCredentials("custom", read, {}), /凭据/);
});
